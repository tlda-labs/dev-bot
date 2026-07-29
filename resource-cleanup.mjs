import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { fileURLToPath } from 'url'

const execFileP = promisify(execFile)
const MAIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tlda')

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
  playwrightCli = process.env.PLAYWRIGHT_CLI_BIN || path.join(MAIN_REPO, 'node_modules/.bin/playwright-cli'),
  tldaDev = process.env.TLDA_DEV_BIN || path.join(MAIN_REPO, 'cli/tlda-dev.mjs'),
} = {}) {
  const emptySince = new Map()

  async function sweepSession(session) {
    const env = { ...process.env, TLDA_PW_SESSION: session }
    const list = await run(playwrightCli, ['list'], {
      timeout: 5000,
      encoding: 'utf8',
      cwd: MAIN_REPO,
    })
    if (!sessionIsOpen(list.stdout || '', session)) {
      emptySince.delete(session)
      return { session, state: 'down' }
    }

    await run(tldaDev, ['pw', 'sweep'], { timeout: 20_000, encoding: 'utf8', env })
    const tabs = await run(playwrightCli, [`-s=${session}`, 'tab-list'], {
      timeout: 5000,
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
    for (const session of poolSessions(baseSession, capacity)) {
      try {
        results.push(await sweepSession(session))
      } catch (error) {
        results.push({ session, state: 'error', error: error?.message || String(error) })
      }
    }
    return results
  }

  return { sweep }
}
