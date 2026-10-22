import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CLIMBER_REAP_MIN_RSS_KB, createClimberReaper, createPlaywrightPoolCleanup as createPoolCleanup, createWorktreeCleanup, createXcrunCacheCleanup } from './resource-cleanup.mjs'

function createPlaywrightPoolCleanup(options) {
  const run = options.run || promisify(execFile)
  return createPoolCleanup({
    readLockOwner: async () => ({ known: true, live: false }),
    ...options,
    run: (command, args, config) => command === 'bash' && args[0].endsWith('/bin/pw-lock.sh')
      ? Promise.resolve({ stdout: '' })
      : run(command, args, config),
  })
}

// The two-minute window is the only thing making this safe to run on a busy
// box: these files are the losing half of a copy-then-rename, so deleting one
// that is about to be renamed into place breaks a live `git`.
test('xcrun cache sweep removes orphans past the rename window and spares the rest', async () => {
  const removed = []
  const cleanup = createXcrunCacheCleanup({
    tempDir: async () => '/tmp/fake',
    // `xcrun_db` with no suffix is the LIVE cache the whole fleet's git calls
    // read. It is old and it must survive; deleting it forces a concurrent
    // rebuild, which is how the orphans are made in the first place.
    listEntries: async () => ['xcrun_db-old', 'xcrun_db-inflight', 'xcrun_db', 'unrelated-file'],
    readStat: async target => ({
      isFile: () => true,
      size: 100,
      // The live cache is deliberately as old as the orphan, so only the name
      // filter can spare it. Ageing it would let a wrong filter pass.
      mtimeMs: target.endsWith('inflight') ? 1_000_000 : 0,
    }),
    removeFile: async target => { removed.push(target) },
    now: () => 1_000_000,
    minAgeMs: 120_000,
  })

  const result = await cleanup.sweep()
  assert.deepEqual(removed, ['/tmp/fake/xcrun_db-old'])
  assert.equal(result.removed, 1)
  assert.equal(result.retained, 1)
  assert.deepEqual(result.errors, [])
})

// dev runs under the fence, which rewrites TMPDIR. Reading the environment
// instead of asking `getconf` inspects an empty directory and reports success.
test('xcrun cache sweep resolves its directory rather than reading TMPDIR', async () => {
  const asked = []
  const cleanup = createXcrunCacheCleanup({
    run: async (command, args) => {
      asked.push([command, ...args])
      return { stdout: '/var/folders/xx/T/\n' }
    },
    listEntries: async () => [],
    removeFile: async () => { throw new Error('nothing to remove') },
  })

  const result = await cleanup.sweep()
  assert.deepEqual(asked, [['getconf', 'DARWIN_USER_TEMP_DIR']])
  assert.equal(result.dir, '/var/folders/xx/T/')
})

// A sweep that cannot read its directory has to be loud. Silence here is
// indistinguishable from having nothing to reclaim.
test('xcrun cache sweep reports a per-file failure rather than swallowing it', async () => {
  const cleanup = createXcrunCacheCleanup({
    tempDir: async () => '/tmp/fake',
    listEntries: async () => ['xcrun_db-old'],
    readStat: async () => ({ isFile: () => true, size: 10, mtimeMs: 0 }),
    removeFile: async () => { throw new Error('permission denied') },
    now: () => 1_000_000,
  })

  const result = await cleanup.sweep()
  assert.equal(result.removed, 0)
  assert.deepEqual(result.errors, ['xcrun_db-old: permission denied'])
})

test('keeps a managed session while it has a claimed tab', async () => {
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'disposable',
    capacity: 1,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- disposable:\n  - status: open\n' }
      }
      if (command === 'playwright-cli') {
        return { stdout: '- 0: [pwtab=live-agent](https://example.test/?pwtab=live-agent)\n' }
      }
      return { stdout: 'no stale/error tabs to park\n' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [
    { session: 'disposable', state: 'claimed' },
  ])
  assert.equal(calls.some(call => call.includes('reap')), false)
})

test('reads the global Playwright inventory once per pool sweep', async () => {
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 3,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- shared:\n  - status: open\n- shared-2:\n  - status: open\n- shared-3:\n  - status: open\n' }
      }
      if (command === 'playwright-cli') return { stdout: '- 0: [pwtab=live-agent](https://example.test/?pwtab=live-agent)\n' }
      return { stdout: '' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'claimed' },
    { session: 'shared-2', state: 'claimed' },
    { session: 'shared-3', state: 'claimed' },
  ])
  assert.equal(calls.filter(call => call[0] === 'playwright-cli' && call[1] === 'list').length, 1)
})

test('allows tlda-dev pw sweep its measured loaded-machine budget', async () => {
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 1,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    run: async (command, args, options) => {
      calls.push({ command, args, options })
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- shared:\n  - status: open\n' }
      }
      if (command === 'playwright-cli') return { stdout: '- 0: [pwtab=live-agent](https://example.test/)\n' }
      return { stdout: '' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [{ session: 'shared', state: 'claimed' }])
  const sweep = calls.find(call => call.command === 'tlda-dev' && call.args[1] === 'sweep')
  assert.equal(sweep.options.timeout, 120_000)
})

test('aborts a timed-out inventory and does not overlap a runner that ignores cancellation', async () => {
  let calls = 0
  let aborted = false
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 1,
    queryTimeoutMs: 10,
    playwrightCli: 'playwright-cli',
    run: async (_command, _args, options) => {
      calls += 1
      options.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Promise(() => {})
    },
  })

  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'error', error: 'Playwright inventory did not settle within 10ms' },
  ])
  assert.equal(aborted, true)
  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'error', error: 'Playwright inventory did not settle within 10ms' },
  ])
  assert.equal(calls, 1)
})

test('reaps only after a managed session stays empty for the idle threshold', async t => {
  const disposable = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  t.after(() => {
    try { process.kill(disposable.pid, 'SIGKILL') } catch {}
  })
  let clock = 1_000
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'disposable',
    capacity: 1,
    emptyIdleMs: 10,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    now: () => clock,
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- disposable:\n  - status: open\n' }
      }
      if (command === 'playwright-cli') return { stdout: '- 0: [](about:blank)\n' }
      if (args[1] === 'reap') process.kill(disposable.pid, 'SIGTERM')
      return { stdout: '' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [
    { session: 'disposable', state: 'empty', idleMs: 0 },
  ])
  process.kill(disposable.pid, 0)

  clock += 11
  assert.deepEqual(await cleanup.sweep(), [
    { session: 'disposable', state: 'reaped', idleMs: 11 },
  ])
  await new Promise(resolve => disposable.once('exit', resolve))
  assert.throws(() => process.kill(disposable.pid, 0), { code: 'ESRCH' })
  assert.equal(calls.filter(call => call.includes('reap')).length, 1)
})

test('allows an owned-session reap to finish just beyond the former 20s boundary', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tlda-reap-slow-success-'))
  const fakeCli = path.join(dir, 'fake-cli.mjs')
  await writeFile(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'list') process.stdout.write('- disposable:\\n  - status: open\\n')
else if (args[0] === 'pw' && args[1] === 'reap') setTimeout(() => {}, 20_050)
else if (args[1] === 'tab-list') process.stdout.write('- 0: [](about:blank)\\n')
`)
  await chmod(fakeCli, 0o755)
  t.after(() => rm(dir, { recursive: true, force: true }))

  let clock = 1_000
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'disposable',
    capacity: 1,
    emptyIdleMs: 1,
    playwrightCli: fakeCli,
    tldaDev: fakeCli,
    now: () => clock,
  })

  assert.equal((await cleanup.sweep())[0].state, 'empty')
  clock += 2
  const started = Date.now()
  assert.deepEqual(await cleanup.sweep(), [{ session: 'disposable', state: 'reaped', idleMs: 2 }])
  assert.ok(Date.now() - started >= 20_000)
})

test('kills and reports a genuinely hung owned-session reap', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tlda-reap-timeout-'))
  const fakeCli = path.join(dir, 'fake-cli.mjs')
  await writeFile(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'list') process.stdout.write('- disposable:\\n  - status: open\\n')
else if (args[0] === 'pw' && args[1] === 'reap') setInterval(() => {}, 1000)
else if (args[1] === 'tab-list') process.stdout.write('- 0: [](about:blank)\\n')
`)
  await chmod(fakeCli, 0o755)
  t.after(() => rm(dir, { recursive: true, force: true }))

  let clock = 1_000
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'disposable',
    capacity: 1,
    emptyIdleMs: 1,
    unhealthyIdleMs: 1_000,
    playwrightCli: fakeCli,
    tldaDev: fakeCli,
    reapTimeoutMs: 25,
    now: () => clock,
  })

  assert.equal((await cleanup.sweep())[0].state, 'empty')
  clock += 2
  const [result] = await cleanup.sweep()
  assert.equal(result.state, 'error')
  assert.match(result.error, /reap failed:/)
  assert.match(result.error, /timeout=25ms/)
  assert.match(result.error, /killed=true/)
  assert.match(result.error, /signal=SIGKILL/)
  assert.match(result.error, /code=none/)
})

test('does not reap an already-down managed session', async () => {
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'disposable',
    capacity: 1,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    run: async (command, args) => {
      calls.push([command, ...args])
      return { stdout: '- disposable:\n  - status: closed\n' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [{ session: 'disposable', state: 'down' }])
  assert.equal(calls.some(call => call.includes('reap')), false)
})

test('reaps only the empty session and preserves an unrelated claimed session', async () => {
  let clock = 1_000
  const reaped = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 2,
    emptyIdleMs: 1,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    now: () => clock,
    run: async (command, args, options) => {
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- shared:\n  - status: open\n- shared-2:\n  - status: open\n' }
      }
      if (command === 'playwright-cli') {
        return { stdout: args[0] === '-s=shared-2' ? '- 0: [pwtab=owner](https://example.test/)\n' : '- 0: [](about:blank)\n' }
      }
      if (args[1] === 'reap') reaped.push(options.env.TLDA_PW_SESSION)
      return { stdout: '' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'empty', idleMs: 0 },
    { session: 'shared-2', state: 'claimed' },
  ])
  clock += 2
  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'reaped', idleMs: 2 },
    { session: 'shared-2', state: 'claimed' },
  ])
  assert.deepEqual(reaped, ['shared'])
})

test('reaps a managed browser after its inspection stays unhealthy', async () => {
  let clock = 1_000
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 1,
    unhealthyIdleMs: 10,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    now: () => clock,
    readLastTouch: async () => ({ known: true, at: null }),
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- shared:\n  - status: open\n' }
      }
      if (command === 'tlda-dev' && args[1] === 'sweep') throw new Error('browser inspection timed out')
      return { stdout: '' }
    },
  })

  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'error', error: 'browser inspection timed out', idleMs: 0 },
  ])
  clock += 11
  assert.deepEqual(await cleanup.sweep(), [
    { session: 'shared', state: 'reaped', reason: 'persistently-unhealthy', idleMs: 11 },
  ])
  assert.equal(calls.filter(call => call[0] === 'tlda-dev' && call[2] === 'reap').length, 1)
})

test('does not reap a browser that recovers before the unhealthy threshold', async () => {
  let clock = 1_000
  let failing = true
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 1,
    unhealthyIdleMs: 10,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    now: () => clock,
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- shared:\n  - status: open\n' }
      }
      if (command === 'tlda-dev' && args[1] === 'sweep' && failing) throw new Error('transient')
      if (command === 'playwright-cli') return { stdout: '- 0: [pwtab=live-agent](https://example.test/)\n' }
      return { stdout: '' }
    },
  })

  assert.equal((await cleanup.sweep())[0].state, 'error')
  failing = false
  clock += 5
  assert.deepEqual(await cleanup.sweep(), [{ session: 'shared', state: 'claimed' }])
  clock += 20
  assert.deepEqual(await cleanup.sweep(), [{ session: 'shared', state: 'claimed' }])
  assert.equal(calls.some(call => call[0] === 'tlda-dev' && call[2] === 'reap'), false)
})

test('preserves an uninspectable browser while local ownership is active', async () => {
  let clock = 1_000
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared',
    capacity: 1,
    unhealthyIdleMs: 10,
    playwrightCli: 'playwright-cli',
    tldaDev: 'tlda-dev',
    now: () => clock,
    readLastTouch: async () => ({ known: true, at: clock - 1 }),
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'playwright-cli' && args[0] === 'list') {
        return { stdout: '- shared:\n  - status: open\n' }
      }
      throw new Error('browser inspection timed out')
    },
  })

  assert.equal((await cleanup.sweep())[0].state, 'error')
  clock += 11
  assert.match((await cleanup.sweep())[0].error, /local ownership is recently active/)
  assert.equal(calls.some(call => call[0] === 'tlda-dev' && call[2] === 'reap'), false)
})

test('records merged clean idle worktrees as removable WITHOUT removing them, and evicts oldest idle dependency caches', async () => {
  const removedNodeModules = []
  const calls = []
  const worktrees = [
    { path: '/repo', head: 'main' },
    { path: '/merged', head: 'merged' },
    { path: '/dirty', head: 'dirty' },
    { path: '/abandoned', head: 'abandoned' },
    { path: '/active', head: 'active' },
    { path: '/old', head: 'old' },
    { path: '/recent', head: 'recent' },
  ]
  const cleanup = createWorktreeCleanup({
    repoRoot: '/repo',
    budgetBytes: 2,
    listWorktrees: async () => worktrees,
    listActiveCwds: async () => new Set(['/active/src']),
    readStat: async () => ({ mtimeMs: 1 }),
    measureNodeModules: async entries => entries.map(entry => ({
      ...entry,
      mtimeMs: entry.path === '/old' ? 1 : entry.path === '/active' ? 2 : 3,
      sizeBytes: 2,
    })),
    removeNodeModules: async target => removedNodeModules.push(target),
    run: async (command, args) => {
      calls.push([command, ...args])
      if (args.includes('status')) {
        if (args[1] === '/abandoned') {
          const error = new Error('not a git repository')
          error.stderr = 'fatal: not a git repository\n'
          throw error
        }
        return { stdout: args[1] === '/dirty' ? ' M file\n' : '' }
      }
      if (args.includes('merge-base')) {
        if (args.includes('old') || args.includes('recent')) {
          const error = new Error('not merged')
          error.code = 1
          throw error
        }
        return { stdout: '' }
      }
      return { stdout: '' }
    },
  })

  const result = await cleanup.sweep()
  // `/merged` is still classified removable — that record is the whole point, so
  // we learn the real rate — but the sweep must no longer remove anything. The
  // predicate is blind to ignored files, so removing on it destroyed agents' work
  // in `scratch/`; see the stop-loss note in resource-cleanup.mjs.
  assert.deepEqual(result.removable.map(entry => entry.path), ['/merged'])
  assert.deepEqual(result.removedWorktrees, [])
  assert.equal(calls.some(call => call.includes('worktree') && call.includes('remove')), false)
  // `/merged` is no longer removed, so it stays in the pool and its node_modules
  // is now an eviction candidate like every other retained worktree.
  assert.deepEqual(removedNodeModules, ['/old/node_modules', '/merged/node_modules', '/dirty/node_modules', '/abandoned/node_modules', '/recent/node_modules'])
  assert.equal(calls.some(call => call.includes('/active') && call.includes('status')), false)
  assert.deepEqual(result.pinned.map(entry => entry.path), ['/active'])
  assert.deepEqual(result.abandoned.map(entry => entry.path), ['/abandoned'])
})

// The sweep's output looked like coverage and was not: it logs a line per
// classified worktree and said nothing about the ones it never reached. On
// 2026-08-18 an hour of accumulated log lines was read as a census — 173
// worktrees reported as vetted-removable when 21 had been examined — while
// app-lockup had separately measured 401 of 404 never reaching classification.
// Both numbers were in one thread and nobody put them side by side.
test('the sweep reports what it did not examine', async () => {
  const worktrees = [
    { path: '/main', head: 'h0' },
    { path: '/dirty', head: 'h1' },
    { path: '/unmerged', head: 'h2' },
    { path: '/clean', head: 'h3' },
  ]
  const run = async (cmd, args) => {
    if (args.includes('--porcelain') && args.includes('status')) {
      return { stdout: args.includes('/dirty') || args[1] === '/dirty' ? ' M file.txt\n' : '' }
    }
    if (args.includes('--is-ancestor')) {
      if (args.includes('h2')) { const e = new Error('not ancestor'); e.code = 1; throw e }
      return { stdout: '' }
    }
    if (args.includes('worktree')) {
      return { stdout: worktrees.map(w => `worktree ${w.path}\nHEAD ${w.head}\n`).join('\n') }
    }
    return { stdout: '' }
  }

  const said = []
  const original = console.log
  console.log = message => said.push(String(message))
  let result
  try {
    result = await createWorktreeCleanup({
      repoRoot: '/main',
      run,
      listActiveCwds: async () => new Set(),
      measureNodeModules: async () => [],
    }).sweep()
  } finally {
    console.log = original
  }

  const coverage = said.find(line => line.includes('[worktree-cleanup] coverage:'))
  assert.ok(coverage, `expected a coverage line, got ${JSON.stringify(said)}`)
  assert.match(coverage, /not-ancestor-of-main/)
  assert.match(coverage, /Not examined is NOT reclaimable/)
  assert.equal(result.skipped.dirty, 1)
  assert.equal(result.skipped.unmergedByAncestry, 1)
  assert.equal(result.examined + result.skippedTotal, 3)
})

// ---------------------------------------------------------------------------
// Climber reaper: the one narrow automated action — a climbing renderer.
// ---------------------------------------------------------------------------

const CLIMBER_RENDERER_REAL = '/Users/skip/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Helpers/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/tmp/ud-shared-chrome'
const MAIN_BROWSER = '/Users/skip/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/ud-shared-chrome'

function fakePs(stateByPid) {
  return async (command, args) => {
    assert.equal(command, 'ps')
    const pid = Number(args[args.length - 1])
    const state = stateByPid[pid]
    if (!state) {
      const error = new Error('ps: No such process')
      error.code = 1
      throw error
    }
    return { stdout: `  ${pid}  ${state.rssKb} ${state.command}\n` }
  }
}

test('climber reaper kills a verified climbing renderer and records the evidence', async () => {
  const killed = []
  const reaper = createClimberReaper({
    run: fakePs({ 37007: { rssKb: 4_267 * 1024, command: CLIMBER_RENDERER_REAL } }),
    kill: async pid => { killed.push(pid) },
    now: () => '2026-09-27T05:00:00.000Z',
  })
  const [result] = await reaper.reap([{ pid: 37007, rssKb: 4_000 * 1024 }])
  assert.deepEqual(killed, [37007])
  assert.equal(result.verified, true)
  assert.equal(result.killed, true)
  assert.equal(result.rssNowKb, 4_267 * 1024)
  assert.match(result.reason, /reaped/)
})

test('climber reaper refuses a pid whose command is no longer a renderer', async () => {
  const killed = []
  const reaper = createClimberReaper({
    run: fakePs({ 37007: { rssKb: 4_267 * 1024, command: '/usr/bin/python3 some-innocent-script' } }),
    kill: async pid => { killed.push(pid) },
  })
  const [result] = await reaper.reap([{ pid: 37007, rssKb: 4_000 * 1024 }])
  assert.deepEqual(killed, [])
  assert.equal(result.verified, false)
  assert.match(result.reason, /not a chromium renderer/)
})

test('climber reaper refuses a climbing main browser: alert, never reap', async () => {
  const killed = []
  const reaper = createClimberReaper({
    run: fakePs({ 26270: { rssKb: 4_267 * 1024, command: MAIN_BROWSER } }),
    kill: async pid => { killed.push(pid) },
  })
  const [result] = await reaper.reap([{ pid: 26270, rssKb: 4_000 * 1024 }])
  assert.deepEqual(killed, [])
  assert.equal(result.verified, false)
})

test('climber reaper refuses a renderer that shrank below the floor', async () => {
  const killed = []
  const reaper = createClimberReaper({
    run: fakePs({ 37007: { rssKb: 72 * 1024, command: CLIMBER_RENDERER_REAL } }),
    kill: async pid => { killed.push(pid) },
  })
  const [result] = await reaper.reap([{ pid: 37007, rssKb: 4_000 * 1024 }])
  assert.deepEqual(killed, [])
  assert.equal(result.verified, false)
  assert.match(result.reason, /below the 256MB floor/)
  assert.equal(CLIMBER_REAP_MIN_RSS_KB, 256 * 1024)
})

test('climber reaper treats a dead pid as gone, not as an error', async () => {
  const killed = []
  const reaper = createClimberReaper({
    run: fakePs({}),
    kill: async pid => { killed.push(pid) },
  })
  const [result] = await reaper.reap([{ pid: 37007, rssKb: 4_000 * 1024 }])
  assert.deepEqual(killed, [])
  assert.equal(result.reason, 'pid already gone')
})

test('climber reaper dry-run verifies without killing', async () => {
  const killed = []
  const reaper = createClimberReaper({
    run: fakePs({ 37007: { rssKb: 4_267 * 1024, command: CLIMBER_RENDERER_REAL } }),
    kill: async pid => { killed.push(pid) },
  })
  const [result] = await reaper.reap([{ pid: 37007, rssKb: 4_000 * 1024 }], { dryRun: true })
  assert.deepEqual(killed, [])
  assert.equal(result.verified, true)
  assert.equal(result.killed, false)
  assert.equal(result.dryRun, true)
})
