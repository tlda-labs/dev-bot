#!/usr/bin/env node
/**
 * dev bot — testing-environment noticer.
 *
 * Watches the testing fleet/store surface with real behavioral probes. Healthy
 * testing stays silent; failures nudge dev agents in fleet chat. It also runs
 * the existing dev-resource reaper and retires idle managed Playwright pools.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'

import {
  CONFIG_DIR,
  configTypes,
  createBot,
  defineConfig,
  getActiveEnvName,
  getFleetServerUrl,
  getManagedBotEnvironments,
  getManagedBots,
  getServerUrl,
  parseConfig,
} from '@tlda/bot'
import { labelsForAgent, reapIdlePreviews } from '@tlda/bot'
import { createPlaywrightPoolCleanup, createWorktreeCleanup } from './resource-cleanup.mjs'
import { checkServerImports, describeServerImportFailures } from './server-import-resolution.mjs'
import { createGitRemoteProbeDriver, runLinkedRemoteProbe } from './linked-remote-probe.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const BOT_KEY = (process.env.TLDA_BOT_NAME || 'dev').toLowerCase()
const AGENT_NAME = BOT_KEY
const PID_FILE = process.env.TLDA_BOT_PIDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.pid`)
const HEARTBEAT_FILE = process.env.TLDA_BOT_HEARTBEAT || path.join(CONFIG_DIR, `${BOT_KEY}.heartbeat`)
const ID_FILE = process.env.TLDA_BOT_IDFILE || path.join(CONFIG_DIR, `${BOT_KEY}.fleet-id`)
const OWNER_ID = 'fleet:skip'

const MY_BOT = getManagedBots().find(b => String(b.name || '').toLowerCase() === BOT_KEY) || {}
const CONFIG_NAME = getActiveEnvName(MY_BOT.environment)
const FLEET_SERVER = getFleetServerUrl(MY_BOT.environment)
const STORE_SERVER = getServerUrl(MY_BOT.environment)
const WS_URL = FLEET_SERVER.replace(/^http/, 'ws') + '/ws/fleet'
const BOT_ENVIRONMENTS = getManagedBotEnvironments()
const ALLOWED_ENVIRONMENTS = Object.entries(BOT_ENVIRONMENTS)
  .filter(([, members]) => members.some(member => String(member).toLowerCase() === BOT_KEY))
  .map(([envName]) => envName)

const positive = value => value > 0
export const configSchema = defineConfig({
  intervalMs: { env: 'TLDA_DEV_BOT_INTERVAL_MS', default: 60_000, description: 'Behavioral probe interval in milliseconds.', parse: configTypes.integer, validate: positive },
  failureCooldownMs: { env: 'TLDA_DEV_BOT_FAILURE_COOLDOWN_MS', default: 300_000, description: 'Minimum interval between identical failure notices.', parse: configTypes.integer, validate: positive },
  requestTimeoutMs: { env: 'TLDA_DEV_BOT_REQUEST_TIMEOUT_MS', default: 15_000, description: 'Fleet and HTTP request timeout in milliseconds.', parse: configTypes.integer, validate: positive },
  spawnWakeIntervalMs: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_INTERVAL_MS', default: 1_800_000, description: 'Spawn/wake probe cadence in milliseconds.', parse: configTypes.integer, validate: positive },
  spawnWakeTimeoutMs: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_TIMEOUT_MS', default: 180_000, description: 'Overall spawn/wake probe deadline.', parse: configTypes.integer, validate: positive },
  spawnWakeEnabled: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_ENABLED', default: false, description: 'Whether the mutating disposable core phi probe runs after shadow verification.', parse: configTypes.boolean },
  spawnWakeModel: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_MODEL', default: '', description: 'Optional model override for the disposable probe agent.', parse: configTypes.string },
  linkedRemoteEnabled: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_ENABLED', default: false, description: 'Whether to exercise the disposable linked Git remote.', parse: configTypes.boolean },
  linkedRemoteIntervalMs: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_INTERVAL_MS', default: 1_800_000, description: 'Linked remote safety probe cadence in milliseconds.', parse: configTypes.integer, validate: positive },
  linkedRemoteUrl: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_URL', default: '', description: 'Reachable disposable Git remote URL used instead of the local Git daemon fixture.', parse: configTypes.string },
  linkedRemoteTokenFile: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_TOKEN_FILE', default: '', description: 'File containing the disposable Git remote token.', parse: configTypes.string },
  linkedRemoteHost: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_HOST', default: '', description: 'Tailnet address advertised by the disposable Git remote.', parse: configTypes.string },
  linkedRemotePort: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_PORT', default: 19_418, description: 'Port for the disposable Git remote.', parse: configTypes.integer, validate: positive },
  probeDoc: { env: 'TLDA_DEV_BOT_DOC', default: '', description: 'Optional project selected for the SVG load probe.', parse: configTypes.string },
  assetPathOverride: { env: 'TLDA_DEV_BOT_ASSET_PATH_OVERRIDE', default: '', description: 'Optional exact SVG asset path for the document probe.', parse: configTypes.string },
  allowNondefault: { env: 'TLDA_DEV_BOT_ALLOW_NONDEFAULT', default: false, description: 'Permit probing an environment not assigned to this bot.', parse: configTypes.boolean },
  nudgeTo: { env: 'TLDA_DEV_BOT_NUDGE_TO', default: '', description: 'Exact failure-notice recipient override.', parse: configTypes.string },
  nudgeLabel: { env: 'TLDA_DEV_BOT_NUDGE_LABEL', default: 'on-call', description: 'Fleet label used to select failure-notice recipients.', parse: configTypes.string },
  nudgeOnSetup: { env: 'TLDA_DEV_BOT_NUDGE_SETUP', default: false, description: 'Send notices for probe setup failures.', parse: configTypes.boolean },
  nudgeDryRun: { env: 'TLDA_DEV_BOT_NUDGE_DRY_RUN', default: false, description: 'Record but do not send failure notices.', parse: configTypes.boolean },
  resourceCleanupIntervalMs: { env: 'TLDA_DEV_BOT_RESOURCE_CLEANUP_INTERVAL_MS', default: 60_000, description: 'Playwright cleanup cadence.', parse: configTypes.integer, validate: positive },
  worktreeCleanupIntervalMs: { env: 'TLDA_DEV_BOT_WORKTREE_CLEANUP_INTERVAL_MS', default: 3_600_000, description: 'Worktree cleanup cadence.', parse: configTypes.integer, validate: positive },
  statusFile: { env: 'TLDA_DEV_BOT_STATUS_FILE', default: 'dev-bot-status.md', description: 'Project-relative volatile status Markdown path.', parse: configTypes.string },
  agentSilenceWindowMs: { env: 'TLDA_DEV_BOT_AGENT_SILENCE_WINDOW_MS', default: 7_200_000, description: 'How long an agent may hold a delivered message without producing anything before it is reported silent.', parse: configTypes.integer, validate: positive },
  agentSilenceLookbackMs: { env: 'TLDA_DEV_BOT_AGENT_SILENCE_LOOKBACK_MS', default: 86_400_000, description: 'How far back to look for the delivery that an agent is silent on.', parse: configTypes.integer, validate: positive },
  agentWatchIntervalMs: { env: 'TLDA_DEV_BOT_AGENT_WATCH_INTERVAL_MS', default: 300_000, description: 'Cadence for the agent silence check, which costs one whole-roster read.', parse: configTypes.integer, validate: positive },
  serverImportsRepo: { env: 'TLDA_DEV_BOT_SERVER_IMPORTS_REPO', default: '', description: 'tlda checkout whose server boot path is checked against the shipped dependency manifest. Empty disables the check.', parse: configTypes.string },
  serverImportsIntervalMs: { env: 'TLDA_DEV_BOT_SERVER_IMPORTS_INTERVAL_MS', default: 600_000, description: 'Cadence for the server import resolution check.', parse: configTypes.integer, validate: positive },
  botHeartbeatStaleMs: { env: 'TLDA_DEV_BOT_BOT_HEARTBEAT_STALE_MS', default: 900_000, description: 'How long a bot declared for this environment may go without writing a heartbeat before it is reported inert.', parse: configTypes.integer, validate: positive },
  daemonLedgerDb: { env: 'TLDA_DEV_BOT_DAEMON_LEDGER_DB', default: path.join(CONFIG_DIR, 'fleet-daemon.db'), description: 'Daemon permission_grants ledger, read to say whether a silent agent can be placed by the daemon at all.', parse: configTypes.string },
  rosterTimeoutMs: { env: 'TLDA_DEV_BOT_ROSTER_TIMEOUT_MS', default: 90_000, description: 'Timeout for a whole-roster read, which is far slower than an ordinary fleet request.', parse: configTypes.integer, validate: positive },
})
const config = parseConfig(configSchema)
const {
  intervalMs: INTERVAL_MS, failureCooldownMs: FAILURE_COOLDOWN_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS,
  spawnWakeIntervalMs: SPAWN_WAKE_INTERVAL_MS, spawnWakeTimeoutMs: SPAWN_WAKE_TIMEOUT_MS,
  spawnWakeEnabled: SPAWN_WAKE_ENABLED, spawnWakeModel: SPAWN_WAKE_MODEL, probeDoc: PROBE_DOC,
  linkedRemoteEnabled: LINKED_REMOTE_ENABLED, linkedRemoteIntervalMs: LINKED_REMOTE_INTERVAL_MS,
  linkedRemoteUrl: LINKED_REMOTE_URL, linkedRemoteTokenFile: LINKED_REMOTE_TOKEN_FILE,
  linkedRemoteHost: LINKED_REMOTE_HOST, linkedRemotePort: LINKED_REMOTE_PORT,
  assetPathOverride: ASSET_PATH_OVERRIDE, allowNondefault: ALLOW_NONDEFAULT, nudgeTo: NUDGE_TO_OVERRIDE,
  nudgeLabel: NUDGE_LABEL, nudgeOnSetup: NUDGE_ON_SETUP, nudgeDryRun: NUDGE_DRY_RUN,
  resourceCleanupIntervalMs: RESOURCE_CLEANUP_INTERVAL_MS, worktreeCleanupIntervalMs: WORKTREE_CLEANUP_INTERVAL_MS,
  agentSilenceWindowMs: AGENT_SILENCE_WINDOW_MS, agentSilenceLookbackMs: AGENT_SILENCE_LOOKBACK_MS,
  agentWatchIntervalMs: AGENT_WATCH_INTERVAL_MS, rosterTimeoutMs: ROSTER_TIMEOUT_MS,
  serverImportsRepo: SERVER_IMPORTS_REPO, serverImportsIntervalMs: SERVER_IMPORTS_INTERVAL_MS,
  daemonLedgerDb: DAEMON_LEDGER_DB, botHeartbeatStaleMs: BOT_HEARTBEAT_STALE_MS,
} = config
const DAEMON_KEY = process.env.FLEET_DAEMON_KEY || `${process.env.TLDA_BOT_MACHINE_ID || process.env.TLDA_MACHINE_ID || ''}:${CONFIG_NAME}`

if (!ALLOW_NONDEFAULT && !ALLOWED_ENVIRONMENTS.includes(CONFIG_NAME)) {
  throw new Error(`dev bot only probes configured environments ${JSON.stringify(ALLOWED_ENVIRONMENTS)}; active config is "${CONFIG_NAME}"`)
}
for (const url of [FLEET_SERVER, STORE_SERVER]) {
  if (/stable/i.test(new URL(url).hostname)) {
    throw new Error(`dev bot refuses to probe stable-looking server: ${url}`)
  }
}

const AGENT_ID = `fleet:${BOT_KEY}`
let bot = null
let sweepTimer = null
let sweepInFlight = false
// A standing failure is raised once and then repeated on a widening interval.
// The old shape re-raised the identical sentence every FAILURE_COOLDOWN_MS
// forever: on 2026-08-08 `grammar` was down with nobody able to recover it and
// the same paragraph arrived many times in half an hour. That is precisely how
// an alarm gets muted, and muting is how this bot's round-trip check died for
// ten days -- so the repeat is the danger, not the alarm.
//
// A CHANGED summary is a new fact and raises immediately. An unchanged one says
// "still failing, unchanged for N minutes" and backs off.
const FAILURE_REPEAT_SCHEDULE_MS = [5, 10, 20, 40, 60].map(minutes => minutes * 60_000)
let activeFailure = null // { key, firstAt, lastNudgeAt, repeats, summary }

// Restored from the heartbeat at startup, because this state decides two things
// that a restart otherwise silently gets wrong: the backoff resets to five
// minutes, and -- worse -- a failure that clears while the bot is restarting is
// never announced, because the new process has no memory of having raised it.
//
// That happened on 2026-08-08: `grammar` went down, was nudged, and recovered
// across a restart of this bot. Nobody was told it cleared, and I had already
// promised on-call that they would be. A recovery notice that a restart can eat
// is not a recovery notice, and this bot restarts often.
//
// The heartbeat is append-only and already carries every field needed, so this
// reads it rather than adding a second state file to disagree with it. Only the
// tail is read; the file is megabytes.
function restoreActiveFailure() {
  let tail
  try {
    const { size } = fs.statSync(HEARTBEAT_FILE)
    const start = Math.max(0, size - 256 * 1024)
    const fd = fs.openSync(HEARTBEAT_FILE, 'r')
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    fs.closeSync(fd)
    tail = buffer.toString('utf8')
  } catch {
    return null
  }
  for (const line of tail.split('\n').reverse()) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // A truncated first line from the offset read, or a partial append.
      continue
    }
    if (entry.reason === 'recovered') return null
    if (entry.reason !== 'failure-nudged' || !entry.summary) continue
    const at = Date.parse(entry.ts)
    if (!Number.isFinite(at)) return null
    return {
      key: entry.summary,
      summary: entry.summary,
      firstAt: at - (Number(entry.standingForMin) || 0) * 60_000,
      lastNudgeAt: at,
      repeats: Number(entry.repeats) || 0,
    }
  }
  return null
}
const playwrightPoolCleanup = createPlaywrightPoolCleanup()
const worktreeCleanup = createWorktreeCleanup()
let resourceCleanupTimer = null
let resourceCleanupInFlight = false
let lastWorktreeCleanupAt = 0
const statusSamples = []

class ProbeSetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeSetupError'
  }
}

class ProbeIndeterminateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeIndeterminateError'
  }
}

function writeHeartbeat(reason, detail = {}) {
  try {
    fs.appendFileSync(HEARTBEAT_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      bot: BOT_KEY,
      reason,
      config: CONFIG_NAME,
      fleet: FLEET_SERVER,
      store: STORE_SERVER,
      ...detail,
    }) + '\n')
  } catch (e) {
    // Best-effort telemetry; probe state still goes to process logs.
    console.error(`[dev-bot] heartbeat write failed: ${e.message}`)
  }
}

function sendRequest(msg, timeoutMs = REQUEST_TIMEOUT_MS) {
  return bot.request(msg, timeoutMs)
}

async function fetchJson(base, urlPath, { method = 'GET', body = undefined } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${urlPath} returned HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch (e) {
    throw new Error(`${method} ${urlPath} returned invalid JSON: ${e.message}`)
  }
}

async function fetchJsonMaybe(base, urlPath, { method = 'GET', body = undefined, okStatuses = [] } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new Error(`${method} ${urlPath} returned HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  }
  try {
    return { status: res.status, body: text ? JSON.parse(text) : {} }
  } catch (e) {
    throw new Error(`${method} ${urlPath} returned invalid JSON: ${e.message}`)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function basenameNoExt(file) {
  return String(file || '').replace(/\.tex$/i, '').split('/').pop()
}

function projectIsUsableSvg(project) {
  const format = project?.format || 'svg'
  return format === 'svg' && Number(project?.pages) > 0 && project?.buildStatus !== 'building'
}

async function checkDocumentLoads() {
  const listed = await fetchJson(STORE_SERVER, '/api/projects')
  const projects = Array.isArray(listed?.projects) ? listed.projects : []
  const candidate = PROBE_DOC
    ? { name: PROBE_DOC }
    : projects.find(projectIsUsableSvg)
  if (!candidate?.name) throw new Error('no built svg project with pages > 0 found on testing store')

  const project = await fetchJson(STORE_SERVER, `/api/projects/${encodeURIComponent(candidate.name)}`)
  if (!projectIsUsableSvg(project)) {
    throw new Error(`project ${candidate.name} is not a ready svg doc (format=${project?.format || 'svg'} pages=${project?.pages || 0} buildStatus=${project?.buildStatus || 'unknown'})`)
  }
  const target = Array.isArray(project.targets) && project.targets.length
    ? project.targets[0]
    : { texBase: basenameNoExt(project.mainFile) || project.name }
  const assetPath = ASSET_PATH_OVERRIDE || `/docs/${encodeURIComponent(project.name)}/${encodeURIComponent(target.texBase)}-page-1.svg`
  const res = await fetch(`${STORE_SERVER}${assetPath}?t=${Date.now()}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await res.text()
  if (!res.ok) throw new Error(`doc asset ${assetPath} returned HTTP ${res.status}`)
  if (!/<svg[\s>]/i.test(text.slice(0, 1000))) throw new Error(`doc asset ${assetPath} did not return SVG content`)
  return { doc: project.name, assetPath, bytes: text.length }
}

let lastSpawnWakeProbeAt = 0
let spawnWakeProbeInFlight = false
let lastLinkedRemoteProbeAt = 0
let linkedRemoteProbeInFlight = false

export async function checkLinkedRemoteSafety({ force = false } = {}) {
  if (!LINKED_REMOTE_ENABLED && !force) return { skipped: true, reason: 'disabled' }
  if (linkedRemoteProbeInFlight) return { skipped: true, reason: 'previous probe still in flight' }
  const now = Date.now()
  if (!force && lastLinkedRemoteProbeAt && now - lastLinkedRemoteProbeAt < LINKED_REMOTE_INTERVAL_MS) {
    return { skipped: true, reason: 'cadence', nextAt: new Date(lastLinkedRemoteProbeAt + LINKED_REMOTE_INTERVAL_MS).toISOString() }
  }
  linkedRemoteProbeInFlight = true
  lastLinkedRemoteProbeAt = now
  let driver
  try {
    driver = await createGitRemoteProbeDriver({
      storeServer: STORE_SERVER,
      fixtureRoot: path.join(CONFIG_DIR, `${BOT_KEY}.${CONFIG_NAME}.linked-remote-probe`),
      remoteUrl: LINKED_REMOTE_URL || undefined,
      remoteToken: LINKED_REMOTE_TOKEN_FILE ? fs.readFileSync(LINKED_REMOTE_TOKEN_FILE, 'utf8').trim() : undefined,
      remoteHost: LINKED_REMOTE_HOST || undefined,
      remotePort: LINKED_REMOTE_PORT,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })
    return await runLinkedRemoteProbe({ driver })
  } finally {
    driver?.close()
    linkedRemoteProbeInFlight = false
  }
}

// A disposable sender needs a disposable connection, not just a disposable id.
// `reserve-shell` and `login` both do `agentFleetConnections.set(id, ws)` and
// `ws._tldaAgentId = id` on whichever socket sent them (unified-server.mjs:5657
// and :5816). `sendRequest` is `bot.request` — the dev bot's one long-lived
// connection — so registering the probe through it relabels this bot's own
// socket as the throwaway probe and leaves it that way: from the next sweep on,
// `hasOpenFleetSocketForAgent('fleet:dev')` is false, and the disconnect cleanup
// at :4962 removes only the probe's entry and strands this bot's. The
// pre-5539b47 version did exactly that. A health check must not corrupt the
// identity of the thing running it.
function openProbeConnection(timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const pending = new Map()
    let msgId = 1
    const openTimer = setTimeout(() => {
      ws.close()
      reject(new ProbeSetupError(`probe connection to ${WS_URL} did not open within ${timeoutMs}ms`))
    }, timeoutMs)
    ws.addEventListener('message', ev => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        // Non-JSON frames are broadcast noise this short-lived socket never reads.
        return
      }
      if (!msg.id || !pending.has(msg.id)) return
      const { res, rej, timer } = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) rej(new Error(typeof msg.error === 'string' ? msg.error : (msg.error.message || JSON.stringify(msg.error))))
      else res(msg.result)
    })
    ws.addEventListener('error', () => {
      clearTimeout(openTimer)
      reject(new ProbeSetupError(`probe connection to ${WS_URL} failed`))
    })
    ws.addEventListener('open', () => {
      clearTimeout(openTimer)
      resolve({
        request(msg, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
          return new Promise((res, rej) => {
            const rid = msgId++
            const timer = setTimeout(() => {
              pending.delete(rid)
              rej(new Error(`${msg?.type || 'ws request'} timed out after ${requestTimeoutMs}ms`))
            }, requestTimeoutMs)
            pending.set(rid, { res, rej, timer })
            ws.send(JSON.stringify({ id: rid, ...msg }))
          })
        },
        close: () => ws.close(),
      })
    })
  })
}

// Restored from 5539b47^, unchanged in shape. The read-back is the whole point:
// the send's own return value is not evidence the message arrived, and last
// night's failures were precisely sends reported as delivered that never landed.
// Anything that trusts `sent` and skips the history poll is not this check.
async function checkMessageRoundTrip() {
  const senderId = `fleet:dev-probe-${randomUUID().slice(0, 8)}`
  const senderName = `dev-probe-${randomUUID().slice(0, 6)}`
  const token = `dev-probe:${randomUUID()}`
  let sender = null
  let senderRegistered = false
  try {
    sender = await openProbeConnection()
    const payload = {
      agent_id: senderId,
      name: senderName,
      cwd: REPO_ROOT,
      labels: ['dev-probe'],
      metadata: { bot_probe: BOT_KEY, disposable: true },
    }
    await sender.request({ ...payload, type: 'reserve-shell' })
    await sender.request({ ...payload, type: 'login' })
    senderRegistered = true
    let sent
    try {
      sent = await sender.request({ type: 'chat', from: senderId, to: AGENT_ID, message: token, _tempId: token }, REQUEST_TIMEOUT_MS)
    } catch (e) {
      if (/No recipients matched/i.test(e?.message || '')) {
        throw new ProbeSetupError(`round-trip bot recipient was not reachable (${AGENT_ID})`)
      }
      throw e
    }
    const ackEventIds = Array.isArray(sent?.event_ids) ? sent.event_ids : []
    if (!ackEventIds.length) throw new Error('chat send did not return an accepted event id')
    // `since` is mandatory, not a tidiness detail. Unbounded, `limit: 30` comes
    // back from the beginning of this agent's retained history — July, for this
    // bot — and can never contain the message just sent, so the check would fail
    // every sweep while delivery was perfectly healthy. The margin absorbs clock
    // skew between this host and the server that stamps the row.
    const since = new Date(Date.now() - 60_000).toISOString()
    const deadline = Date.now() + REQUEST_TIMEOUT_MS
    while (Date.now() < deadline) {
      // The original read back through `chat-history`. That message type no
      // longer exists; `fleet-search` is what serves thread() now, so the poll
      // moves to it and the shape is unchanged — an independent read of the
      // recipient's own history, never a re-inspection of the send's own ack.
      const history = await sendRequest({
        type: 'fleet-search',
        query: '',
        me: AGENT_ID,
        agent: AGENT_ID,
        agentOnly: true,
        historyOnly: true,
        eventOnly: true,
        eventType: 'chat',
        since,
        limit: 30,
      }, 5000)
      const events = (Array.isArray(history?.results) ? history.results : []).filter(r => r.source === 'fleet')
      const found = events.find(event =>
        (event.text || event.message) === token ||
        ackEventIds.includes(Number(event.id || event.event_id)),
      )
      if (found) return { senderId, recipientId: AGENT_ID, eventId: found.id || found.event_id || null }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('accepted chat did not arrive in dev bot chat history')
  } finally {
    if (senderRegistered) {
      try {
        await sender.request({ type: 'mark-dead', agent: senderId }, 5000)
      } catch (e) {
        // Best-effort cleanup; failure is visible in logs for manual sweep.
        console.error(`[dev-bot] disposable sender cleanup failed for ${senderId}: ${e.message}`)
      }
    }
    sender?.close()
  }
}

function metadataOf(agent) {
  const meta = agent?.metadata || {}
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta)
    } catch {
      return {}
    }
  }
  return meta && typeof meta === 'object' ? meta : {}
}

async function resolveAgent(agent) {
  const result = await sendRequest({ type: 'resolve-agent', agent }, REQUEST_TIMEOUT_MS)
  return result?.agent || null
}

async function readAgentSeat(agentId) {
  const result = await fetchJsonMaybe(FLEET_SERVER, `/api/agent-seat?agent=${encodeURIComponent(agentId)}`, { okStatuses: [404] })
  if (result.status === 404) return null
  return result.body?.seat || null
}

async function waitForSpawnReady(agentId, deadline) {
  let lastAgent = null
  let lastSeat = null
  while (Date.now() < deadline) {
    lastAgent = await resolveAgent(agentId)
    if (lastAgent && !lastAgent.dead && metadataOf(lastAgent).shell !== true) {
      lastSeat = await readAgentSeat(agentId)
      if (lastSeat?.session_id && lastSeat?.daemon_key && lastSeat?.terminal_capability) {
        return { agent: lastAgent, seat: lastSeat }
      }
    }
    await sleep(1000)
  }
  if (!lastAgent) throw new ProbeIndeterminateError(`spawn mailbox did not produce a roster row for ${agentId}`)
  if (metadataOf(lastAgent).shell === true) throw new ProbeIndeterminateError(`spawn mailbox reserved ${agentId}, but the process never logged in`)
  throw new ProbeIndeterminateError(`spawned agent ${agentId} logged in without a complete current durable seat`)
}

async function waitForControlTrace(traceId, predicate, deadline) {
  let lastTrace = null
  while (Date.now() < deadline) {
    const data = await fetchJson(FLEET_SERVER, `/api/diagnostics/control-plane-traces?trace_id=${encodeURIComponent(traceId)}&limit=100`)
    lastTrace = data?.trace || null
    const events = Array.isArray(lastTrace?.events) ? lastTrace.events : []
    const found = events.find(predicate)
    if (found) return { trace: lastTrace, event: found }
    await sleep(500)
  }
  const summary = Array.isArray(lastTrace?.events)
    ? lastTrace.events.map(e => `${e.operation}:${e.status}${e.error ? `:${e.error}` : ''}`).join(', ')
    : 'no retained trace'
  throw new ProbeIndeterminateError(`wake trace ${traceId} did not reach a terminal outcome (${summary})`)
}

async function cleanupSpawnWakeProbe({ agentId, taskId }) {
  if (taskId) {
    try {
      await sendRequest({ type: 'remove-task', task_id: taskId }, 5000)
    } catch (e) {
      console.error(`[dev-bot] disposable task cleanup failed for ${taskId}: ${e.message}`)
    }
  }
  if (agentId) {
    try {
      await sendRequest({ type: 'kill-session', agent: agentId }, 10_000)
    } catch (e) {
      console.error(`[dev-bot] disposable session cleanup failed for ${agentId}: ${e.message}`)
    }
    try {
      await sendRequest({ type: 'mark-dead', agent: agentId }, 5000)
    } catch (e) {
      console.error(`[dev-bot] disposable agent cleanup failed for ${agentId}: ${e.message}`)
    }
  }
}

export async function checkSpawnWakeSeat({
  request = sendRequest,
  waitReady = waitForSpawnReady,
  waitTrace = waitForControlTrace,
  cleanup = cleanupSpawnWakeProbe,
  uuid = randomUUID,
  now = () => Date.now(),
  force = false,
} = {}) {
  if (!SPAWN_WAKE_ENABLED && !force) {
    return { skipped: true, reason: 'disabled' }
  }
  if (spawnWakeProbeInFlight) {
    return { skipped: true, reason: 'previous probe still in flight' }
  }
  const startedAt = now()
  if (!force && lastSpawnWakeProbeAt && startedAt - lastSpawnWakeProbeAt < SPAWN_WAKE_INTERVAL_MS) {
    return { skipped: true, reason: 'cadence', nextAt: new Date(lastSpawnWakeProbeAt + SPAWN_WAKE_INTERVAL_MS).toISOString() }
  }

  spawnWakeProbeInFlight = true
  lastSpawnWakeProbeAt = startedAt
  let agentId = null
  let taskId = null
  const deadline = startedAt + SPAWN_WAKE_TIMEOUT_MS
  const suffix = uuid().slice(0, 8)
  const name = `dev-probe-seat-${suffix}`
  const terminalToken = `dev-terminal-probe:${uuid()}`
  const wakeToken = `dev-wake-probe:${uuid()}`
  try {
    const spawn = await request({
      type: 'spawn',
      fresh: true,
      name,
      cwd: REPO_ROOT,
      mailboxTarget: AGENT_ID,
      ...(SPAWN_WAKE_MODEL ? { model: SPAWN_WAKE_MODEL } : {}),
    }, REQUEST_TIMEOUT_MS)
    if (!spawn?.ok || spawn.status !== 'pending' || !spawn.agent_id || !spawn.mailbox_id) {
      throw new ProbeIndeterminateError(`spawn did not return a pending mailbox with agent_id (${JSON.stringify(spawn)})`)
    }
    agentId = spawn.agent_id

    const { seat } = await waitReady(agentId, deadline)
    const alive = await request({ type: 'check-alive', agent: agentId }, REQUEST_TIMEOUT_MS)
    if (alive?.state !== 'alive') {
      throw new Error(`spawned agent ${agentId} is not alive after seat binding (state=${alive?.state || 'unknown'} reason=${alive?.reason || 'none'})`)
    }

    await request({ type: 'send-text', agent: agentId, text: terminalToken, enter: false }, REQUEST_TIMEOUT_MS)
    const capture = await request({ type: 'capture-pane', agent: agentId, lines: 20 }, REQUEST_TIMEOUT_MS)
    if (!String(capture?.content || '').includes(terminalToken)) {
      throw new Error(`terminal route for ${agentId} accepted send-text but capture-pane did not show the probe token`)
    }

    const initialInbox = await request({ type: 'my-task', agent: agentId, peek: true }, REQUEST_TIMEOUT_MS)
    if (!initialInbox || typeof initialInbox !== 'object') {
      throw new Error(`spawned agent ${agentId} logged in but inbox did not return a response`)
    }

    const hibernated = await request({ type: 'hibernate-session', agent: agentId }, REQUEST_TIMEOUT_MS)
    if (!hibernated?.ok) {
      throw new Error(`hibernate did not confirm session shutdown for ${agentId}`)
    }

    const delegate = await request({
      type: 'delegate',
      from: AGENT_ID,
      agent: agentId,
      description: `dev bot wake probe ${suffix}`,
      message: wakeToken,
      operation_id: `dev-bot-spawn-wake:${suffix}`,
    }, REQUEST_TIMEOUT_MS)
    taskId = delegate?.task_id || null
    if (!delegate?.ok || !delegate.trace_id || !taskId) {
      throw new ProbeIndeterminateError(`delegate wake did not return task and trace evidence (${JSON.stringify(delegate)})`)
    }
    const trace = await waitTrace(delegate.trace_id, event => {
      if (event.operation === 'wake.noop' && event.status === 'already-awake') return true
      if (event.operation === 'wake.respawn' && event.status === 'sent') return true
      if (event.operation === 'wake.error' || event.status === 'failed') return true
      return false
    }, deadline)
    if (trace.event.operation === 'wake.error' || trace.event.status === 'failed') {
      throw new Error(`wake routing failed for ${agentId}: ${trace.event.error || JSON.stringify(trace.event.detail || {})}`)
    }

    const resumed = await waitReady(agentId, deadline)
    const resumedAlive = await request({ type: 'check-alive', agent: agentId }, REQUEST_TIMEOUT_MS)
    if (resumedAlive?.state !== 'alive') {
      throw new Error(`woken agent ${agentId} did not restore a live logged-in session (state=${resumedAlive?.state || 'unknown'})`)
    }

    const inbox = await request({ type: 'my-task', agent: agentId, peek: true }, REQUEST_TIMEOUT_MS)
    const sawTask = inbox?.task?.id === taskId || (Array.isArray(inbox?.tasks) && inbox.tasks.some(task => task.id === taskId))
    const sawMessage = Array.isArray(inbox?.messages) && inbox.messages.some(message => message.task_id === taskId || message.text === wakeToken)
    if (!sawTask || !sawMessage) {
      throw new Error(`spawned agent inbox did not contain delegated wake task/message for ${agentId}`)
    }

    return {
      agentId,
      mailboxId: spawn.mailbox_id,
      seat: {
        sessionId: seat.session_id,
        daemonKey: seat.daemon_key,
      },
      resumedSeat: {
        sessionId: resumed.seat.session_id,
        daemonKey: resumed.seat.daemon_key,
      },
      hibernated: true,
      wake: trace.event.status,
      taskId,
    }
  } finally {
    await cleanup({ agentId, taskId })
    spawnWakeProbeInFlight = false
  }
}

// ---- Agents that have stopped ----
//
// Both checks below live entirely outside the agent they are about. That is the
// requirement, not a preference: when an agent's MCP client wedges or never
// initialises, nothing the agent can do will report it — every self-report path
// is the path that broke. So the evidence is server-side state only.
//
// Three independent facts about one agent, all on the fleet table row:
//   last_seen      the daemon watching the process   -> the process is up
//   activity_at    the agent's own MCP client        -> when it last reached us
//   fleet_socket_open  the server's socket registry  -> is the client attached
//
// `activity_at` and `fleet_socket_open` were added to the row for these checks
// (tlda 99a308836). An older server omits them and the checks say so rather
// than reading the absence as a healthy answer.

// Whether the daemon can PLACE this agent — whether it has a row in the
// permission_grants ledger for this daemon key. `resolveTerminalAgent` reads
// that table to answer "which tmux session does this agent own", so an agent
// with no row is unreachable by every daemon terminal operation: kill, restart,
// send-text, capture. `rpcKillSession` then answers `{ ok: true,
// already_unavailable: true }`, which is right for a hibernate and a lie for a
// restart, so the CLI prints ok and nothing happens.
//
// It is a third fact beside the two the check already reads, in the message
// rather than as its own alarm: it turns "this agent is silent" into "this agent
// is silent and nobody can restart it", which is the difference between a nudge
// and an escalation. On 2026-08-08 `math-delivery-oncall` and
// `really-able-to-do-stuff` both had no row while 2,057 existed for mini:testing.
//
// Returns null on any failure — the ledger is the daemon's and this is a
// best-effort read. Null is "not measured", never "no row": reporting an agent
// as unplaceable because sqlite was busy would be a fabricated escalation.
function daemonCanPlace(agentId) {
  if (!DAEMON_LEDGER_DB || !DAEMON_KEY) return null
  try {
    const row = daemonLedger()?.prepare(
      'SELECT 1 FROM permission_grants WHERE id = ? AND daemon_key = ? LIMIT 1',
    ).get(agentId, DAEMON_KEY)
    return !!row
  } catch (e) {
    console.error(`[dev-bot] permission_grants read failed for ${agentId}: ${e.message}`)
    return null
  }
}

let _daemonLedger = null
let _daemonLedgerFailed = false
function daemonLedger() {
  if (_daemonLedger || _daemonLedgerFailed) return _daemonLedger
  try {
    _daemonLedger = new DatabaseSync(DAEMON_LEDGER_DB, { readOnly: true })
  } catch (e) {
    _daemonLedgerFailed = true
    console.error(`[dev-bot] cannot open daemon ledger ${DAEMON_LEDGER_DB}: ${e.message}`)
  }
  return _daemonLedger
}

function rowIsWatchable(row) {
  if (!row || row.human) return false
  if (row.id === AGENT_ID || row.id === OWNER_ID) return false
  if (row.id?.startsWith?.('fleet:dev-probe-')) return false
  return !(Array.isArray(row.labels) && row.labels.includes('bot'))
}

// A whole-roster read is NOT an ordinary fleet request and must not inherit the
// ordinary timeout. Measured against live testing on 2026-08-08, with 1,849
// alive agents and 14,040 total: `/api/fleet-table?limit=500` took 44.9, 44.5
// and 44.5 seconds on three consecutive warm calls, the `fleet-roster-truth` WS
// read 29.8s, and `agents-page` 42.1s. At the bot's 15s request timeout every
// one of these checks would have failed every sweep and nudged on-call about
// its own timeout -- an alarm crying during normal operation, which is the one
// outcome worse than no alarm. It is also why these checks run on their own
// cadence rather than once a minute.
async function fleetTableRows(filter) {
  const res = await fetch(`${FLEET_SERVER}/api/fleet-table?filter=${encodeURIComponent(filter)}&limit=500`, {
    signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`fleet-table (${filter}) returned HTTP ${res.status}`)
  const data = await res.json()
  return Array.isArray(data?.agents) ? data.agents : []
}

async function botSenderIds() {
  const rows = await fleetTableRows('bot')
  return new Set(rows.map(row => row.id).filter(Boolean))
}

// The agent's own most recent PRODUCED entry. Role 'assistant' is the point: a
// message delivered to an agent writes a `user` entry the moment it lands, so
// counting any entry would let the delivery itself stand as evidence that the
// agent reacted to the delivery.
async function lastProducedAt(agentId) {
  const result = await sendRequest({
    type: 'fleet-search', query: '', me: AGENT_ID, agent: agentId,
    historyOnly: true, role: 'assistant', limit: 1,
  }, 10_000)
  const rows = (Array.isArray(result?.results) ? result.results : []).filter(r => r.source === 'session')
  return rows[0]?.timestamp || null
}

// The most recent chat this agent RECEIVED from something that is not a bot and
// not itself. Bot senders are excluded by sender id, not by guessing at text:
// over three days of testing history, todd check-ins and build notices were 15
// of the 37 raw instances of this condition and every one of them was benign.
// An agent does not owe a bot nudge a reaction.
async function lastRealDeliveryTo(agentId, botIds, sinceIso) {
  const result = await sendRequest({
    type: 'fleet-search', query: '', me: AGENT_ID, agent: agentId, agentOnly: true,
    historyOnly: true, eventOnly: true, eventType: 'chat', since: sinceIso, limit: 50,
  }, 10_000)
  const rows = (Array.isArray(result?.results) ? result.results : []).filter(r => r.source === 'fleet')
  const received = rows.filter(row =>
    row.from && row.from !== agentId && !botIds.has(row.from) &&
    (Array.isArray(row.recipients) ? row.recipients.includes(agentId) : true))
  received.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
  return received[0] || null
}

// One roster read per cadence window. `lastResult` is replayed on a
// skipped sweep rather than reporting `skipped`, so a standing failure keeps
// failing between reads instead of alternating red/green every minute.
const agentWatchState = new Map()

function agentWatchDue(key) {
  const previous = agentWatchState.get(key)
  if (!previous) return true
  return Date.now() - previous.at >= AGENT_WATCH_INTERVAL_MS
}

function agentWatchReplay(key) {
  const previous = agentWatchState.get(key)
  if (!previous) return { skipped: true, reason: 'cadence' }
  if (previous.error) throw new Error(previous.error)
  return { ...previous.value, cached: true }
}

function agentWatchRecord(key, value, error) {
  agentWatchState.set(key, { at: Date.now(), value, error })
}

export async function checkAgentReceiving() {
  if (!agentWatchDue('receiving')) return agentWatchReplay('receiving')
  try {
    const result = await runAgentReceiving()
    agentWatchRecord('receiving', result, null)
    return result
  } catch (e) {
    agentWatchRecord('receiving', null, e?.message || String(e))
    throw e
  }
}

async function runAgentReceiving() {
  const rows = (await fleetTableRows('awake')).filter(rowIsWatchable)
  if (!rows.length) return { skipped: true, reason: 'no watchable awake agents' }

  // Cheap pre-filter: an agent whose client reached us inside the window is
  // demonstrably not silent, and asking the server about it is pure load.
  const hasActivityAt = rows.some(row => Object.hasOwn(row, 'activity_at'))
  const now = Date.now()
  const candidates = hasActivityAt
    ? rows.filter(row => {
      const at = Date.parse(row.activity_at || '')
      return !Number.isFinite(at) || now - at >= AGENT_SILENCE_WINDOW_MS
    })
    : rows

  const botIds = await botSenderIds()
  const sinceIso = new Date(now - AGENT_SILENCE_LOOKBACK_MS).toISOString()
  const silent = []
  // `filter=awake` IS the liveness gate. The runtime projection only calls an
  // agent awake when its evidence is `liveness: alive`, which comes from the
  // daemon's running-process snapshot -- so an agent in this list is one the
  // daemon reports as a live process, which is exactly the precondition.
  //
  // An earlier revision also required a fresh `last_seen`. That was wrong on the
  // data: on live testing every awake agent's `last_seen` read between 644s and
  // 2500s stale, including this bot mid-tool-call, so the gate rejected the one
  // true positive it existed to catch. `last_seen` is reported below as context
  // and is not a precondition.
  for (const row of candidates) {
    const delivery = await lastRealDeliveryTo(row.id, botIds, sinceIso)
    if (!delivery?.timestamp) continue
    const deliveredAt = Date.parse(delivery.timestamp)
    // Not yet decidable: the window has not elapsed since the delivery.
    if (!Number.isFinite(deliveredAt) || now - deliveredAt < AGENT_SILENCE_WINDOW_MS) continue
    const produced = await lastProducedAt(row.id)
    const producedAt = Date.parse(produced || '')
    if (Number.isFinite(producedAt) && producedAt > deliveredAt) continue
    silent.push({
      id: row.id,
      name: row.name || row.id,
      silentForMin: Math.round((now - deliveredAt) / 60_000),
      deliveredAt: delivery.timestamp,
      from: delivery.from,
      lastProducedAt: produced,
      lastClientCallAt: row.activity_at ?? null,
      lastSeenAgoS: row.last_seen_ago_s,
      activity: row.activity || null,
      tool: row.tool || null,
      placeable: daemonCanPlace(row.id),
    })
  }

  if (silent.length) {
    // Deliberately does not name a mechanism. Wedged client, dead harness, an
    // MCP that never initialised and a model stuck in a loop all present here
    // identically, and an alarm that guesses between them sends the reader to
    // the wrong place. Report the silence and the evidence; the pane says why.
    const lines = silent.map(entry => [
      `**${entry.name}** (\`${entry.id}\`) has produced nothing for ${entry.silentForMin} minutes.`,
      `- holding a message from \`${entry.from}\` delivered ${entry.deliveredAt}`,
      `- last produced: ${entry.lastProducedAt || 'nothing on record'}`,
      `- last call from its own client: ${entry.lastClientCallAt || 'not reported by this server'}${entry.activity ? ` (${entry.activity}${entry.tool ? `:${entry.tool}` : ''})` : ''}`,
      `- daemon last saw the process ${entry.lastSeenAgoS}s ago`,
      entry.placeable === false
        ? '- **no `permission_grants` row for this daemon — it cannot be killed, restarted or typed into. `restart-mcp` will print `ok` and do nothing.** Recovery is `tmux kill-session` plus an operator wake.'
        : entry.placeable === null ? '- daemon placement: not measured (ledger unreadable)' : null,
    ].filter(Boolean).join('\n')).join('\n\n')
    const preface = hasActivityAt
      ? ''
      : '_Degraded: this server does not send `activity_at`, so every awake agent was queried instead of only the silent ones._\n\n'
    throw new Error(`${preface}${lines}`)
  }
  return { watched: rows.length, queried: candidates.length, windowMin: Math.round(AGENT_SILENCE_WINDOW_MS / 60_000) }
}

// The only check here that is not about a running system. It is a static read of
// a checkout, and it belongs beside the others because its failure mode is the
// same shape: a deploy that crash-loops in production while `tsc`, the local
// import check and the test suite all pass, because all three resolve against
// the root `node_modules` and the image installs from `server/package.json`.
// Eleven minutes of testing downtime on 2026-08-08, over one package.
let lastServerImportsAt = 0
let lastServerImportsResult = null

export async function checkServerImportResolution() {
  if (!SERVER_IMPORTS_REPO) return { skipped: true, blocked: true, reason: 'no repo configured' }
  const now = Date.now()
  if (lastServerImportsAt && now - lastServerImportsAt < SERVER_IMPORTS_INTERVAL_MS) {
    if (lastServerImportsResult?.error) throw new Error(lastServerImportsResult.error)
    return { ...(lastServerImportsResult?.value || {}), cached: true }
  }
  lastServerImportsAt = now
  let report
  try {
    report = checkServerImports({ repoRoot: SERVER_IMPORTS_REPO })
  } catch (e) {
    // A checkout that cannot be read is a setup problem, not a finding. Saying
    // "no missing imports" here would be the check reporting a pass it did not
    // perform, which is how the round-trip check read healthy for ten days.
    lastServerImportsResult = null
    lastServerImportsAt = 0
    throw new ProbeSetupError(`server import check could not read ${SERVER_IMPORTS_REPO}: ${e.message}`)
  }
  if (report.missing.length || report.unshipped.length || report.unresolved.length) {
    const message = `${describeServerImportFailures(report)}\n\nChecked \`${SERVER_IMPORTS_REPO}\`, ${report.reachable} files on the boot path.`
    lastServerImportsResult = { error: message }
    throw new Error(message)
  }
  const value = { repo: SERVER_IMPORTS_REPO, reachable: report.reachable, declared: report.declared }
  lastServerImportsResult = { value }
  return value
}


// The fourth failure of 2026-08-08: the teacher bot sat inert for seven days and
// the only trace was one line in a log nobody reads. A bot that is up and doing
// nothing is indistinguishable from a working one unless something outside it
// looks, and every bot here already writes an append-only heartbeat per sweep.
//
// The declared bot list for this environment is the contract. A bot named in
// `bots.yaml` under this environment is supposed to be running, so one that is
// not beating is a defect with an action attached: start it, or stop declaring
// it. That is why a stopped-on-purpose bot is NOT treated as a false positive —
// the alarm clears either way, and the alternative is a watcher that cannot tell
// "deliberately off" from "died in July".
//
// An absent heartbeat file is a finding, not an excuse to skip. The teacher bot
// is the case: its process sets TLDA_BOT_HEARTBEAT and the file has never been
// created, so "cannot measure" and "has been inert for a week" look identical.
// Skipping it is the blindness this check exists to remove.
//
// LOAD-BEARING, do not "improve" this into reading service state. On 2026-08-08
// `launchctl list | grep tlda.bot` returned NOTHING -- no bot service loaded at
// all -- while todd, chat-lint, teacher and this bot were alive in tmux and
// working, and `tlda bot status` simultaneously reported `dev service loaded,
// state = running`. A service-state check would have reported all six bots down
// while four of them worked. The heartbeat is the only surface here that tracks
// whether a bot is doing anything, which is the question.
//
// "Declared and not beating" and "not running" are therefore different facts and
// the tooling cannot currently tell them apart. This measures the first.
//
// Threshold: healthy bots here beat once a sweep. Observed on 2026-08-08, todd,
// chat-lint and this bot were all 0 minutes stale; grammar was 11,525 minutes and
// teacher and nobody had never written one. There is no middle of that
// distribution, so 15 minutes sits far above every healthy value and far below
// every failing one.
export async function checkBotHeartbeats() {
  const declared = (BOT_ENVIRONMENTS[CONFIG_NAME] || [])
    .map(name => String(name).toLowerCase())
    .filter(name => name !== BOT_KEY)
  if (!declared.length) return { skipped: true, blocked: true, reason: `no bots declared for environment ${CONFIG_NAME}` }

  const now = Date.now()
  const silent = []
  const beating = []
  for (const name of declared) {
    const file = path.join(CONFIG_DIR, `${name}.${CONFIG_NAME}.heartbeat`)
    let mtimeMs = null
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      silent.push({ name, file, never: true })
      continue
    }
    const staleMs = now - mtimeMs
    if (staleMs >= BOT_HEARTBEAT_STALE_MS) silent.push({ name, file, staleMin: Math.round(staleMs / 60_000) })
    else beating.push(name)
  }

  // "Stopped writing" and "never written" are different facts and reporting them
  // in one sentence made them look alike. `grammar` HAD a heartbeat and lost it,
  // which is a bot that went down. `teacher` has never written one because
  // teacher-bot.mjs does not implement the convention at all -- it lives in a
  // different repo and never picked it up -- while the process itself is alive
  // and was observed riding out a deploy correctly.
  //
  // So only the first wakes anyone. The second is a missing instrument, and it
  // degrades the sweep instead: this bot cannot say whether that bot is working,
  // which is exactly what `degraded` already means here. Alarming on it would get
  // the row silenced, and silencing it would record that a declared bot has no
  // liveness instrument as though it were fine -- teacher is the bot Skip asked
  // for by name this afternoon, and its being unmonitorable is worth knowing.
  const stopped = silent.filter(entry => !entry.never)
  const unmonitored = silent.filter(entry => entry.never).map(entry => entry.name)
  if (stopped.length) {
    throw new Error(stopped.map(entry =>
      `**${entry.name}** is declared for \`${CONFIG_NAME}\` and has not written a heartbeat for ${entry.staleMin} minutes (\`${entry.file}\`). It was beating before, so it stopped.`,
    ).join('\n\n') + `\n\nBeating: ${beating.length ? beating.join(', ') : 'none'}. Either start it or stop declaring it in \`bots.yaml\`; both clear this.`)
  }
  return {
    declared: declared.length,
    beating,
    ...(unmonitored.length ? { unmonitored, blocked: true, reason: `declared with no heartbeat instrument: ${unmonitored.join(', ')}` } : {}),
  }
}

function compactFailure(results) {
  return results
    .filter(r => !r.ok)
    .map(r => `${r.name}: ${r.indeterminate ? 'indeterminate: ' : ''}${r.error}`)
    .join('\n')
}

// The checks this bot is expected to run, declared separately from the table
// below so that removing a check cannot silently shrink what `healthy` means.
//
// On 2026-07-29 `chat-roundtrip` was dropped from the table in a commit about
// API migration. It was not disabled and not skipped — it stopped existing, and
// because `checks:` is derived from whatever ran, the heartbeat went on saying
// `healthy` with no way to tell it had stopped testing message delivery.
//
// A name here with no entry in the table below now reports `degraded` rather
// than `healthy`. Removing a check is still allowed; removing it silently is not.
const REQUIRED_CHECKS = ['doc-load', 'chat-roundtrip', 'spawn-wake-seat', 'linked-remote-safety', 'agent-receiving', 'server-imports', 'bot-heartbeats']

async function runChecks() {
  const results = []
  for (const [name, check] of [
    ['doc-load', checkDocumentLoads],
    ['chat-roundtrip', checkMessageRoundTrip],
    ['spawn-wake-seat', checkSpawnWakeSeat],
    ['linked-remote-safety', checkLinkedRemoteSafety],
    ['agent-receiving', checkAgentReceiving],
    ['server-imports', checkServerImportResolution],
    ['bot-heartbeats', checkBotHeartbeats],
  ]) {
    try {
      const detail = await check()
      if (detail?.skipped) {
        results.push({ name, ok: true, skipped: true, blocked: !!detail.blocked, detail })
      } else {
        results.push({ name, ok: true, blocked: !!detail?.blocked, detail })
      }
    } catch (e) {
      results.push({
        name,
        ok: false,
        setup: e instanceof ProbeSetupError,
        indeterminate: e instanceof ProbeIndeterminateError,
        error: e?.message || String(e),
      })
    }
  }
  const ran = new Set(results.map(r => r.name))
  const missing = REQUIRED_CHECKS.filter(name => !ran.has(name))
  // A required check that CANNOT run is not a healthy sweep either. `missing`
  // catches a check deleted from the table; it does not catch one that is
  // present, returns cleanly every sweep, and has never tested anything --
  // because its server field is absent, or its repo is unconfigured. That reads
  // `healthy` with a line in the skipped list, which is the shape of the failure
  // this bot already had once: `healthy` printed identically for ten days while
  // the round-trip check tested nothing.
  //
  // Cadence and disabled skips are NOT this. A check waiting for its next window
  // is working; a check that cannot run is not.
  // Includes checks that RAN. A check can pass and still be blind to part of what
  // it is supposed to cover, and that is a degraded sweep, not a healthy one.
  const blocked = results.filter(r => r.blocked && REQUIRED_CHECKS.includes(r.name))
    .map(r => `${r.name}:${r.detail?.reason || 'blocked'}`)
  const failures = results.filter(r => !r.ok)
  if (!failures.length) return { ok: true, results, missing, blocked }
  const setupFailures = failures.filter(r => r.setup)
  const testFailures = failures.filter(r => !r.setup)
  return {
    ok: false,
    setupOnly: testFailures.length === 0 && setupFailures.length > 0,
    results,
    missing,
    blocked,
    summary: compactFailure(results),
  }
}

function isNudgeTarget(agent) {
  if (!agent || agent.dead || agent.human || agent.id === OWNER_ID || agent.id === AGENT_ID) return false
  const labels = labelsForAgent(agent)
  if (labels.includes('bot')) return false
  if (agent.id?.startsWith?.('fleet:dev-probe-')) return false
  return true
}

// An alarm delivered to nobody is not an alarm. Addressing `awake & on-call`
// alone means that when every holder of the label is hibernating -- which was
// true of all three holders on 2026-08-08, for 8, 94 and 371 hours -- a correct
// failure notice is written to a heartbeat and reaches no one.
//
// So: awake holders when there are any; otherwise the hibernating holders, whose
// delivery queues until they wake. The fallback is NOT silent -- `fellBack` is
// carried into the notice text, because a fallback that fixes today and hides
// tomorrow is how the label rotted unnoticed in the first place.
async function nudgeTargets() {
  if (NUDGE_TO_OVERRIDE) return { targets: [NUDGE_TO_OVERRIDE], fellBack: null }
  if (!NUDGE_LABEL) return { targets: [], fellBack: null }
  const holders = async filter => {
    const data = await fetchJson(FLEET_SERVER, `/api/fleet-table?filter=${encodeURIComponent(filter)}&limit=500`)
    const agents = Array.isArray(data?.agents) ? data.agents : []
    return agents.filter(isNudgeTarget).map(agent => agent.id)
  }
  const awake = await holders(`awake & ${NUDGE_LABEL}`)
  if (awake.length) return { targets: awake, fellBack: null }
  const asleep = await holders(NUDGE_LABEL)
  if (!asleep.length) return { targets: [], fellBack: null }
  return { targets: asleep, fellBack: `no awake holder of \`${NUDGE_LABEL}\`; queued to ${asleep.length} hibernating holder(s)` }
}

async function sendChat(to, message) {
  if (!bot.isCanonical()) return null
  return sendRequest({
    type: 'chat',
    from: AGENT_ID,
    to,
    message,
    _tempId: `${BOT_KEY}:${randomUUID()}`,
  })
}

async function sendFailureNudge(report) {
  if (report.setupOnly && !NUDGE_ON_SETUP) {
    writeHeartbeat('probe-setup-suppressed', { summary: report.summary })
    return
  }
  const key = report.summary
  const now = Date.now()
  const unchanged = activeFailure?.key === key
  if (unchanged) {
    const wait = FAILURE_REPEAT_SCHEDULE_MS[Math.min(activeFailure.repeats, FAILURE_REPEAT_SCHEDULE_MS.length - 1)]
    if (now - activeFailure.lastNudgeAt < Math.max(wait, FAILURE_COOLDOWN_MS)) return
  }
  const { targets, fellBack } = await nudgeTargets()
  if (!targets.length) {
    writeHeartbeat('failure-no-targets', { summary: report.summary })
    return
  }
  if (NUDGE_DRY_RUN) {
    writeHeartbeat('failure-nudge-dry-run', { targets, summary: report.summary })
    return
  }
  const standingFor = unchanged ? Math.round((now - activeFailure.firstAt) / 60_000) : 0
  const message = [
    unchanged
      ? `**dev noticer: still failing, unchanged for ${standingFor} minutes** (first raised ${new Date(activeFailure.firstAt).toISOString()})`
      : report.setupOnly ? '**dev noticer: probe setup needs repair**' : '**dev noticer: testing is failing**',
    '',
    report.summary,
    '',
    ...(unchanged ? ['_Nothing here has changed since the first notice. The next repeat is further out; a changed finding interrupts immediately._', ''] : []),
    ...(fellBack ? [`_Delivery degraded: ${fellBack}._`, ''] : []),
    `Environment: \`${CONFIG_NAME}\``,
    `Fleet: \`${FLEET_SERVER}\``,
    `Store: \`${STORE_SERVER}\``,
    '',
    'Coverage: real document SVG load; disposable identity chat round trip confirmed by history read-back; disposable linked Git remote source/render/history, reverse commit, conflict/no-overwrite; opt-in core phi spawn/wake path.',
  ].join('\n')
  for (const target of targets) {
    await sendChat(target, message)
  }
  activeFailure = unchanged
    ? { ...activeFailure, lastNudgeAt: now, repeats: activeFailure.repeats + 1 }
    : { key, firstAt: now, lastNudgeAt: now, repeats: 0, summary: report.summary }
  writeHeartbeat('failure-nudged', { targets, summary: report.summary, repeats: activeFailure.repeats, standingForMin: standingFor })
}

async function sweep() {
  if (sweepInFlight || !bot.isCanonical()) return
  sweepInFlight = true
  try {
    const report = await runChecks()
    if (report.ok) {
      // Backoff makes silence ambiguous — a reader cannot tell a cleared failure
      // from one whose next repeat is forty minutes out. One line closes it. This
      // is the only message this bot sends about something being fine, and it is
      // sent only to people who were told it was broken.
      if (activeFailure) {
        const cleared = activeFailure
        activeFailure = null
        writeHeartbeat('recovered', { summary: cleared.summary, standingForMin: Math.round((Date.now() - cleared.firstAt) / 60_000) })
        const { targets } = await nudgeTargets()
        for (const target of targets) {
          await sendChat(target, `**dev noticer: cleared** after ${Math.round((Date.now() - cleared.firstAt) / 60_000)} minutes.\n\n${cleared.summary.split('\n')[0]}`)
        }
      }
      const detail = {
        checks: report.results.filter(r => !r.skipped).map(r => r.name),
        skipped: report.results.filter(r => r.skipped).map(r => `${r.name}:${r.detail?.reason || 'skipped'}`),
      }
      // A required check with no implementation is not a healthy sweep. Everything
      // that ran passed, so this is not a failure either — it is the bot saying it
      // has stopped testing something, which is the state it previously could not
      // express. See REQUIRED_CHECKS.
      if (report.missing?.length || report.blocked?.length) {
        writeHeartbeat('degraded', { ...detail, missing: report.missing, blocked: report.blocked })
      } else writeHeartbeat('healthy', detail)
      return
    }
    if (report.setupOnly) {
      writeHeartbeat('probe-setup-failed', { summary: report.summary })
    }
    await sendFailureNudge(report)
  } catch (e) {
    await sendFailureNudge({
      ok: false,
      summary: `dev-bot: ${e?.message || String(e)}`,
      results: [],
    })
  } finally {
    sweepInFlight = false
  }
}

async function cleanupResources() {
  if (resourceCleanupInFlight || !bot?.isCanonical()) return
  resourceCleanupInFlight = true
  try {
    const previews = reapIdlePreviews()
    for (const entry of previews.failed) {
      console.error(`[dev-bot] preview reap failed for pid=${entry.pid} port=${entry.port}: ${entry.error}`)
    }
    const results = await playwrightPoolCleanup.sweep()
    for (const result of results) {
      if (result.state === 'reaped') {
        console.log(`[dev-bot] reaped empty Playwright session "${result.session}" after ${Math.round(result.idleMs / 60_000)}m`)
      } else if (result.state === 'error') {
        console.error(`[dev-bot] Playwright cleanup failed for "${result.session}": ${result.error}`)
      }
    }
    if (Date.now() - lastWorktreeCleanupAt >= WORKTREE_CLEANUP_INTERVAL_MS) {
      const worktrees = await worktreeCleanup.sweep()
      lastWorktreeCleanupAt = Date.now()
      statusSamples.push({
        ts: new Date().toISOString(),
        totalBytes: worktrees.totalBytes,
        retainedBytes: worktrees.retainedBytes,
        overBudgetBytes: worktrees.overBudgetBytes,
        removedWorktrees: worktrees.removedWorktrees.length,
        evictedCaches: worktrees.evicted.length,
        pinnedWorktrees: worktrees.pinned.length,
        abandonedWorktrees: worktrees.abandoned.length,
      })
      if (statusSamples.length > 168) statusSamples.splice(0, statusSamples.length - 168)
      for (const entry of worktrees.removedWorktrees) {
        console.log(`[dev-bot] removed merged clean worktree "${entry.path}"`)
      }
      for (const entry of worktrees.evicted) {
        console.log(`[dev-bot] evicted worktree node_modules "${entry.nodeModules}" (${entry.sizeBytes} bytes)`)
      }
      for (const entry of worktrees.abandoned) {
        console.error(`[dev-bot] preserved abandoned worktree-shaped directory "${entry.path}": ${entry.error}`)
      }
      for (const entry of worktrees.unremovable) {
        console.error(`[dev-bot] could not remove merged clean worktree "${entry.path}": ${entry.error}`)
      }
      if (bot.isCanonical()) {
        await publishStatus().catch(error => console.error(`[dev-bot] status publish failed: ${error.message}`))
      }
    }
  } finally {
    resourceCleanupInFlight = false
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

export function renderStatusMarkdown(samples = statusSamples) {
  const generatedAt = new Date().toISOString()
  const latest = samples.at(-1)
  const findings = latest
    ? `The latest sweep retained ${formatBytes(latest.retainedBytes)} across idle worktree dependency caches. ${latest.removedWorktrees} merged clean worktree(s) and ${latest.evictedCaches} cache(s) were removed in that sweep.`
    : 'No completed worktree measurement is available yet.'
  const width = 720
  const height = 220
  const max = Math.max(1, ...samples.map(sample => sample.totalBytes))
  const points = samples.map((sample, index) => {
    const x = samples.length <= 1 ? width / 2 : 30 + index * (width - 60) / (samples.length - 1)
    const y = height - 25 - sample.totalBytes / max * (height - 50)
    return { ...sample, x: x.toFixed(1), y: y.toFixed(1) }
  })
  const polyline = points.map(point => `${point.x},${point.y}`).join(' ')
  const chart = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Worktree dependency disk use over time" style="max-width:100%;background:#fafafa;border:1px solid #ddd">
  <polyline fill="none" stroke="#2563eb" stroke-width="3" points="${polyline}"/>
  ${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="5" fill="#2563eb" tabindex="0"><title>${point.ts}: ${formatBytes(point.totalBytes)}</title></circle>`).join('\n  ')}
</svg>`
  return [
    '# Dev bot disk and worktree status {.volatile}',
    '',
    findings,
    '',
    `Generated: ${generatedAt}`,
    '',
    'Provenance: dev bot worktree cleanup measurements from `git worktree`, `lsof`, and `du`; values are recorded after each completed worktree cleanup sweep.',
    '',
    '## Measurements',
    '',
    '| Timestamp | Total caches | Retained caches | Over budget | Removed worktrees | Evicted caches | Pinned | Abandoned |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...samples.map(sample => `| ${sample.ts} | ${formatBytes(sample.totalBytes)} | ${formatBytes(sample.retainedBytes)} | ${formatBytes(sample.overBudgetBytes)} | ${sample.removedWorktrees} | ${sample.evictedCaches} | ${sample.pinnedWorktrees} | ${sample.abandonedWorktrees} |`),
    '',
    '## Timeline',
    '',
    chart,
    '',
    '<details><summary>How to read the timeline</summary>Each point is one completed cleanup sweep. Hover or focus a point for its timestamp and measured total.</details>',
  ].join('\n')
}

export async function publishStatus({ transport = bot, samples = statusSamples } = {}) {
  const requestId = `dev-status:${randomUUID()}`
  const result = await transport.sendAndWait({
    type: 'source-change',
    project: 'info',
    files: [{ path: config.statusFile, content: renderStatusMarkdown(samples) }],
    editedBy: AGENT_ID,
    requestId,
  }, message => message.type === 'source-change-result' && message.requestId === requestId, REQUEST_TIMEOUT_MS)
  if (!result.ok) throw new Error(result.error || `source update failed (${result.status || result.httpStatus})`)
  return `[Dev bot disk and worktree status](/docs/info/${encodeURIComponent(config.statusFile.replace(/\.md$/i, '.html'))})`
}

export const commands = [{
  name: 'status',
  summary: 'Publish and return the current disk/worktree status report.',
  help: 'Writes the current semantic Markdown report and interactive timeline to the ordinary info project through the normal source-change pipeline, then returns its project-file reference.',
  examples: ['status'],
  handler: async ({ reply }) => {
    await reply(await publishStatus())
  },
}]

if (process.env.TLDA_DEV_BOT_NO_START !== '1') {
  bot = createBot({
    name: AGENT_NAME,
    labels: ['bot'],
    server: FLEET_SERVER,
    cwd: REPO_ROOT,
    metadata: { config: CONFIG_NAME },
    fleetId: AGENT_ID,
    bestEffortIdentity: true,
    pidFile: PID_FILE,
    idFile: ID_FILE,
    commands,
  }).onOpen(() => {
    writeHeartbeat('ws-open')
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = setInterval(() => sweep().catch(e => console.error('[dev-bot] sweep failed:', e.message)), INTERVAL_MS)
    sweep().catch(e => console.error('[dev-bot] initial sweep failed:', e.message))
    cleanupResources().catch(e => console.error('[dev-bot] initial resource cleanup failed:', e.message))
  }).start()

  activeFailure = restoreActiveFailure()
  writeHeartbeat('startup', {
    intervalMs: INTERVAL_MS,
    ...(activeFailure ? { restoredFailure: activeFailure.summary.split('\n')[0], repeats: activeFailure.repeats } : {}),
  })
  resourceCleanupTimer = setInterval(() => cleanupResources().catch(e => console.error('[dev-bot] resource cleanup failed:', e.message)), RESOURCE_CLEANUP_INTERVAL_MS)
  resourceCleanupTimer.unref?.()
}
