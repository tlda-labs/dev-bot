import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
process.env.TLDA_DEV_BOT_ALLOW_NONDEFAULT = '1'
process.env.TLDA_ENV = 'testing'
const {
  checkBotHeartbeats,
  checkDocumentBuildLoop,
  checkMcpToolSurface,
  checkMessageRoundTrip,
} = await import('./dev-bot.mjs')

function uuidSequence(values) {
  let index = 0
  return () => values[index++] || `uuid-${index}`
}

function tickingNow(values = [0, 0, 0, 20_000]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

function fakeConnection({ chatEventId = 101 } = {}) {
  const calls = []
  return {
    calls,
    async request(message) {
      calls.push(message)
      switch (message.type) {
        case 'reserve-shell': return { ok: true }
        case 'login': return { ok: true, agent: { id: message.agent_id, friendly_name: message.name } }
        case 'my-task': return { task: null, tasks: [], messages: [], counts: { tasks: 0, messages: 0 } }
        case 'chat': return { ok: true, event_ids: [chatEventId] }
        case 'mark-dead': return { ok: true }
        default: throw new Error(`unexpected request ${message.type}`)
      }
    },
    close() {},
  }
}

test('fleet chat round trip fails when accepted chat is absent from history readback', async () => {
  const connection = fakeConnection({ chatEventId: 11 })
  await assert.rejects(
    checkMessageRoundTrip({
      uuid: uuidSequence(['sender111', 'name11', 'token11']),
      openConnection: async () => connection,
      readHistory: async () => ({ results: [] }),
      now: tickingNow(),
    }),
    /accepted chat did not arrive/,
  )
})

test('fleet chat round trip passes only after recipient history readback sees the event', async () => {
  const connection = fakeConnection({ chatEventId: 12 })
  const result = await checkMessageRoundTrip({
    uuid: uuidSequence(['sender222', 'name22', 'token22']),
    openConnection: async () => connection,
    readHistory: async () => ({ results: [{ source: 'fleet', id: 12, text: 'dev-probe:token22' }] }),
    now: tickingNow([0, 0, 0]),
  })
  assert.equal(result.eventId, 12)
})

test('MCP surface fails when thread readback does not contain the accepted chat', async () => {
  const connection = fakeConnection({ chatEventId: 21 })
  await assert.rejects(
    checkMcpToolSurface({
      uuid: uuidSequence(['mcp11111', 'mcpname', 'mcptoken']),
      openConnection: async () => connection,
      readThread: async () => ({ results: [] }),
      now: tickingNow(),
    }),
    /thread readback did not contain/,
  )
})

test('MCP surface exercises login, inbox, chat, and thread readback', async () => {
  const connection = fakeConnection({ chatEventId: 22 })
  const result = await checkMcpToolSurface({
    uuid: uuidSequence(['mcp22222', 'mcpnam', 'mcptoken2']),
    openConnection: async () => connection,
    readThread: async () => ({ results: [{ source: 'fleet', event_id: 22, text: 'dev-mcp-surface:mcptoken2' }] }),
    now: tickingNow([0, 0, 0]),
  })
  assert.equal(result.login, true)
  assert.equal(result.inbox, true)
  assert.equal(result.threadEventId, 22)
  assert.deepEqual(connection.calls.map(call => call.type), ['reserve-shell', 'login', 'my-task', 'chat', 'mark-dead'])
})

test('bot heartbeat check fails a bot that is alive but deaf', async () => {
  await assert.rejects(
    checkBotHeartbeats({
      declaredNames: ['todd'],
      stat: () => ({ mtimeMs: Date.now() }),
      readHeartbeat: () => ({ reason: 'heartbeat', lastFleetEventId: 0 }),
    }),
    /has not heard a fleet event/,
  )
})

test('bot heartbeat check reports outcome-bearing bot health', async () => {
  const result = await checkBotHeartbeats({
    declaredNames: ['todd'],
    stat: () => ({ mtimeMs: Date.now() }),
    readHeartbeat: () => ({ reason: 'heartbeat', lastFleetEventId: 42 }),
  })
  assert.deepEqual(result.beating, ['todd'])
})

test('document build loop fails when rendered output lacks the version stamp', async () => {
  const cleaned = []
  await assert.rejects(
    checkDocumentBuildLoop({
      uuid: uuidSequence(['abc12345', 'stamp-a']),
      fetcher: async (_base, urlPath, options = {}) => {
        if (urlPath === '/api/projects') return { name: options.body.name }
        if (urlPath.endsWith('/source-authority')) return { currentRevision: null }
        if (urlPath.endsWith('/push')) return { ok: true, sourceRevision: 'rev-1' }
        throw new Error(`unexpected fetch ${urlPath}`)
      },
      waitBuild: async () => ({ status: 'success' }),
      rawFetch: async () => ({ ok: true, status: 200, text: async () => '<h1>wrong</h1>' }),
      now: () => 1_000,
      cleanup: async project => { cleaned.push(project) },
    }),
    /did not contain version stamp/,
  )
  assert.deepEqual(cleaned, ['dev-probe-build-abc12345'])
})

test('document build loop creates, pushes, builds, reads rendered stamp, and cleans up', async () => {
  const cleaned = []
  const result = await checkDocumentBuildLoop({
    uuid: uuidSequence(['def67890', 'stamp-b']),
    fetcher: async (_base, urlPath, options = {}) => {
      if (urlPath === '/api/projects') return { name: options.body.name }
      if (urlPath.endsWith('/source-authority')) return { currentRevision: null }
      if (urlPath.endsWith('/push')) {
        assert.match(options.body.files[0].content, /dev-build-stamp-stamp-b/)
        return { ok: true, sourceRevision: 'rev-2' }
      }
      throw new Error(`unexpected fetch ${urlPath}`)
    },
    waitBuild: async () => ({ status: 'success' }),
    rawFetch: async () => ({ ok: true, status: 200, text: async () => '<h1>dev-build-stamp-stamp-b</h1>' }),
    now: () => 1_000,
    cleanup: async project => { cleaned.push(project) },
  })
  assert.equal(result.project, 'dev-probe-build-def67890')
  assert.equal(result.outputPath, '/docs/dev-probe-build-def67890/index.html')
  assert.deepEqual(cleaned, ['dev-probe-build-def67890'])
})
