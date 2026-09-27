import { execFile } from 'child_process'
import { readdir, readFile, rm, stat } from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { classifyWorktreeIgnored, IGNORED_STATUS_ARGS } from '@tlda/bot'
import { isRendererProcess } from './box-memory.mjs'

const execFileP = promisify(execFile)
const MAIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tlda')
export const DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES = 50 * 1024 ** 3
export const PLAYWRIGHT_SWEEP_TIMEOUT_MS = 120_000
export const PLAYWRIGHT_REAP_TIMEOUT_MS = PLAYWRIGHT_SWEEP_TIMEOUT_MS

// Two minutes. These files are the LOSING half of a copy-then-rename, so a
// blanket delete can catch one that is about to be renamed into place and break
// a live `git`. Anything this old lost its race long ago.
export const DEFAULT_XCRUN_CACHE_MIN_AGE_MS = 2 * 60_000

// The real per-user temp directory, which is NOT `process.env.TMPDIR` here.
//
// dev runs under the fence, which rewrites TMPDIR to `/tmp/tlda-fence-env`. The
// xcrun cache lives in the per-user Darwin temp dir regardless, so a sweep
// written as `find $TMPDIR` inspects an empty directory, deletes nothing, and
// reports success -- the reports-success-while-doing-nothing class that this
// whole incident was made of. `getconf` answers for the user, not the process
// environment, so it is right under the fence and right outside it.
//
// Resolved per sweep rather than at import for the same reason `xcrun --find`
// beats a hardcoded path: it stays correct if the answer changes, and once per
// ten minutes is not a cost.
async function defaultUserTempDir(run) {
  const { stdout } = await run('getconf', ['DARWIN_USER_TEMP_DIR'], { timeout: 10_000, encoding: 'utf8' })
  const resolved = stdout.trim()
  if (!resolved) throw new Error('getconf DARWIN_USER_TEMP_DIR returned nothing')
  return resolved
}

// `/usr/bin/git` is the Xcode shim: every call consults a ~92 MB xcrun cache
// database, written copy-then-rename. Concurrent callers race, and each loser
// leaves its copy behind -- measured at ~44 MiB per git call at concurrency 8,
// ~400 MiB/min with the fleet at full tilt, which is a full volume overnight.
//
// This reclaims the orphans. It does not stop them being made; that is the
// resolve-once change to how the fleet invokes git, which touches agent launch.
export function createXcrunCacheCleanup({
  run = execFileP,
  minAgeMs = DEFAULT_XCRUN_CACHE_MIN_AGE_MS,
  tempDir = () => defaultUserTempDir(run),
  listEntries = readdir,
  readStat = stat,
  removeFile = target => rm(target, { force: true }),
  now = () => Date.now(),
} = {}) {
  async function sweep() {
    const dir = await tempDir()
    const entries = await listEntries(dir)
    // `xcrun_db-` WITH the trailing dash, and the dash is the whole safety
    // margin. The live cache is the file named exactly `xcrun_db`; the orphans
    // are `xcrun_db-<suffix>` copies of it. A `startsWith('xcrun_db')` filter
    // matches the live one too and deletes a ~92 MB database the entire fleet's
    // git calls depend on -- which would then be rebuilt by whichever callers
    // raced next, i.e. this sweep would manufacture the storm it exists to
    // clean. It survives only because its mtime is refreshed constantly; the
    // first quiet spell longer than the age window is when it would go.
    const candidates = entries.filter(name => name.startsWith('xcrun_db-'))
    const cutoff = now() - minAgeMs
    let removed = 0
    let removedBytes = 0
    let retained = 0
    let retainedBytes = 0
    const errors = []
    for (const name of candidates) {
      const target = path.join(dir, name)
      try {
        const metadata = await readStat(target)
        if (!metadata.isFile()) continue
        if (metadata.mtimeMs >= cutoff) {
          // Inside the rename window. Not an error and not a failure to
          // reclaim -- it is the margin that makes this safe to run on a busy
          // box, and it is reported so the total never looks like a shortfall.
          retained += 1
          retainedBytes += metadata.size
          continue
        }
        await removeFile(target)
        removed += 1
        removedBytes += metadata.size
      } catch (error) {
        // A file that vanished between readdir and stat is the normal case on a
        // directory this hot, not a fault.
        if (error?.code === 'ENOENT') continue
        errors.push(`${name}: ${error?.message || 'failed'}`)
      }
    }
    return { dir, removed, removedBytes, retained, retainedBytes, errors }
  }
  return { sweep }
}

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
    const keptForContent = []
    const pinned = []
    const abandoned = []
    const unremovable = []
    // Coverage, because the output looked like coverage and was not. This sweep
    // sends most worktrees past classification on a `continue`, and it logged a
    // line per classified worktree with nothing saying how many it never
    // reached. On 2026-08-18 someone read an hour of its accumulated log lines
    // as a census and reported 173 worktrees vetted as removable; it had
    // examined 21. app-lockup had already measured 401 of 404 never reaching
    // classifyWorktreeIgnored, and the two numbers sat in one thread without
    // being put side by side.
    //
    // A check reports what it observed and names what it did not. Silence about
    // the skipped majority is what let a true count become a false claim.
    const skipped = { dirty: 0, unmergedByAncestry: 0, active: 0, unreadable: 0 }

    for (const worktree of worktrees.filter(entry => entry.path !== main)) {
      if (isActive(worktree)) {
        pinned.push({ ...worktree, reason: 'live-process' })
        skipped.active += 1
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
        skipped.unreadable += 1
        continue
      }
      if ((status.stdout || '').trim()) {
        skipped.dirty += 1
        continue
      }
      try {
        await run('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', worktree.head, 'main'], {
          timeout: 10_000,
          encoding: 'utf8',
        })
      } catch (error) {
        // Exit 1 means "not an ancestor of main". On this repo that is mostly
        // meaningless -- main is assembled by cherry-pick, so a landed change
        // exists as two shas and the author's is never an ancestor. See
        // AGENTS.md "main is assembled by cherry-pick". This is the single
        // biggest reason worktrees never get classified, and it is counted
        // rather than silent so the coverage gap is visible in the result.
        if (error?.code === 1) {
          skipped.unmergedByAncestry += 1
          continue
        }
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
      // The predicate that was missing now exists. Skip, 2026-08-13, on what this
      // sweep is for: "I thought they were supposed to fucking remove node modules
      // and shit", and on it taking `scratch/`: "That's fucked." So ignored build
      // output is reclaimable, ignored authored content is not, and anything
      // nobody has classified counts as authored — the default fails toward
      // keeping, because the cost of being wrong is a file whose only copy lived
      // in the directory AGENTS.md tells agents to write to.
      //
      // Classifying each ignored entry rather than the worktree is what keeps the
      // sweep alive: every worktree has `node_modules`, so "any ignored file
      // protects it" would disable cleanup entirely.
      //
      // REMOVAL STAYS OFF. Landing a predicate and re-enabling removal in one
      // change is how a safe fix becomes a destructive one, and turning it back
      // on is Skip's decision. What changes here is that the log now says which
      // way the predicate went, so the question "would this have taken anything
      // of mine" has an answer before anyone flips it.
      let ignoredStatus = ''
      try {
        const result = await run('git', ['-C', worktree.path, ...IGNORED_STATUS_ARGS], { timeout: 20_000, encoding: 'utf8' })
        ignoredStatus = result.stdout || ''
      } catch (error) {
        // Unreadable ignored state is not permission to delete. Treat it as
        // authored and say so.
        keptForContent.push({ ...worktree, reason: `ignored status unreadable: ${error?.message || error}` })
        console.log(`[worktree-cleanup] KEEP ${worktree.path} — cannot read ignored state, treating as authored`)
        continue
      }
      const verdict = classifyWorktreeIgnored(ignoredStatus)
      if (!verdict.safeToRemove) {
        keptForContent.push({ ...worktree, reason: 'holds authored content', authored: verdict.authored.map(entry => entry.path) })
        console.log(`[worktree-cleanup] KEEP ${worktree.path} branch=${worktree.branch || '(detached)'} — authored content: ${verdict.authored.slice(0, 5).map(entry => entry.path).join(', ')}${verdict.authored.length > 5 ? `, +${verdict.authored.length - 5} more` : ''}`)
        continue
      }
      removable.push({ ...worktree, reason: 'clean per `status --porcelain`, and every ignored entry is build output' })
      console.log(`[worktree-cleanup] WOULD REMOVE ${worktree.path} branch=${worktree.branch || '(detached)'} head=${worktree.head || '?'} — only build output (${verdict.reclaimable.map(entry => entry.path).slice(0, 5).join(', ') || 'nothing ignored'}); removal still disabled`)
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
    // One line per sweep saying what it did NOT look at. Without it the
    // per-worktree lines above are the only output, and a reader counting them
    // is counting the tiny minority that survived four `continue`s.
    const skippedTotal = skipped.dirty + skipped.unmergedByAncestry + skipped.active + skipped.unreadable
    console.log(`[worktree-cleanup] coverage: examined ${removable.length + keptForContent.length} of ${removable.length + keptForContent.length + skippedTotal} — skipped ${skipped.unmergedByAncestry} not-ancestor-of-main, ${skipped.dirty} dirty, ${skipped.active} in use, ${skipped.unreadable} unreadable. Not examined is NOT reclaimable.`)

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
      examined: removable.length + keptForContent.length,
      skipped,
      skippedTotal: skipped.dirty + skipped.unmergedByAncestry + skipped.active + skipped.unreadable,
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

function withinDeadline(promise, timeoutMs, label, onTimeout = () => {}) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${timeoutMs}ms`))
      onTimeout()
    }, timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

async function lastPlaywrightTouch(session, touchDir = path.join(homedir(), '.config', 'tlda', 'pw-touch')) {
  let files
  try {
    files = await readdir(touchDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { known: true, at: null }
    return { known: false, at: null }
  }
  let latest = null
  for (const file of files.filter(name => name.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(path.join(touchDir, file), 'utf8'))
      if (record?.session === session && Number.isFinite(record.ts)) {
        latest = Math.max(latest || 0, record.ts)
      }
    } catch {
      // A corrupt record could belong to this session. Preserve the browser.
      return { known: false, at: null }
    }
  }
  return { known: true, at: latest }
}

export function createPlaywrightPoolCleanup({
  run = execFileP,
  now = () => Date.now(),
  baseSession = process.env.TLDA_PW_BASE_SESSION || 'shared',
  capacity = Math.max(1, parseInt(process.env.TLDA_PW_CAPACITY || '', 10) || 3),
  emptyIdleMs = parseInt(process.env.TLDA_DEV_BOT_PW_EMPTY_MS || '', 10) || 5 * 60_000,
  unhealthyIdleMs = parseInt(process.env.TLDA_DEV_BOT_PW_UNHEALTHY_MS || '', 10) || 5 * 60_000,
  // `playwright-cli list` measured at 11.6s / 13.1s / 15.3s on the Mini — and that
  // is the run that reports "(no browsers)", so it is the command's own floor, not
  // load. The previous 5s could never be met, so every pass errored and this half
  // of the reaper never swept anything.
  queryTimeoutMs = parseInt(process.env.TLDA_DEV_BOT_PW_QUERY_MS || '', 10) || 30_000,
  reapTimeoutMs = PLAYWRIGHT_REAP_TIMEOUT_MS,
  playwrightCli = process.env.PLAYWRIGHT_CLI_BIN || path.join(MAIN_REPO, 'node_modules/.bin/playwright-cli'),
  tldaDev = process.env.TLDA_DEV_BIN || path.join(MAIN_REPO, 'cli/tlda-dev.mjs'),
  readLastTouch = session => lastPlaywrightTouch(session),
} = {}) {
  const emptySince = new Map()
  const unhealthySince = new Map()
  let inventoryInFlight = null

  async function reap(session) {
    const env = { ...process.env, TLDA_PW_SESSION: session }
    try {
      await run(tldaDev, ['pw', 'reap'], {
        timeout: reapTimeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        env,
      })
      return null
    } catch (error) {
      const facts = [
        `timeout=${reapTimeoutMs}ms`,
        `killed=${error?.killed === true}`,
        `signal=${error?.signal || 'none'}`,
        `code=${error?.code ?? 'none'}`,
      ].join(', ')
      return `${error?.message || String(error)} (${facts})`
    }
  }

  function inventory() {
    if (inventoryInFlight) return inventoryInFlight
    const controller = new AbortController()
    const owned = { controller, promise: null }
    owned.promise = Promise.resolve().then(() => run(playwrightCli, ['list'], {
      timeout: queryTimeoutMs,
      encoding: 'utf8',
      cwd: MAIN_REPO,
      signal: controller.signal,
    })).finally(() => {
      if (inventoryInFlight === owned) inventoryInFlight = null
    })
    inventoryInFlight = owned
    return owned
  }

  async function noteUnhealthy(session, error) {
    const observedAt = now()
    if (!unhealthySince.has(session)) unhealthySince.set(session, observedAt)
    const idleMs = observedAt - unhealthySince.get(session)
    if (idleMs < unhealthyIdleMs) {
      return { session, state: 'error', error: error?.message || String(error), idleMs }
    }

    const touch = await readLastTouch(session)
    if (!touch.known || (touch.at !== null && observedAt - touch.at < unhealthyIdleMs)) {
      return {
        session,
        state: 'error',
        error: `${error?.message || String(error)}; local ownership is ${touch.known ? 'recently active' : 'unreadable'}, preserving browser`,
        idleMs,
      }
    }

    const reapError = await reap(session)
    if (reapError) {
      return {
        session,
        state: 'error',
        error: `persistently unhealthy (${error?.message || String(error)}); reap failed: ${reapError}`,
        idleMs,
      }
    }
    unhealthySince.delete(session)
    emptySince.delete(session)
    return { session, state: 'reaped', reason: 'persistently-unhealthy', idleMs }
  }

  async function sweepSession(session, listOutput) {
    const env = { ...process.env, TLDA_PW_SESSION: session }
    if (!sessionIsOpen(listOutput, session)) {
      emptySince.delete(session)
      unhealthySince.delete(session)
      return { session, state: 'down' }
    }

    let tabs
    try {
      // Match tlda-dev's own measured loaded-machine verb budget. Killing this
      // wrapper at 20s turns a slow, healthy sweep into a recurring Dev red.
      await run(tldaDev, ['pw', 'sweep'], { timeout: PLAYWRIGHT_SWEEP_TIMEOUT_MS, encoding: 'utf8', env })
      tabs = await run(playwrightCli, [`-s=${session}`, 'tab-list'], {
        timeout: queryTimeoutMs,
        encoding: 'utf8',
        cwd: MAIN_REPO,
      })
      unhealthySince.delete(session)
    } catch (error) {
      return noteUnhealthy(session, error)
    }
    if (hasClaimedTab(tabs.stdout || '')) {
      emptySince.delete(session)
      return { session, state: 'claimed' }
    }

    const observedAt = now()
    if (!emptySince.has(session)) emptySince.set(session, observedAt)
    const idleMs = observedAt - emptySince.get(session)
    if (idleMs < emptyIdleMs) return { session, state: 'empty', idleMs }

    const reapError = await reap(session)
    if (reapError) throw new Error(`reap failed: ${reapError}`)
    emptySince.delete(session)
    return { session, state: 'reaped', idleMs }
  }

  async function sweep() {
    const results = []
    let listOutput
    try {
      const operation = inventory()
      const list = await withinDeadline(
        operation.promise,
        queryTimeoutMs,
        'Playwright inventory',
        () => operation.controller.abort(),
      )
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
        results.push(await noteUnhealthy(session, error))
      }
    }
    return results
  }

  return { sweep }
}

// The one narrow automated action Skip authorises: reaping a CLIMBING renderer.
// Everything else the box-memory watch finds is report-with-evidence.
//
// The candidate pids come from the climber leg (box-memory.mjs), which trips on
// growth rate. This reaps them only after re-verifying, on a FRESH read, that
// the pid is still the same kind of thing that tripped: a detection snapshot
// is already a sweep old when it is acted on, and pids are reused, so killing
// on the snapshot alone could take an innocent process that inherited the pid.
//
// Verification policy (all must hold, else refuse with a reason):
//  1. the pid exists now;
//  2. its CURRENT command line is still a chromium renderer (--type=renderer).
//     A climbing MAIN browser trips the detector but is refused here: killing
//     it takes the whole pooled browser and every tab with it, which is acting
//     on other agents' walks, not reaping a runaway;
//  3. its CURRENT RSS is still at or above minRssKb. A renderer that already
//     shrank below this is not the emergency the snapshot described — and a
//     reused pid belonging to a small process fails here even if a renderer
//     happened to inherit it.
//
// Killing a renderer crashes its tab (the browser survives); that is the
// intended effect, and the evidence record says exactly what was killed and why.
export const CLIMBER_REAP_MIN_RSS_KB = 256 * 1024

export function createClimberReaper({
  run = execFileP,
  kill = pid => process.kill(pid, 'SIGKILL'),
  now = () => new Date().toISOString(),
  minRssKb = CLIMBER_REAP_MIN_RSS_KB,
} = {}) {
  async function currentState(pid) {
    try {
      const { stdout } = await run('ps', ['-o', 'pid=,rss=,command=', '-p', String(pid)], {
        timeout: 10_000,
        encoding: 'utf8',
      })
      const match = String(stdout || '').match(/^\s*(\d+)\s+(\d+)\s+(.*)$/m)
      if (!match) return { alive: false }
      return { alive: true, pid: Number(match[1]), rssKb: Number(match[2]), command: match[3] }
    } catch (error) {
      // `ps -p` exits nonzero for a dead pid. Gone is gone: not an error.
      return { alive: false }
    }
  }

  async function reapOne(candidate, { dryRun = false } = {}) {
    const at = now()
    const base = { pid: candidate.pid, rssBeforeKb: candidate.rssKb ?? null, at }
    const state = await currentState(candidate.pid)
    if (!state.alive) {
      return { ...base, verified: false, killed: false, reason: 'pid already gone' }
    }
    if (!isRendererProcess(state.command)) {
      return {
        ...base, verified: false, killed: false,
        rssNowKb: state.rssKb, commandNow: state.command,
        reason: 'current command is not a chromium renderer — refusing (pid reused or process changed)',
      }
    }
    if (!(state.rssKb >= minRssKb)) {
      return {
        ...base, verified: false, killed: false,
        rssNowKb: state.rssKb, commandNow: state.command,
        reason: `current RSS ${Math.round(state.rssKb / 1024)}MB is below the ${Math.round(minRssKb / 1024)}MB floor — refusing (shrunk or reused pid)`,
      }
    }
    if (dryRun) {
      return {
        ...base, verified: true, killed: false, dryRun: true,
        rssNowKb: state.rssKb, commandNow: state.command,
        reason: 'verified; dry run, nothing killed',
      }
    }
    try {
      await kill(candidate.pid)
    } catch (error) {
      return {
        ...base, verified: true, killed: false,
        rssNowKb: state.rssKb, commandNow: state.command,
        reason: `kill failed: ${error?.message || String(error)}`,
      }
    }
    return {
      ...base, verified: true, killed: true,
      rssNowKb: state.rssKb, commandNow: state.command,
      reason: 'climbing renderer reaped',
    }
  }

  async function reap(candidates, options = {}) {
    const results = []
    for (const candidate of candidates || []) {
      results.push(await reapOne(candidate, options))
    }
    return results
  }

  return { reap }
}
