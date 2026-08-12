import { execFile } from 'child_process'
import { rm, stat } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { fileURLToPath } from 'url'

const execFileP = promisify(execFile)
const MAIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tlda')
export const DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES = 50 * 1024 ** 3

function containsPath(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function parseWorktrees(output) {
  return output.trim().split(/\n\n+/).map(block => {
    const fields = Object.fromEntries(block.split('\n').map(line => {
      const space = line.indexOf(' ')
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)]
    }))
    return {
      path: path.resolve(fields.worktree),
      head: fields.HEAD || null,
      branch: typeof fields.branch === 'string' ? fields.branch.replace(/^refs\/heads\//, '') : null,
    }
  }).filter(entry => entry.path)
}

async function defaultWorktrees(run, repoRoot) {
  const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    timeout: 10_000,
    encoding: 'utf8',
  })
  return parseWorktrees(stdout)
}

async function defaultActiveCwds(run) {
  const { stdout } = await run('lsof', ['-a', '-d', 'cwd', '-Fn'], {
    timeout: 10_000,
    encoding: 'utf8',
  })
  return new Set(stdout.split('\n').filter(line => line.startsWith('n/')).map(line => path.resolve(line.slice(1))))
}

async function sizeNodeModules(run, entries) {
  if (!entries.length) return []
  const { stdout } = await run('du', ['-sk', ...entries.map(entry => entry.nodeModules)], {
    timeout: 10 * 60_000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  const sizes = new Map(stdout.trim().split('\n').map(line => {
    const match = line.match(/^(\d+)\s+(.+)$/)
    return match ? [path.resolve(match[2]), Number(match[1]) * 1024] : null
  }).filter(Boolean))
  return entries.map(entry => ({ ...entry, sizeBytes: sizes.get(entry.nodeModules) || 0 }))
}

export function createWorktreeCleanup({
  run = execFileP,
  repoRoot = MAIN_REPO,
  budgetBytes = DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES,
  removeNodeModules = target => rm(target, { recursive: true, force: true }),
  listWorktrees = () => defaultWorktrees(run, repoRoot),
  listActiveCwds = () => defaultActiveCwds(run),
  measureNodeModules = entries => sizeNodeModules(run, entries),
  readStat = stat,
} = {}) {
  async function sweep() {
    const worktrees = await listWorktrees()
    const main = path.resolve(repoRoot)
    const activeCwds = await listActiveCwds()
    const isActive = worktree => [...activeCwds].some(cwd => containsPath(worktree.path, cwd))
    const removedWorktrees = []
    const removable = []
    const pinned = []
    const abandoned = []
    const unremovable = []

    for (const worktree of worktrees.filter(entry => entry.path !== main)) {
      if (isActive(worktree)) {
        pinned.push({ ...worktree, reason: 'live-process' })
        continue
      }
      let status
      try {
        status = await run('git', ['-C', worktree.path, 'status', '--porcelain'], {
          timeout: 10_000,
          encoding: 'utf8',
        })
      } catch (error) {
        abandoned.push({ ...worktree, error: error?.stderr?.trim() || error?.message || String(error) })
        continue
      }
      if ((status.stdout || '').trim()) continue
      try {
        await run('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', worktree.head, 'main'], {
          timeout: 10_000,
          encoding: 'utf8',
        })
      } catch (error) {
        if (error?.code === 1) continue
        throw error
      }
      // STOP-LOSS: classify, record, and do NOT remove.
      //
      // `git status --porcelain` is blind to ignored files, and `git worktree
      // remove` does not count them as a reason to refuse. So a worktree holding
      // only `scratch/plan.md` reads clean here and was deleted along with the
      // file — and AGENTS.md tells every agent to put plans and reports in
      // exactly that directory. A branch with no commits passes the merged check
      // too, because its head is still the base commit. Measured: of five test
      // worktrees, the one containing only a gitignored plan was removed and the
      // plan was gone; modified-tracked and untracked-source worktrees survived.
      //
      // Removal is off until the predicate can tell ignored BUILD CACHE (which is
      // reclaimable) from ignored AGENT CONTENT (which is someone's work). That is
      // a product question about what this sweep is for, and it is Skip's.
      //
      // Recording the decision is the point: the old path logged only failures, so
      // there was no record of what it took and the question could not be answered
      // afterwards. Everything else this sweep does — node_modules eviction, the pw
      // pool, preview reaping — is untouched.
      removable.push({ ...worktree, reason: 'clean per `status --porcelain` (ignored files invisible) and head is an ancestor of main' })
      console.log(`[worktree-cleanup] WOULD REMOVE ${worktree.path} branch=${worktree.branch || '(detached)'} head=${worktree.head || '?'} — removal disabled pending predicate`)
    }

    const remaining = worktrees.filter(worktree =>
      worktree.path !== main && !removedWorktrees.some(removed => removed.path === worktree.path))
    const withNodeModules = []
    for (const worktree of remaining) {
      const nodeModules = path.join(worktree.path, 'node_modules')
      try {
        const metadata = await readStat(nodeModules)
        withNodeModules.push({ ...worktree, nodeModules, mtimeMs: metadata.mtimeMs })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const measured = await measureNodeModules(withNodeModules)
    const totalBytes = measured.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    let retainedBytes = totalBytes
    const evicted = []
    for (const entry of measured.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (retainedBytes <= budgetBytes) break
      if (isActive(entry)) continue
      await removeNodeModules(entry.nodeModules)
      retainedBytes -= entry.sizeBytes
      evicted.push(entry)
    }
    return {
      budgetBytes,
      totalBytes,
      retainedBytes,
      overBudgetBytes: Math.max(0, retainedBytes - budgetBytes),
      evicted,
      pinned,
      abandoned,
      unremovable,
      removedWorktrees,
      removable,
    }
  }
  return { sweep }
}

function poolSessions(base, capacity) {
  return Array.from({ length: capacity }, (_, index) =>
    index === 0 ? base : `${base}-${index + 1}`)
}

function sessionIsOpen(output, session) {
  const escaped = session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`- ${escaped}:\\s*\\n\\s*- status: open\\b`, 'm').test(output)
}

function hasClaimedTab(output) {
  return /pwtab=[a-zA-Z0-9_.-]+/.test(output)
}

export function createPlaywrightPoolCleanup({
  run = execFileP,
  now = () => Date.now(),
  baseSession = process.env.TLDA_PW_BASE_SESSION || 'shared',
  capacity = Math.max(1, parseInt(process.env.TLDA_PW_CAPACITY || '', 10) || 3),
  emptyIdleMs = parseInt(process.env.TLDA_DEV_BOT_PW_EMPTY_MS || '', 10) || 5 * 60_000,
  // `playwright-cli list` measured at 11.6s / 13.1s / 15.3s on the Mini — and that
  // is the run that reports "(no browsers)", so it is the command's own floor, not
  // load. The previous 5s could never be met, so every pass errored and this half
  // of the reaper never swept anything.
  queryTimeoutMs = parseInt(process.env.TLDA_DEV_BOT_PW_QUERY_MS || '', 10) || 30_000,
  playwrightCli = process.env.PLAYWRIGHT_CLI_BIN || path.join(MAIN_REPO, 'node_modules/.bin/playwright-cli'),
  tldaDev = process.env.TLDA_DEV_BIN || path.join(MAIN_REPO, 'cli/tlda-dev.mjs'),
} = {}) {
  const emptySince = new Map()

  async function sweepSession(session, listOutput) {
    const env = { ...process.env, TLDA_PW_SESSION: session }
    if (!sessionIsOpen(listOutput, session)) {
      emptySince.delete(session)
      return { session, state: 'down' }
    }

    await run(tldaDev, ['pw', 'sweep'], { timeout: 20_000, encoding: 'utf8', env })
    const tabs = await run(playwrightCli, [`-s=${session}`, 'tab-list'], {
      timeout: queryTimeoutMs,
      encoding: 'utf8',
      cwd: MAIN_REPO,
    })
    if (hasClaimedTab(tabs.stdout || '')) {
      emptySince.delete(session)
      return { session, state: 'claimed' }
    }

    const observedAt = now()
    if (!emptySince.has(session)) emptySince.set(session, observedAt)
    const idleMs = observedAt - emptySince.get(session)
    if (idleMs < emptyIdleMs) return { session, state: 'empty', idleMs }

    await run(tldaDev, ['pw', 'reap'], { timeout: 20_000, encoding: 'utf8', env })
    emptySince.delete(session)
    return { session, state: 'reaped', idleMs }
  }

  async function sweep() {
    const results = []
    let listOutput
    try {
      const list = await run(playwrightCli, ['list'], {
        timeout: queryTimeoutMs,
        encoding: 'utf8',
        cwd: MAIN_REPO,
      })
      listOutput = list.stdout || ''
    } catch (error) {
      return poolSessions(baseSession, capacity).map(session => ({
        session,
        state: 'error',
        error: error?.message || String(error),
      }))
    }
    for (const session of poolSessions(baseSession, capacity)) {
      try {
        results.push(await sweepSession(session, listOutput))
      } catch (error) {
        results.push({ session, state: 'error', error: error?.message || String(error) })
      }
    }
    return results
  }

  return { sweep }
}
