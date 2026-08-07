import assert from 'node:assert/strict'
import test from 'node:test'

import { runLinkedRemoteProbe } from './linked-remote-probe.mjs'

test('linked remote probe rejects a divergent edit that advances accepted authority', async () => {
  const calls = []
  const driver = {
    establish: async () => ({ baseRevision: 'base' }),
    proveRemoteToTlda: async () => calls.push('remote-to-tlda'),
    proveTldaToRemote: async () => calls.push('tlda-to-remote'),
    createDivergence: async () => ({ acceptedRevision: 'base', remoteHead: 'remote-a' }),
    observeDivergence: async () => ({
      acceptedRevision: 'browser-b',
      remoteHead: 'browser-b',
      conflictVisible: false,
    }),
    proveRestartConvergence: async () => calls.push('restart'),
  }

  await assert.rejects(
    runLinkedRemoteProbe({ driver }),
    /divergent edits changed accepted authority/,
  )
  assert.deepEqual(calls, ['remote-to-tlda', 'tlda-to-remote'])
})

test('routine linked remote probe proves both directions and conflict safety without restarting', async () => {
  const calls = []
  const driver = {
    establish: async () => ({ baseRevision: 'base' }),
    proveRemoteToTlda: async () => calls.push('remote-to-tlda'),
    proveTldaToRemote: async () => calls.push('tlda-to-remote'),
    createDivergence: async () => ({ acceptedRevision: 'base', remoteHead: 'remote-a' }),
    observeDivergence: async () => ({
      acceptedRevision: 'base',
      remoteHead: 'remote-a',
      conflictVisible: true,
    }),
    proveRestartConvergence: async () => calls.push('restart'),
  }

  const result = await runLinkedRemoteProbe({ driver })
  assert.deepEqual(calls, ['remote-to-tlda', 'tlda-to-remote'])
  assert.equal(result.ok, true)
  assert.equal(result.restartChecked, false)
})

test('restart convergence is an explicit acceptance check', async () => {
  const calls = []
  const driver = {
    establish: async () => ({ baseRevision: 'base' }),
    proveRemoteToTlda: async () => calls.push('remote-to-tlda'),
    proveTldaToRemote: async () => calls.push('tlda-to-remote'),
    createDivergence: async () => ({ acceptedRevision: 'base', remoteHead: 'remote-a' }),
    observeDivergence: async () => ({ acceptedRevision: 'base', remoteHead: 'remote-a', conflictVisible: true }),
    proveRestartConvergence: async () => calls.push('restart'),
  }

  const result = await runLinkedRemoteProbe({ driver, includeRestart: true })
  assert.deepEqual(calls, ['remote-to-tlda', 'tlda-to-remote', 'restart'])
  assert.equal(result.restartChecked, true)
})
