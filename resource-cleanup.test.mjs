import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { createPlaywrightPoolCleanup, createWorktreeCleanup } from './resource-cleanup.mjs'

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
