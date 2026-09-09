import assert from 'node:assert/strict'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const {
  checkMessageRoundTrip,
  checkDocumentRenders,
  checkFileMaterialization,
  checkMcpSurface,
  checkNotificationConsumption,
  ensureNotificationCanary,
  sendNotificationConsumptionTmuxAlarm,
  checkBotHeartbeats,
  composeFailureNudgeMessage,
  failureKey,
  failureNudgeMessageReport,
  checkMisconfiguredAgents,
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

function fakeMaterializationSurface({ artifact = '<html><body>DEV-BOT-FILE-MATERIALIZATION-marker</body></html>', refState = 'available' } = {}) {
  const calls = []
  const eventId = 314
  const attachmentUrl = 'http://fleet/api/file?path=/uploads/chip.md'
  return {
    calls,
    openConnection: async () => ({
      request: async message => {
        calls.push({ kind: 'probe', message })
        if (message.type === 'reserve-shell' || message.type === 'login' || message.type === 'mark-dead') return { ok: true }
        if (message.type === 'chat') return { event_ids: [eventId] }
        throw new Error(`unexpected probe ${message.type}`)
      },
      close: () => calls.push({ kind: 'close' }),
    }),
    uploadAttachment: async () => ({
      type: 'file',
      id: 0,
      path: '/tmp/chip.md',
      name: 'chip.md',
      url: attachmentUrl,
      size: 64,
      mimeType: 'text/markdown',
      sha256: 'hash',
    }),
    request: async message => {
      calls.push({ kind: 'request', message })
      if (message.type !== 'fleet-search') throw new Error(`unexpected request ${message.type}`)
      return {
        results: [{
          source: 'fleet',
          id: eventId,
          text: 'file-materialization probe DEV-BOT-FILE-MATERIALIZATION-marker\n\n{{att:0}}',
          metadata: {
            inline_attachments: [{ type: 'file', id: 0, name: 'chip.md', url: attachmentUrl }],
            recipient_refs: {
              'fleet:dev': {
                attachments: {
                  0: { state: refState, localPath: '/tmp/inbox-refs/chip.md' },
                },
              },
            },
          },
        }],
      }
    },
    requestJson: async (base, urlPath, options = {}) => {
      calls.push({ kind: 'json', urlPath, options })
      if (urlPath === '/api/projects') return { status: 201, body: { ok: true } }
      if (urlPath.endsWith('/source-authority')) return { status: 200, body: { currentRevision: null } }
      if (urlPath.endsWith('/push')) return { status: 200, body: { ok: true } }
      if (urlPath.endsWith('/parts')) return { status: 200, body: { ok: true, outputFile: 'parts/chip.html' } }
      if (options.method === 'DELETE') return { status: 200, body: { ok: true } }
      throw new Error(`unexpected json ${urlPath}`)
    },
    requestText: async (base, urlPath) => {
      calls.push({ kind: 'text', urlPath })
      if (urlPath.startsWith('/api/file')) return '# Chip\n\nDEV-BOT-FILE-MATERIALIZATION-marker\n'
      if (urlPath.startsWith('/docs/')) return artifact
      throw new Error(`unexpected text ${urlPath}`)
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

test('unchanged failure repeat sends compact known-failing notice', () => {
  const summary = [
    'misconfigured-agents: **permission-missing-grant-proof** (`fleet:ab36e325`) has incoherent mint/daemon join state after 22979 minutes.',
    '- fleet seat exists, but there is no `permission_grants` row; daemon terminal operations cannot place it',
    '',
    '**second-agent** (`fleet:22222222`) has incoherent mint/daemon join state after 22979 minutes.',
    '- this line is part of the repeated full payload',
  ].join('\n')
  const message = composeFailureNudgeMessage({
    report: { summary },
    unchanged: true,
    standingFor: 16,
    firstAt: Date.parse('2026-08-10T03:42:31.134Z'),
    fellBack: null,
  })

  assert.match(message, /still failing, unchanged for 16 minutes/)
  assert.match(message, /Still failing: misconfigured-agents: \*\*permission-missing-grant-proof\*\*/)
  assert.match(message, /Full failure details were sent when this condition first raised/)
  assert.doesNotMatch(message, /second-agent/)
  assert.doesNotMatch(message, /this line is part of the repeated full payload/)
})

test('new failure notice keeps the full finding payload', () => {
  const summary = [
    'misconfigured-agents: **permission-missing-grant-proof** (`fleet:ab36e325`) has incoherent mint/daemon join state after 22979 minutes.',
    '- fleet seat exists, but there is no `permission_grants` row; daemon terminal operations cannot place it',
    '',
    '**second-agent** (`fleet:22222222`) has incoherent mint/daemon join state after 22979 minutes.',
    '- this line is part of the full payload',
  ].join('\n')
  const message = composeFailureNudgeMessage({
    report: { summary },
    unchanged: false,
    standingFor: 0,
    firstAt: Date.parse('2026-08-10T03:42:31.134Z'),
    fellBack: null,
  })

  assert.match(message, /testing is failing/)
  assert.match(message, /second-agent/)
  assert.match(message, /this line is part of the full payload/)
})

test('failure key keeps check subject while ignoring elapsed time', () => {
  const first = {
    results: [{
      name: 'agent-receiving',
      ok: false,
      error: [
        '**task-notify-and-timers** (`fleet:67508f59`) has produced nothing for 120 minutes.',
        '- holding a message from `fleet:9ef0239d` delivered 2026-08-10T03:48:39.862Z',
        '- last produced: nothing on record',
        '- last call from its own client: 2026-08-10T00:53:43.376Z (hibernating)',
        '- daemon last saw the process 2207s ago',
        '- **no `permission_grants` row for this daemon -- it cannot be killed, restarted or typed into. `restart-mcp` will print `ok` and do nothing.**',
      ].join('\n'),
    }],
  }
  const later = {
    results: [{
      name: 'agent-receiving',
      ok: false,
      error: [
        '**task-notify-and-timers** (`fleet:67508f59`) has produced nothing for 133 minutes.',
        '- holding a message from `fleet:9ef0239d` delivered 2026-08-10T03:48:39.862Z',
        '- last produced: nothing on record',
        '- last call from its own client: 2026-08-10T00:53:43.376Z (hibernating)',
        '- daemon last saw the process 2967s ago',
        '- **no `permission_grants` row for this daemon -- it cannot be killed, restarted or typed into. `restart-mcp` will print `ok` and do nothing.**',
      ].join('\n'),
    }],
  }
  const differentSubject = {
    results: [{
      name: 'agent-receiving',
      ok: false,
      error: [
        '**other-task-agent** (`fleet:99999999`) has produced nothing for 133 minutes.',
        '- holding a message from `fleet:9ef0239d` delivered 2026-08-10T03:48:39.862Z',
        '- last produced: nothing on record',
        '- last call from its own client: 2026-08-10T00:53:43.376Z (hibernating)',
        '- daemon last saw the process 2967s ago',
        '- **no `permission_grants` row for this daemon -- it cannot be killed, restarted or typed into. `restart-mcp` will print `ok` and do nothing.**',
      ].join('\n'),
    }],
  }
  const differentReason = {
    results: [{
      name: 'agent-receiving',
      ok: false,
      error: [
        '**task-notify-and-timers** (`fleet:67508f59`) has produced nothing for 133 minutes.',
        '- last produced: a stale event',
      ].join('\n'),
    }],
  }

  assert.equal(failureKey(first), failureKey(later))
  assert.notEqual(failureKey(first), failureKey(differentSubject))
  assert.notEqual(failureKey(first), failureKey(differentReason))
})

test('failure key gives each subject in one check its own identity', () => {
  const combined = failureKey({
    results: [{
      name: 'misconfigured-agents',
      ok: false,
      error: [
        '**permission-missing-grant-proof** (`fleet:ab36e325`) has incoherent mint/daemon join state after 23090 minutes.',
        '- fleet seat exists, but there is no `permission_grants` row; daemon terminal operations cannot place it',
        '',
        '**permission-profile-proof** (`fleet:37723d98`) has incoherent mint/daemon join state after 23090 minutes.',
        '- fleet seat exists, but there is no `permission_grants` row; daemon terminal operations cannot place it',
      ].join('\n'),
    }],
  })

  assert.match(combined, /misconfigured-agents:fleet:ab36e325:/)
  assert.match(combined, /misconfigured-agents:fleet:37723d98:/)
})

test('new sibling failure notice still reports standing sections as ongoing', () => {
  const standing = [
    'agent-receiving: **task-notify-and-timers** (`fleet:67508f59`) has produced nothing for 126 minutes.',
    '- holding a message from `fleet:9ef0239d` delivered 2026-08-10T03:48:39.862Z',
    '- last produced: nothing on record',
    '- last call from its own client: 2026-08-10T00:53:43.376Z (hibernating)',
    '- daemon last saw the process 2565s ago',
    '- **no `permission_grants` row for this daemon -- it cannot be killed, restarted or typed into. `restart-mcp` will print `ok` and do nothing.**',
  ].join('\n')
  const withSibling = [
    standing,
    'file-materialization: The operation was aborted due to timeout',
  ].join('\n')
  const messageReport = failureNudgeMessageReport({
    report: { summary: withSibling },
    activeKey: failureKey(standing),
  })

  assert.match(messageReport.summary, /Still failing: agent-receiving: \*\*task-notify-and-timers\*\* \(`fleet:67508f59`\)/)
  assert.match(messageReport.summary, /file-materialization: The operation was aborted due to timeout/)
  assert.doesNotMatch(messageReport.summary, /holding a message from/)
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

test('file materialization probe resolves chat chip and rendered markdown artifact', async () => {
  const surface = fakeMaterializationSurface()
  const result = await checkFileMaterialization({
    fleetServer: 'http://fleet',
    storeServer: 'http://store',
    ...surface,
    uuid: (() => {
      const values = ['marker', 'projxxxx', 'senderxx', 'namexx']
      return () => values.shift()
    })(),
    now: () => 1_000,
    sleepMs: async () => {},
  })

  assert.equal(result.eventId, 314)
  assert.equal(result.materializedPath, 'parts/chip.html')
  assert.equal(surface.calls.some(call => call.kind === 'text' && call.urlPath.startsWith('/api/file')), true)
  assert.equal(surface.calls.some(call => call.kind === 'text' && call.urlPath.includes('/docs/devbot-materialize-projxxxx/parts/chip.html')), true)
})

test('file materialization probe goes red when rendered artifact drops marker', async () => {
  await assert.rejects(
    checkFileMaterialization({
      fleetServer: 'http://fleet',
      storeServer: 'http://store',
      ...fakeMaterializationSurface({ artifact: '<html><body>empty</body></html>' }),
      uuid: (() => {
        const values = ['marker', 'projxxxx', 'senderxx', 'namexx']
        return () => values.shift()
      })(),
      now: () => 1_000,
      sleepMs: async () => {},
    }),
    /missing marker/,
  )
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

function fakeNotificationCanarySurface({ withSeat = true, reply = true } = {}) {
  const calls = []
  const resolve = async agent => {
    const name = String(agent).replace(/^fleet:/, '')
    return {
      id: `fleet:${name}`,
      friendly_name: name,
      dead: false,
      metadata: { model: name.includes('claude') ? 'opus' : 'terra' },
    }
  }
  return {
    calls,
    resolve,
    readSeat: async agentId => withSeat
      ? { session_id: `session:${agentId}`, daemon_key: 'mini:testing', terminal_capability: true }
      : null,
    request: async message => {
      calls.push(message)
      if (message.type === 'check-alive') return { state: 'alive' }
      if (message.type === 'hibernate-session') return { ok: true }
      if (message.type === 'chat') return { event_ids: [calls.length] }
      if (message.type === 'fleet-search') {
        return {
          results: reply ? [{
            source: 'fleet',
            id: 900 + calls.length,
            from_id: message.query.includes(':claude:') ? 'fleet:dev-notify-canary-claude' : 'fleet:dev-notify-canary-codex',
            recipients: ['fleet:dev'],
            text: message.query,
            timestamp: new Date().toISOString(),
          }] : [],
        }
      }
      throw new Error(`unexpected ${message.type}`)
    },
  }
}

test('notification consumption probe requires canary-produced replies', async () => {
  const surface = fakeNotificationCanarySurface()
  const result = await checkNotificationConsumption({
    ...surface,
    uuid: (() => {
      const values = ['claude-token', 'codex-token']
      return () => values.shift()
    })(),
    now: () => 1_000_000,
    sleepMs: async () => {},
  })
  assert.deepEqual(result.canaries.map(row => row.family).sort(), ['claude', 'codex'])
  assert.equal(surface.calls.filter(call => call.type === 'chat').length, 2)
  assert.equal(surface.calls.filter(call => call.type === 'fleet-search').length, 2)
})

test('notification canary with no daemon route is provisioning failure, not consumption failure', async () => {
  const surface = fakeNotificationCanarySurface({ withSeat: false })
  await assert.rejects(
    checkNotificationConsumption({
      ...surface,
      now: () => 1_000_000,
      sleepMs: async () => {},
    }),
    error => {
      assert.equal(error.failureKind, 'canary-provisioning')
      assert.match(error.message, /canary provisioning failure/)
      return true
    },
  )
})

function notificationCanaryProvisioningSurface({ alive = ['alive'], wakeResult = { ok: true, agent_id: 'fleet:canary' }, resolved = null, seats = null } = {}) {
  const calls = []
  const agent = { id: 'fleet:canary', friendly_name: 'canary', dead: false, metadata: { model: 'opus' } }
  const defaultSeat = { session_id: 'session:canary', daemon_key: 'mini:testing', terminal_capability: true }
  return {
    calls,
    agent,
    resolve: async () => resolved?.length ? resolved.shift() : agent,
    readSeat: async () => seats?.length ? seats.shift() : defaultSeat,
    wake: async agentId => {
      calls.push({ type: 'wake', agent: agentId })
      if (wakeResult instanceof Error) throw wakeResult
      return wakeResult
    },
    request: async message => {
      calls.push(message)
      if (message.type !== 'check-alive') throw new Error(`unexpected ${message.type}`)
      const next = alive.shift()
      if (next instanceof Error) throw next
      return { state: next.state || next, reason: next.reason }
    },
  }
}

const canarySpec = { family: 'claude', name: 'canary', model: () => 'opus' }
const reachedConsumption = calls => calls.some(call => ['hibernate-session', 'chat', 'fleet-search'].includes(call.type))

test('hibernating and terminal-capability dead canaries wake in place', async () => {
  for (const first of [
    'hibernating',
    { state: 'dead', reason: 'daemon check-alive: terminal capability unavailable' },
  ]) {
    const surface = notificationCanaryProvisioningSurface({ alive: [first, 'alive'] })
    const result = await ensureNotificationCanary(canarySpec, surface)
    assert.equal(result.agent.id, surface.agent.id)
    assert.equal(result.seat.daemon_key, 'mini:testing')
    assert.deepEqual(surface.calls.map(call => call.type), ['check-alive', 'wake', 'check-alive'])
  }
})

test('check-alive timeout is indeterminate provisioning while other failures remain distinct', async () => {
  const timeout = notificationCanaryProvisioningSurface({ alive: [new Error('check-alive timed out after 15000ms')] })
  await assert.rejects(ensureNotificationCanary(canarySpec, timeout), error =>
    error.failureKind === 'canary-provisioning' && error.reason === 'indeterminate')
  assert.equal(reachedConsumption(timeout.calls), false)

  const transportError = new Error('check-alive connection closed')
  const other = notificationCanaryProvisioningSurface({ alive: [transportError] })
  await assert.rejects(ensureNotificationCanary(canarySpec, other), error => error === transportError)

  const daemon = notificationCanaryProvisioningSurface({ alive: [{ state: 'wedged', reason: 'process unresponsive' }] })
  await assert.rejects(ensureNotificationCanary(canarySpec, daemon), error =>
    error.failureKind === 'canary-provisioning' && /state=wedged reason=process unresponsive/.test(error.message))
})

test('wake refusal and wrong identity stop before notification consumption', async () => {
  for (const wakeResult of [
    new Error('daemon refused wake'),
    { ok: false, error: 'refused' },
    { ok: true, agent_id: 'fleet:different' },
  ]) {
    const surface = notificationCanaryProvisioningSurface({ alive: ['hibernating'], wakeResult })
    await assert.rejects(ensureNotificationCanary(canarySpec, surface), error => error.failureKind === 'canary-provisioning')
    assert.equal(reachedConsumption(surface.calls), false)
  }
})

test('post-wake identity and daemon-route failures stop before notification consumption', async () => {
  const canonical = notificationCanaryProvisioningSurface().agent
  const liveSeat = { session_id: 'session:canary', daemon_key: 'mini:testing', terminal_capability: true }
  const cases = [
    { resolved: [canonical, canonical, null], seats: [liveSeat] },
    { resolved: [canonical, canonical, { ...canonical, dead: true }], seats: [liveSeat] },
    { resolved: [canonical, canonical, { ...canonical, id: 'fleet:different' }], seats: [liveSeat] },
    { resolved: [canonical, canonical, canonical], seats: [liveSeat, { ...liveSeat, daemon_key: 'fly:testing' }] },
  ]
  for (const options of cases) {
    const surface = notificationCanaryProvisioningSurface({ alive: ['hibernating'], ...options })
    await assert.rejects(ensureNotificationCanary(canarySpec, surface), error =>
      error.failureKind === 'canary-provisioning' && error.reason === 'wake-route-mismatch')
    assert.equal(reachedConsumption(surface.calls), false)
  }
})

test('post-wake timeout and non-alive result stop before notification consumption', async () => {
  for (const second of [new Error('check-alive timed out after 15000ms'), 'wedged']) {
    const surface = notificationCanaryProvisioningSurface({ alive: ['hibernating', second] })
    await assert.rejects(ensureNotificationCanary(canarySpec, surface), error => error.failureKind === 'canary-provisioning')
    assert.equal(reachedConsumption(surface.calls), false)
  }
})

test('dead state for a different reason is not wakeable', async () => {
  const surface = notificationCanaryProvisioningSurface({ alive: [{ state: 'dead', reason: 'process exited' }] })
  await assert.rejects(ensureNotificationCanary(canarySpec, surface), error =>
    error.failureKind === 'canary-provisioning' && /state=dead reason=process exited/.test(error.message))
  assert.equal(surface.calls.some(call => call.type === 'wake'), false)
  assert.equal(reachedConsumption(surface.calls), false)
})

test('runChecks carries notification failure kind into the report', async () => {
  const report = await runChecks({
    checks: [['notification-consumption', async () => {
      const err = new Error('codex notification consumption failure: token missing')
      err.failureKind = 'notification-consumption'
      err.family = 'codex'
      throw err
    }]],
  })
  assert.equal(report.ok, false)
  assert.equal(report.failureKind, 'notification-consumption')
  assert.match(report.summary, /notification-consumption/)
  assert.match(report.summary, /codex/)
})

test('notification consumption tmux alarm resolves awake on-call at alarm time', async () => {
  const pasted = []
  const result = await sendNotificationConsumptionTmuxAlarm({
    failureKind: 'notification-consumption',
    summary: 'notification-consumption [codex]: token missing',
  }, {
    nudgeLabel: 'on-call',
    requestJson: async (base, urlPath) => {
      assert.match(urlPath, /awake%20%26%20on-call/)
      return { agents: [{ id: 'fleet:oncall', labels: ['on-call'], dead: false }] }
    },
    readSeat: async agentId => ({ session_id: `tmux:${agentId}`, daemon_key: 'mini:testing', terminal_capability: true }),
    paste: (sessionId, message) => pasted.push({ sessionId, message }),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(pasted.map(row => row.sessionId), ['tmux:fleet:oncall'])
  assert.match(pasted[0].message, /direct tmux paste/)
})

test('notification consumption tmux alarm records missing on-call holder', async () => {
  const result = await sendNotificationConsumptionTmuxAlarm({
    failureKind: 'notification-consumption',
    summary: 'notification-consumption [codex]: token missing',
  }, {
    nudgeLabel: 'on-call',
    requestJson: async () => ({ agents: [] }),
    paste: () => { throw new Error('should not paste') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.failureKind, 'alarm-no-recipient')
  assert.match(result.reason, /no awake holder/)
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

test('misconfigured agent check detects stranded async joins but ignores young mints', async () => {
  const old = '2026-08-10T00:00:00.000Z'
  const young = '2026-08-10T00:09:30.000Z'
  const now = () => Date.parse('2026-08-10T00:10:00.000Z')
  const complete = {
    mint_id: 'complete-mint',
    fleet_id: 'fleet:complete',
    friendly_name: 'complete',
    process_state: JSON.stringify({ session_id: 'session-complete', tmux_session: 'fleet-complete', env_name: 'testing', daemon_key: 'mini:testing' }),
    session_id: 'session-complete',
    created_at: old,
  }
  const result = await checkMisconfiguredAgents({
    mintRows: [
      complete,
      {
        mint_id: 'young-mint',
        fleet_id: 'fleet:young',
        friendly_name: 'young',
        process_state: null,
        session_id: null,
        created_at: young,
      },
    ],
    grantRows: [{ id: 'fleet:complete', session_id: 'session-complete', daemon_key: 'mini:testing', env_name: 'testing' }],
    agentRowsByIds: async ids => ids.map(id => ({ id, dead: false })),
    now,
    joinGraceMs: 5 * 60_000,
  })
  assert.equal(result.checked, 2)
  assert.equal(result.young, 1)

  let lookedUp = []
  await assert.rejects(
    checkMisconfiguredAgents({
      mintRows: [
        complete,
        {
          mint_id: 'missing-grant-mint',
          fleet_id: 'fleet:missing-grant',
          friendly_name: 'missing-grant',
          process_state: JSON.stringify({ session_id: 'session-missing', tmux_session: 'fleet-missing-grant', env_name: 'testing', daemon_key: 'mini:testing' }),
          session_id: 'session-missing',
          created_at: old,
        },
        {
          mint_id: 'no-process-mint',
          fleet_id: 'fleet:no-process',
          friendly_name: 'no-process',
          process_state: null,
          session_id: null,
          created_at: old,
        },
        {
          mint_id: 'mcp-never-joined-mint',
          fleet_id: 'fleet:mcp-never-joined',
          friendly_name: 'mcp-never-joined',
          process_state: JSON.stringify({ tmux_session: 'fleet-mcp-never-joined', env_name: 'testing', daemon_key: 'mini:testing' }),
          session_id: null,
          created_at: old,
        },
      ],
      grantRows: [
        { id: 'fleet:complete', session_id: 'session-complete', daemon_key: 'mini:testing', env_name: 'testing' },
        { id: 'fleet:no-process', session_id: null, daemon_key: 'mini:testing', env_name: 'testing' },
        { id: 'fleet:mcp-never-joined', session_id: null, daemon_key: 'mini:testing', env_name: 'testing' },
      ],
      agentRowsByIds: async ids => {
        lookedUp = ids
        return ids.map(id => ({ id, dead: false }))
      },
      now,
      joinGraceMs: 5 * 60_000,
      sessionExists: session => session === 'fleet-mcp-never-joined',
    }),
    /no `permission_grants` row[\s\S]*no process_state and no session_id[\s\S]*tmux session still exists/,
  )
  assert.deepEqual(lookedUp, ['fleet:missing-grant', 'fleet:no-process', 'fleet:mcp-never-joined'])

  const deadHistorical = await checkMisconfiguredAgents({
    mintRows: [{
      mint_id: 'dead-mint',
      fleet_id: 'fleet:dead-agent',
      friendly_name: 'dead-agent',
      process_state: null,
      session_id: null,
      created_at: old,
    }],
    grantRows: [],
    agentRowsByIds: async ids => ids.map(id => ({ id, dead: true })),
    now,
    joinGraceMs: 5 * 60_000,
  })
  assert.equal(deadHistorical.checked, 0)

  await assert.rejects(
    checkMisconfiguredAgents({
      mintRows: [{
        mint_id: 'pending-no-grant-mint',
        fleet_id: 'fleet:pending-no-grant',
        friendly_name: 'pending-no-grant',
        process_state: null,
        session_id: null,
        created_at: old,
      }],
      grantRows: [],
      agentRowsByIds: async () => [],
      now,
      joinGraceMs: 5 * 60_000,
    }),
    /pending-no-grant[\s\S]*no `permission_grants` row/,
  )
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
