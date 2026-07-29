import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { createPlaywrightPoolCleanup } from './resource-cleanup.mjs'

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
