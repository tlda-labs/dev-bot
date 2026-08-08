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
  channelSilenceWindowMs: { env: 'TLDA_DEV_BOT_CHANNEL_SILENCE_WINDOW_MS', default: 600_000, description: 'How long an awake agent may hold no open fleet socket before it is reported off-channel.', parse: configTypes.integer, validate: positive },
  channelReportEnabled: { env: 'TLDA_DEV_BOT_CHANNEL_REPORT_ENABLED', default: false, description: 'Whether the off-channel observation notifies. Off until its false-positive rate has been measured live.', parse: configTypes.boolean },
  agentWatchIntervalMs: { env: 'TLDA_DEV_BOT_AGENT_WATCH_INTERVAL_MS', default: 300_000, description: 'Cadence for the agent silence and channel checks, which each cost one whole-roster read.', parse: configTypes.integer, validate: positive },
  serverImportsRepo: { env: 'TLDA_DEV_BOT_SERVER_IMPORTS_REPO', default: '', description: 'tlda checkout whose server boot path is checked against the shipped dependency manifest. Empty disables the check.', parse: configTypes.string },
  serverImportsIntervalMs: { env: 'TLDA_DEV_BOT_SERVER_IMPORTS_INTERVAL_MS', default: 600_000, description: 'Cadence for the server import resolution check.', parse: configTypes.integer, validate: positive },
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
  channelSilenceWindowMs: CHANNEL_SILENCE_WINDOW_MS,
  channelReportEnabled: CHANNEL_REPORT_ENABLED,
  agentWatchIntervalMs: AGENT_WATCH_INTERVAL_MS, rosterTimeoutMs: ROSTER_TIMEOUT_MS,
  serverImportsRepo: SERVER_IMPORTS_REPO, serverImportsIntervalMs: SERVER_IMPORTS_INTERVAL_MS,
  daemonLedgerDb: DAEMON_LEDGER_DB,
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
let lastFailureKey = null
let lastFailureNudgeAt = 0
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

// One roster read per check per cadence window. `lastResult` is replayed on a
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
      socketOpen: row.client_socket_open ?? null,
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
      `- daemon last saw the process ${entry.lastSeenAgoS}s ago${entry.socketOpen === null ? '' : `; own client socket ${entry.socketOpen ? 'open' : 'absent'}`}`,
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

// An agent that is merely busy inside a long tool call still holds its own
// client socket — ResilientWS heartbeats every 45s independently of the model.
// An agent whose client wedged, died, or never initialised does not. That is the
// only fast discriminator available from outside, and it is why this exists
// beside the slow check above rather than instead of it.
//
// It reads `client_socket_open`, NOT the `fleet_socket_open` this bot asked for
// first. That one counted any socket labelled with the agent's id, and
// `reserve-shell` labels the CALLER's socket when waking someone else — so two
// agents with no tlda MCP at all read as connected on its first observation.
// The rename is the whole correction; see the comment on hasOwnClientSocketForAgent.
//
// Absence has to persist: a reconnect leaves the socket briefly absent during
// normal operation, so first-absence is recorded here and only an agent absent
// for the whole window is reported.
const channelAbsentSince = new Map()

export async function checkAgentChannel() {
  if (!agentWatchDue('channel')) return agentWatchReplay('channel')
  try {
    const result = await runAgentChannel()
    agentWatchRecord('channel', result, null)
    return result
  } catch (e) {
    agentWatchRecord('channel', null, e?.message || String(e))
    throw e
  }
}

async function runAgentChannel() {
  const rows = (await fleetTableRows('awake')).filter(rowIsWatchable)
  if (!rows.length) return { skipped: true, reason: 'no watchable awake agents' }
  if (!rows.some(row => Object.hasOwn(row, 'client_socket_open'))) {
    channelAbsentSince.clear()
    return { skipped: true, blocked: true, reason: 'server does not send client_socket_open' }
  }

  const now = Date.now()
  const seen = new Set()
  const offChannel = []
  for (const row of rows) {
    seen.add(row.id)
    if (row.client_socket_open !== false) { channelAbsentSince.delete(row.id); continue }
    if (!channelAbsentSince.has(row.id)) channelAbsentSince.set(row.id, now)
    const since = channelAbsentSince.get(row.id)
    if (now - since < CHANNEL_SILENCE_WINDOW_MS) continue
    offChannel.push({
      id: row.id,
      name: row.name || row.id,
      absentForMin: Math.round((now - since) / 60_000),
      lastClientCallAt: row.activity_at ?? null,
      lastSeenAgoS: row.last_seen_ago_s,
      activity: row.activity || null,
      tool: row.tool || null,
    })
  }
  for (const id of [...channelAbsentSince.keys()]) if (!seen.has(id)) channelAbsentSince.delete(id)

  const detail = { watched: rows.length, offChannel: offChannel.map(entry => `${entry.name}:${entry.absentForMin}m`) }
  // Observation only until the live false-positive rate is measured. The count
  // is written to the heartbeat every sweep so the rate is measurable without
  // anyone being nudged in the meantime.
  if (!CHANNEL_REPORT_ENABLED) {
    writeHeartbeat('channel-observation', detail)
    return { ...detail, reporting: false }
  }
  if (offChannel.length) {
    throw new Error(offChannel.map(entry => [
      `**${entry.name}** (\`${entry.id}\`) has held no fleet socket for ${entry.absentForMin} minutes while its process is reported alive.`,
      `- last call from its own client: ${entry.lastClientCallAt || 'not reported by this server'}${entry.activity ? ` (${entry.activity}${entry.tool ? `:${entry.tool}` : ''})` : ''}`,
      `- daemon last saw the process ${entry.lastSeenAgoS}s ago`,
    ].join('\n')).join('\n\n'))
  }
  return { ...detail, reporting: true }
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
const REQUIRED_CHECKS = ['doc-load', 'chat-roundtrip', 'spawn-wake-seat', 'linked-remote-safety', 'agent-receiving', 'agent-channel', 'server-imports']

async function runChecks() {
  const results = []
  for (const [name, check] of [
    ['doc-load', checkDocumentLoads],
    ['chat-roundtrip', checkMessageRoundTrip],
    ['spawn-wake-seat', checkSpawnWakeSeat],
    ['linked-remote-safety', checkLinkedRemoteSafety],
    ['agent-receiving', checkAgentReceiving],
    ['agent-channel', checkAgentChannel],
    ['server-imports', checkServerImportResolution],
  ]) {
    try {
      const detail = await check()
      if (detail?.skipped) {
        results.push({ name, ok: true, skipped: true, blocked: !!detail.blocked, detail })
      } else {
        results.push({ name, ok: true, detail })
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
  if (key === lastFailureKey && now - lastFailureNudgeAt < FAILURE_COOLDOWN_MS) return
  const { targets, fellBack } = await nudgeTargets()
  if (!targets.length) {
    writeHeartbeat('failure-no-targets', { summary: report.summary })
    return
  }
  if (NUDGE_DRY_RUN) {
    writeHeartbeat('failure-nudge-dry-run', { targets, summary: report.summary })
    return
  }
  const message = [
    report.setupOnly ? '**dev noticer: probe setup needs repair**' : '**dev noticer: testing is failing**',
    '',
    report.summary,
    '',
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
  lastFailureKey = key
  lastFailureNudgeAt = now
  writeHeartbeat('failure-nudged', { targets, summary: report.summary })
}

async function sweep() {
  if (sweepInFlight || !bot.isCanonical()) return
  sweepInFlight = true
  try {
    const report = await runChecks()
    if (report.ok) {
      if (lastFailureKey) writeHeartbeat('recovered')
      lastFailureKey = null
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

  writeHeartbeat('startup', { intervalMs: INTERVAL_MS })
  resourceCleanupTimer = setInterval(() => cleanupResources().catch(e => console.error('[dev-bot] resource cleanup failed:', e.message)), RESOURCE_CLEANUP_INTERVAL_MS)
  resourceCleanupTimer.unref?.()
}
