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

test('linked remote probe proves both directions, conflict safety, then restart convergence', async () => {
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
  assert.deepEqual(calls, ['remote-to-tlda', 'tlda-to-remote', 'restart'])
  assert.equal(result.ok, true)
})
