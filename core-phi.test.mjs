import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const { checkSpawnWakeSeat } = await import('./dev-bot.mjs')

test('core phi probe crosses hibernate and wake before observing delegated inbox delivery', async () => {
  const calls = []
  let readyCount = 0
  let inboxCount = 0
  let cleaned = null
  const request = async message => {
    calls.push(message.type)
    switch (message.type) {
      case 'spawn': return { ok: true, status: 'pending', agent_id: 'fleet:probe', mailbox_id: 'mailbox:1' }
      case 'check-alive': return { state: 'alive' }
      case 'send-text': return { ok: true }
      case 'capture-pane': return { content: message.type === 'capture-pane' ? 'dev-terminal-probe:uuid-2' : '' }
      case 'my-task':
        inboxCount++
        return inboxCount === 1
          ? { messages: [] }
          : { task: { id: 'task:1' }, messages: [{ task_id: 'task:1', text: 'dev-wake-probe:uuid-3' }] }
      case 'hibernate-session': return { ok: true }
      case 'delegate': return { ok: true, task_id: 'task:1', trace_id: 'trace:1' }
      default: throw new Error(`unexpected request ${message.type}`)
    }
  }

  const result = await checkSpawnWakeSeat({
    force: true,
    now: () => 1_000,
    uuid: (() => {
      let n = 0
      return () => `uuid-${++n}`
    })(),
    request,
    waitReady: async () => ({ seat: { session_id: `session:${++readyCount}`, daemon_key: 'daemon:1', terminal_capability: 'term:1' } }),
    waitTrace: async (_traceId, predicate) => {
      const event = { operation: 'wake.respawn', status: 'sent' }
      assert.equal(predicate(event), true)
      return { event }
    },
    cleanup: async value => { cleaned = value },
  })

  assert.deepEqual(calls, [
    'spawn',
    'check-alive',
    'send-text',
    'capture-pane',
    'my-task',
    'hibernate-session',
    'delegate',
    'check-alive',
    'my-task',
  ])
  assert.equal(result.hibernated, true)
  assert.equal(result.wake, 'sent')
  assert.equal(result.resumedSeat.sessionId, 'session:2')
  assert.deepEqual(cleaned, { agentId: 'fleet:probe', taskId: 'task:1' })
})

test('core phi probe always cleans up and reports the failed boundary', async () => {
  let cleaned = null
  await assert.rejects(
    checkSpawnWakeSeat({
      force: true,
      now: () => 2_000,
      uuid: () => 'uuid',
      request: async message => {
        if (message.type === 'spawn') return { ok: true, status: 'pending', agent_id: 'fleet:probe', mailbox_id: 'mailbox:1' }
        if (message.type === 'check-alive') return { state: 'alive' }
        if (message.type === 'send-text') return { ok: true }
        if (message.type === 'capture-pane') return { content: 'dev-terminal-probe:uuid' }
        if (message.type === 'my-task') return {}
        if (message.type === 'hibernate-session') return { ok: false }
        throw new Error(`unexpected request ${message.type}`)
      },
      waitReady: async () => ({ seat: { session_id: 'session:1', daemon_key: 'daemon:1', terminal_capability: 'term:1' } }),
      cleanup: async value => { cleaned = value },
    }),
    /hibernate did not confirm session shutdown/,
  )
  assert.deepEqual(cleaned, { agentId: 'fleet:probe', taskId: null })
})
