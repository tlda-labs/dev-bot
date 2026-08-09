import assert from 'node:assert/strict'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const {
  checkMessageRoundTrip,
  checkDocumentRenders,
  checkMcpSurface,
  checkBotHeartbeats,
  checkResourceCleanup,
  runChecks,
} = await import('./dev-bot.mjs')

function fakeProbeConnection({ chatResult = { event_ids: [42] } } = {}) {
  const calls = []
  return {
    calls,
    connection: {
      request: async message => {
        calls.push(message)
        if (message.type === 'chat') return chatResult
        return { ok: true }
      },
      close: () => calls.push({ type: 'close' }),
    },
  }
}

function fakeRenderSurface({ artifact = '<html><body>DEV-BOT-RENDER-MARKDOWN-MARKER <span class="katex">x</span></body></html>', status = 'success' } = {}) {
  const calls = []
  return {
    calls,
    requestJson: async (base, urlPath, options = {}) => {
      calls.push({ kind: 'json', urlPath, options })
      if (urlPath === '/api/projects') return { status: 201, body: { ok: true } }
      if (urlPath.endsWith('/source-authority')) return { status: 200, body: { currentRevision: null } }
      if (urlPath.endsWith('/push')) return { status: 200, body: { ok: true } }
      if (urlPath.endsWith('/link')) return { status: 200, body: { ok: true, linked: true } }
      if (urlPath.endsWith('/overleaf-sync')) return { status: 200, body: { ok: true } }
      if (urlPath.endsWith('/build/status')) return { status: 200, body: { status } }
      if (options.method === 'DELETE') return { status: 200, body: { ok: true } }
      throw new Error(`unexpected json ${urlPath}`)
    },
    requestText: async (base, urlPath) => {
      calls.push({ kind: 'text', urlPath })
      if (urlPath.includes('page-info.json')) return JSON.stringify([{ file: 'index.html', width: 800, height: 1000 }])
      return artifact
    },
  }
}

test('chat round trip reads receiver history instead of trusting chat ack', async () => {
  const probe = fakeProbeConnection()
  const historyCalls = []
  const result = await checkMessageRoundTrip({
    openConnection: async () => probe.connection,
    uuid: (() => {
      const values = ['senderid', 'sendername', 'token']
      return () => values.shift()
    })(),
    now: () => 1_000_000,
    request: async message => {
      historyCalls.push(message)
      assert.equal(message.type, 'fleet-search')
      assert.equal(message.historyOnly, true)
      assert.equal(message.eventOnly, true)
      assert.equal(message.eventType, 'chat')
      assert.ok(message.since)
      return {
        results: [{
          source: 'fleet',
          id: 42,
          text: 'dev-probe:token',
        }],
      }
    },
  })

  assert.equal(result.eventId, 42)
  assert.equal(probe.calls.some(call => call.type === 'chat'), true)
  assert.equal(historyCalls.length, 1)
})

test('chat round trip goes red when acked send is absent from receiver history', async () => {
  const probe = fakeProbeConnection()
  const times = [1_000_000, 1_000_000, 1_000_001, 1_016_000]
  await assert.rejects(
    checkMessageRoundTrip({
      openConnection: async () => probe.connection,
      uuid: (() => {
        const values = ['senderid', 'sendername', 'token']
        return () => values.shift()
      })(),
      now: () => times.shift() ?? 1_016_000,
      request: async () => ({ results: [] }),
    }),
    /accepted chat did not arrive/,
  )
  assert.equal(probe.calls.some(call => call.type === 'mark-dead'), true)
})

test('document render probe reads rendered artifacts, not only build status', async () => {
  const surface = fakeRenderSurface()
  const result = await checkDocumentRenders({
    storeServer: 'http://store',
    ...surface,
    uuid: (() => {
      const values = ['prefixxxx', 'MARKER']
      return () => values.shift()
    })(),
    probes: [{
      kind: 'markdown',
      format: 'markdown',
      mainFile: 'index.md',
      artifactPath: 'index.html',
      source: marker => `# Probe\n\n${marker}\n\n$x$`,
    }],
    now: () => 1_000,
    sleepMs: async () => {},
  })

  assert.equal(result.rendered[0].kind, 'markdown')
  assert.equal(surface.calls.some(call => call.kind === 'text' && call.urlPath.includes('/docs/devbot-render-prefixxx-markdown/index.html')), true)
  assert.equal(surface.calls.some(call => call.kind === 'text' && call.urlPath.includes('page-info.json')), true)
})

test('document render probe goes red when build succeeds but artifact drops marker', async () => {
  const surface = fakeRenderSurface({ artifact: '<html><body><span class="katex">x</span></body></html>' })
  await assert.rejects(
    checkDocumentRenders({
      storeServer: 'http://store',
      ...surface,
      uuid: (() => {
        const values = ['prefixxxx', 'MARKER']
        return () => values.shift()
      })(),
      probes: [{
        kind: 'markdown',
        format: 'markdown',
        mainFile: 'index.md',
        artifactPath: 'index.html',
        source: marker => `# Probe\n\n${marker}\n\n$x$`,
      }],
      now: () => 1_000,
      sleepMs: async () => {},
    }),
    /missing marker/,
  )
})

test('document render probe reports blocked when rendering cannot finish', async () => {
  const surface = fakeRenderSurface({ status: 'building' })
  const times = [1_000, 1_000, 122_000]
  const result = await checkDocumentRenders({
    storeServer: 'http://store',
    ...surface,
    uuid: (() => {
      const values = ['prefixxxx', 'MARKER']
      return () => values.shift()
    })(),
    probes: [{
      kind: 'markdown',
      format: 'markdown',
      mainFile: 'index.md',
      artifactPath: 'index.html',
      source: marker => `# Probe\n\n${marker}\n`,
    }],
    now: () => times.shift() ?? 122_000,
    sleepMs: async () => {},
  })
  assert.equal(result.blocked, true)
  assert.match(result.reason, /did not finish/)
})

test('document render probe blocks the LaTeX leg when no watched SVG probe exists', async () => {
  const result = await checkDocumentRenders({
    storeServer: 'http://store',
    ...fakeRenderSurface(),
    uuid: (() => {
      const values = ['prefixxxx']
      return () => values.shift()
    })(),
    probes: [{
      kind: 'latex',
      format: 'svg',
      mainFile: 'main.tex',
      artifactPath: 'main-page-1.svg',
      source: marker => marker,
    }],
    now: () => 1_000,
    sleepMs: async () => {},
  })
  assert.equal(result.blocked, true)
  assert.match(result.reason, /daemon-watched source project/)
})

test('MCP surface reads durable surfaces and rejects model=bot', async () => {
  const seen = []
  const probe = fakeProbeConnection({ chatResult: { event_ids: [77] } })
  const times = [1_000_000, 1_000_000]
  const good = await checkMcpSurface({
    openConnection: async () => probe.connection,
    uuid: (() => {
      const values = ['probeid', 'probename', 'token']
      return () => values.shift()
    })(),
    now: () => times.shift() ?? 1_000_000,
    sleepMs: async () => {},
    request: async message => {
      seen.push(message.type)
      if (message.type === 'resolve-agent') return { agent: { id: 'fleet:dev', name: 'dev', model: 'dev' } }
      if (message.type === 'my-task') return { messages: [] }
      if (message.type === 'fleet-search') return { results: [{ source: 'fleet', id: 77, text: 'mcp-probe:token' }] }
      throw new Error(`unexpected ${message.type}`)
    },
  })
  assert.deepEqual(seen, ['resolve-agent', 'my-task', 'fleet-search'])
  assert.equal(good.transport, 'real-mcp')
  assert.deepEqual(good.tools, ['login', 'inbox', 'chat', 'thread'])
  assert.equal(probe.calls.some(call => call.type === 'login'), true)
  assert.equal(probe.calls.some(call => call.type === 'chat'), true)
  assert.equal(probe.calls.some(call => call.type === 'mark-dead'), true)

  await assert.rejects(
    checkMcpSurface({
      request: async message => {
        if (message.type === 'resolve-agent') return { agent: { id: 'fleet:dev', name: 'dev', model: 'bot' } }
        return {}
      },
    }),
    /model=bot/,
  )
})

test('MCP surface goes red when chat ack is absent from thread readback', async () => {
  const probe = fakeProbeConnection({ chatResult: { event_ids: [77] } })
  const times = [1_000_000, 1_000_000, 1_016_000]
  await assert.rejects(
    checkMcpSurface({
      openConnection: async () => probe.connection,
      uuid: (() => {
        const values = ['probeid', 'probename', 'token']
        return () => values.shift()
      })(),
      now: () => times.shift() ?? 1_016_000,
      sleepMs: async () => {},
      request: async message => {
        if (message.type === 'resolve-agent') return { agent: { id: 'fleet:dev', name: 'dev', model: 'dev' } }
        if (message.type === 'my-task') return { messages: [] }
        if (message.type === 'fleet-search') return { results: [] }
        throw new Error(`unexpected ${message.type}`)
      },
    }),
    /MCP chat accepted but thread readback did not contain the message/,
  )
  assert.equal(probe.calls.some(call => call.type === 'mark-dead'), true)
})

test('bot health distinguishes beating, stopped, uninstrumented, and alive-but-deaf', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'devbot-health-'))
  await mkdir(dir, { recursive: true })
  const now = Date.now() + 20 * 60_000
  await writeFile(path.join(dir, 'hearing.testing.heartbeat'), JSON.stringify({
    ts: new Date().toISOString(),
    reason: 'fleet-event',
    lastFleetEventId: 123,
  }) + '\n')
  await writeFile(path.join(dir, 'deaf.testing.heartbeat'), JSON.stringify({
    ts: new Date().toISOString(),
    reason: 'task-kick-sweep',
    lastFleetEventId: 0,
  }) + '\n')
  await utimes(path.join(dir, 'hearing.testing.heartbeat'), now / 1000, now / 1000)

  await assert.rejects(
    checkBotHeartbeats({
      declaredBots: ['hearing', 'deaf', 'missing'],
      heartbeatDir: dir,
      now: () => now,
    }),
    /alive but deaf/,
  )

  const result = await checkBotHeartbeats({
    declaredBots: ['hearing', 'missing'],
    heartbeatDir: dir,
    now: () => now,
  })
  assert.deepEqual(result.beating, ['hearing'])
  assert.deepEqual(result.unmonitored, ['missing'])
  assert.equal(result.blocked, true)
})

test('blocked checks are carried into the sweep report', async () => {
  const report = await runChecks({
    checks: [
      ['bot-heartbeats', async () => ({ blocked: true, reason: 'synthetic missing heartbeat instrument' })],
    ],
  })
  assert.equal(report.ok, true)
  assert.ok(report.blocked.includes('bot-heartbeats:synthetic missing heartbeat instrument'))
})

test('resource cleanup reports inventory failures instead of only logging them', async () => {
  await assert.rejects(
    checkResourceCleanup({
      previewReaper: () => ({ reaped: [], failed: [{ pid: 123, port: 5176, error: 'refused' }] }),
      playwrightCleanup: { sweep: async () => [{ session: 'shared', state: 'error', error: 'timeout' }] },
      worktreeCleanupDriver: { sweep: async () => ({ totalBytes: 0, retainedBytes: 0, overBudgetBytes: 0, removedWorktrees: [], evicted: [], pinned: [], abandoned: [], unremovable: [] }) },
      now: () => 0,
    }),
    /preview pid=123[\s\S]*Playwright shared: timeout/,
  )
})

test('resource cleanup scans current state and returns bounded summary', async () => {
  const result = await checkResourceCleanup({
    previewReaper: () => ({ reaped: [{ pid: 1 }], failed: [] }),
    playwrightCleanup: { sweep: async () => [{ session: 'shared', state: 'claimed' }] },
    worktreeCleanupDriver: { sweep: async () => ({ totalBytes: 10, retainedBytes: 8, overBudgetBytes: 0, removedWorktrees: [], evicted: [], pinned: [], abandoned: [], unremovable: [] }) },
    now: () => Date.now(),
  })

  assert.deepEqual(result.previews, { reaped: 1, failed: 0 })
  assert.deepEqual(result.playwright, [{ session: 'shared', state: 'claimed' }])
})
