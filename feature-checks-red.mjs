#!/usr/bin/env node

import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.TLDA_DEV_BOT_NO_START = '1'

const {
  checkDocumentRenders,
  checkFileMaterialization,
  checkMessageRoundTrip,
  checkMcpSurface,
  checkBotHeartbeats,
  checkMisconfiguredAgents,
  checkResourceCleanup,
  runChecks,
} = await import('./dev-bot.mjs')

const lines = []
let failures = 0

async function expectRed(label, fn, match) {
  try {
    await fn()
    lines.push(`not red - ${label}: check returned clean`)
    failures += 1
  } catch (error) {
    const message = error?.message || String(error)
    if (!match.test(message)) {
      lines.push(`wrong red - ${label}: ${message}`)
      failures += 1
      return
    }
    lines.push(`RED - ${label}: ${message.split('\n')[0]}`)
  }
}

await expectRed(
  '4 document render artifact readback',
  async () => checkDocumentRenders({
    storeServer: 'http://store',
    requestJson: async (base, urlPath, options = {}) => {
      if (urlPath === '/api/projects') return { status: 201, body: { ok: true } }
      if (urlPath.endsWith('/source-authority')) return { status: 200, body: { currentRevision: null } }
      if (urlPath.endsWith('/push')) return { status: 200, body: { ok: true } }
      if (urlPath.endsWith('/link')) return { status: 200, body: { ok: true, linked: true } }
      if (urlPath.endsWith('/overleaf-sync')) return { status: 200, body: { ok: true } }
      if (urlPath.endsWith('/build/status')) return { status: 200, body: { status: 'success' } }
      if (options.method === 'DELETE') return { status: 200, body: { ok: true } }
      throw new Error(`setup failed: unexpected ${urlPath}`)
    },
    requestText: async (base, urlPath) => {
      if (urlPath.includes('page-info.json')) return JSON.stringify([{ file: 'index.html', width: 800, height: 1000 }])
      return '<html><body><span class="katex">x</span></body></html>'
    },
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

await expectRed(
  '1 chat round trip',
  async () => checkMessageRoundTrip({
    openConnection: async () => ({
      request: async message => {
        if (message.type === 'chat') return { event_ids: [101] }
        return { ok: true }
      },
      close: () => {},
    }),
    uuid: (() => {
      const values = ['senderid', 'sendername', 'token']
      return () => values.shift()
    })(),
    now: (() => {
      const values = [1_000_000, 1_000_000, 1_016_000]
      return () => values.shift() ?? 1_016_000
    })(),
    request: async message => {
      if (message.type !== 'fleet-search') throw new Error(`setup failed: unexpected ${message.type}`)
      return { results: [] }
    },
  }),
  /accepted chat did not arrive/,
)

await expectRed(
  '2 MCP surface tool readback',
  async () => checkMcpSurface({
    openConnection: async () => ({
      request: async message => {
        if (message.type === 'chat') return { event_ids: [202] }
        return { ok: true }
      },
      close: () => {},
    }),
    uuid: (() => {
      const values = ['probeid', 'probename', 'token']
      return () => values.shift()
    })(),
    now: (() => {
      const values = [1_000_000, 1_000_000, 1_016_000]
      return () => values.shift() ?? 1_016_000
    })(),
    sleepMs: async () => {},
    request: async message => {
      if (message.type === 'resolve-agent') {
        return { agent: { id: 'fleet:dev', name: 'dev', model: 'dev' } }
      }
      if (message.type === 'my-task') return { messages: [] }
      if (message.type === 'fleet-search') return { results: [] }
      throw new Error(`setup failed: unexpected ${message.type}`)
    },
  }),
  /MCP chat accepted but thread readback did not contain the message/,
)

await expectRed(
  '7 bot heartbeat alive but deaf',
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devbot-red-heartbeat-'))
    await writeFile(path.join(dir, 'todd.testing.heartbeat'), JSON.stringify({
      ts: new Date().toISOString(),
      reason: 'task-kick-sweep',
      lastFleetEventId: 0,
    }) + '\n')
    await checkBotHeartbeats({
      declaredBots: ['todd'],
      heartbeatDir: dir,
      now: () => Date.now() + 20 * 60_000,
    })
  },
  /alive but deaf/,
)

await expectRed(
  '8 misconfigured agent join coherence',
  async () => checkMisconfiguredAgents({
    mintRows: [{
      mint_id: 'red-missing-grant',
      fleet_id: 'fleet:red-missing-grant',
      friendly_name: 'red-missing-grant',
      process_state: JSON.stringify({
        session_id: 'session-red',
        tmux_session: 'fleet-red-missing-grant',
        env_name: 'testing',
        daemon_key: 'mini:testing',
      }),
      session_id: 'session-red',
      created_at: '2026-08-10T00:00:00.000Z',
    }],
    grantRows: [],
    now: () => Date.parse('2026-08-10T00:10:00.000Z'),
    joinGraceMs: 5 * 60_000,
  }),
  /no `permission_grants` row/,
)

await expectRed(
  '10 file materialization chip artifact readback',
  async () => checkFileMaterialization({
    fleetServer: 'http://fleet',
    storeServer: 'http://store',
    openConnection: async () => ({
      request: async message => {
        if (message.type === 'reserve-shell' || message.type === 'login' || message.type === 'mark-dead') return { ok: true }
        if (message.type === 'chat') return { event_ids: [404] }
        throw new Error(`setup failed: unexpected probe ${message.type}`)
      },
      close: () => {},
    }),
    uploadAttachment: async () => ({
      type: 'file',
      id: 0,
      path: '/tmp/chip.md',
      name: 'chip.md',
      url: 'http://fleet/api/file?path=/uploads/chip.md',
      size: 64,
      mimeType: 'text/markdown',
      sha256: 'hash',
    }),
    request: async message => {
      if (message.type !== 'fleet-search') throw new Error(`setup failed: unexpected ${message.type}`)
      return {
        results: [{
          source: 'fleet',
          id: 404,
          text: 'file-materialization probe DEV-BOT-FILE-MATERIALIZATION-red',
          metadata: {
            inline_attachments: [{ type: 'file', id: 0, name: 'chip.md', url: 'http://fleet/api/file?path=/uploads/chip.md' }],
            recipient_refs: {
              'fleet:dev': {
                attachments: {
                  0: { state: 'available', localPath: '/tmp/inbox-refs/chip.md' },
                },
              },
            },
          },
        }],
      }
    },
    requestJson: async (base, urlPath, options = {}) => {
      if (urlPath === '/api/projects') return { status: 201, body: { ok: true } }
      if (urlPath.endsWith('/source-authority')) return { status: 200, body: { currentRevision: null } }
      if (urlPath.endsWith('/push')) return { status: 200, body: { ok: true } }
      if (urlPath.endsWith('/parts')) return { status: 200, body: { ok: true, outputFile: 'parts/chip.html' } }
      if (options.method === 'DELETE') return { status: 200, body: { ok: true } }
      throw new Error(`setup failed: unexpected ${urlPath}`)
    },
    requestText: async (base, urlPath) => {
      if (urlPath.startsWith('/api/file')) return '# Chip\n\nDEV-BOT-FILE-MATERIALIZATION-red\n'
      if (urlPath.startsWith('/docs/')) return '<html><body>missing</body></html>'
      throw new Error(`setup failed: unexpected ${urlPath}`)
    },
    uuid: (() => {
      const values = ['red', 'redprojx', 'senderx', 'namexx']
      return () => values.shift()
    })(),
    now: () => 1_000,
    sleepMs: async () => {},
  }),
  /missing marker/,
)

const strayDir = await mkdtemp(path.join(tmpdir(), 'devbot-red-cleanup-'))
const strayPath = path.join(strayDir, 'tlda-devbot-red-stray-preview')
await mkdir(strayPath)
const cleanup = await checkResourceCleanup({
  previewReaper: () => {
    rmSync(strayPath, { recursive: true, force: true })
    return { reaped: [{ path: strayPath, prefix: 'tlda-devbot-red-stray' }], failed: [] }
  },
  playwrightCleanup: { sweep: async () => [] },
  worktreeCleanupDriver: { sweep: async () => ({
    totalBytes: 0,
    retainedBytes: 0,
    overBudgetBytes: 0,
    removedWorktrees: [],
    evicted: [],
    pinned: [],
    abandoned: [],
    unremovable: [],
  }) },
  now: () => 1,
})
let strayStillExists = true
try {
  await stat(strayPath)
} catch {
  strayStillExists = false
}
if (cleanup.previews.reaped !== 1 || strayStillExists) {
  lines.push(`not red - 9 resource cleanup: reaped=${cleanup.previews.reaped}, strayStillExists=${strayStillExists}`)
  failures += 1
} else {
  lines.push(`RED - 9 resource cleanup: prefixed stray cleaned and counted, previews.reaped=${cleanup.previews.reaped}`)
}

const blocked = await runChecks({
  checks: [
    ['bot-heartbeats', async () => ({ blocked: true, reason: 'synthetic missing heartbeat instrument' })],
  ],
})
if (!blocked.blocked.includes('bot-heartbeats:synthetic missing heartbeat instrument')) {
  lines.push(`not red - blocked path: ${JSON.stringify(blocked.blocked)}`)
  failures += 1
} else {
  lines.push(`RED - blocked path: ${blocked.blocked[0]}`)
}

console.error(lines.join('\n'))
if (failures) process.exit(2)
console.error('red proof complete: deliberate failures detected; exiting 1 so this cannot be mistaken for a green suite')
process.exit(1)
