import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const { runAgentReceiving } = await import('./dev-bot.mjs')

const HOUR = 3_600_000
const LEAD = 'fleet:lead'

// One awake agent holding one chat from a non-bot sender, sent `ageMs` ago,
// with `unread` unread messages in its inbox and nothing produced since.
function fakeFleet({ agent, ageMs, unread }) {
  const calls = []
  const deliveredAt = new Date(Date.now() - ageMs).toISOString()
  return {
    calls,
    deliveredAt,
    rosterRows: async filter => (filter === 'awake' ? [agent] : []),
    request: async message => {
      calls.push(message)
      if (message.type === 'unread-count') return { agent: message.agent, count: unread }
      if (message.type === 'fleet-search' && message.eventType === 'chat') {
        return { results: [{ source: 'fleet', id: 7, type: 'chat', from: LEAD, recipients: [agent.id], timestamp: deliveredAt, text: 'please look' }] }
      }
      if (message.type === 'fleet-search' && message.role === 'assistant') return { results: [] }
      throw new Error(`unexpected request ${JSON.stringify(message)}`)
    },
  }
}

// What the alert for claude-cloud-pm saw: a daemonless seat, so no ledger row
// anywhere and no tmux session on this machine.
const noDaemonAnywhere = {
  daemonCanPlace: () => false,
  daemonKnowsAnywhere: () => false,
  hasLocalSession: () => false,
}

function cloudAgent() {
  return {
    id: 'fleet:cloud-pm',
    name: 'claude-cloud-pm',
    labels: [],
    status: 'awake',
    activity_at: new Date(Date.now() - 9 * HOUR).toISOString(),
    last_seen_ago_s: 120,
    runtime_status: { status: 'awake', evidence: { liveness: 'alive', liveness_source: 'cloud-mcp-connected' } },
  }
}

function localAgent() {
  return {
    id: 'fleet:local-worker',
    name: 'local-worker',
    labels: [],
    status: 'awake',
    activity_at: new Date(Date.now() - 9 * HOUR).toISOString(),
    last_seen_ago_s: 120,
    runtime_status: { status: 'awake', evidence: { liveness: 'alive', liveness_source: 'daemon-check-alive' } },
  }
}

test('a cloud identity that read its mail but stayed silent is not reported', async () => {
  const fleet = fakeFleet({ agent: cloudAgent(), ageMs: 3 * HOUR, unread: 0 })

  const result = await runAgentReceiving({ rosterRows: fleet.rosterRows, request: fleet.request, placement: noDaemonAnywhere })

  assert.equal(result.watched, 1)
  assert.deepEqual(fleet.calls.filter(call => call.type === 'unread-count').map(call => call.agent), ['fleet:cloud-pm'])
})

test('an awake local agent holding unread mail past the window is reported, as before', async () => {
  const fleet = fakeFleet({ agent: localAgent(), ageMs: 3 * HOUR, unread: 1 })

  await assert.rejects(
    runAgentReceiving({ rosterRows: fleet.rosterRows, request: fleet.request, placement: noDaemonAnywhere }),
    error => {
      assert.match(error.message, /\*\*local-worker\*\* \(`fleet:local-worker`\) has produced nothing for 180 minutes\./)
      assert.match(error.message, new RegExp(`- holding a message from \`${LEAD}\` delivered ${fleet.deliveredAt}`))
      assert.match(error.message, /no `permission_grants` row for this daemon/)
      assert.match(error.message, /This is a stuck row, not a silent agent/)
      return true
    },
  )
})

test('a cloud identity holding unread mail is reported without daemon placement or stuck-row lines', async () => {
  const fleet = fakeFleet({ agent: cloudAgent(), ageMs: 3 * HOUR, unread: 1 })

  await assert.rejects(
    runAgentReceiving({ rosterRows: fleet.rosterRows, request: fleet.request, placement: noDaemonAnywhere }),
    error => {
      assert.match(error.message, /\*\*claude-cloud-pm\*\* \(`fleet:cloud-pm`\) has produced nothing for 180 minutes\./)
      assert.match(error.message, /cloud seat \(`cloud-mcp-connected`\)/)
      assert.doesNotMatch(error.message, /no `permission_grants` row for this daemon/)
      assert.doesNotMatch(error.message, /daemon placement: not measured/)
      assert.doesNotMatch(error.message, /stuck row/)
      return true
    },
  )
})

test('unread mail inside the window is not reported', async () => {
  const fleet = fakeFleet({ agent: localAgent(), ageMs: HOUR / 2, unread: 1 })

  const result = await runAgentReceiving({ rosterRows: fleet.rosterRows, request: fleet.request, placement: noDaemonAnywhere })

  assert.equal(result.watched, 1)
})
