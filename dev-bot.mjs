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
  linkedRemoteRestartCommand: { env: 'TLDA_DEV_BOT_LINKED_REMOTE_RESTART_COMMAND', default: '', description: 'Command that restarts the testing server during the linked remote transition.', parse: configTypes.string },
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
})
const config = parseConfig(configSchema)
const {
  intervalMs: INTERVAL_MS, failureCooldownMs: FAILURE_COOLDOWN_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS,
  spawnWakeIntervalMs: SPAWN_WAKE_INTERVAL_MS, spawnWakeTimeoutMs: SPAWN_WAKE_TIMEOUT_MS,
  spawnWakeEnabled: SPAWN_WAKE_ENABLED, spawnWakeModel: SPAWN_WAKE_MODEL, probeDoc: PROBE_DOC,
  linkedRemoteEnabled: LINKED_REMOTE_ENABLED, linkedRemoteIntervalMs: LINKED_REMOTE_INTERVAL_MS,
  linkedRemoteUrl: LINKED_REMOTE_URL, linkedRemoteTokenFile: LINKED_REMOTE_TOKEN_FILE,
  linkedRemoteHost: LINKED_REMOTE_HOST, linkedRemotePort: LINKED_REMOTE_PORT,
  linkedRemoteRestartCommand: LINKED_REMOTE_RESTART_COMMAND,
  assetPathOverride: ASSET_PATH_OVERRIDE, allowNondefault: ALLOW_NONDEFAULT, nudgeTo: NUDGE_TO_OVERRIDE,
  nudgeLabel: NUDGE_LABEL, nudgeOnSetup: NUDGE_ON_SETUP, nudgeDryRun: NUDGE_DRY_RUN,
  resourceCleanupIntervalMs: RESOURCE_CLEANUP_INTERVAL_MS, worktreeCleanupIntervalMs: WORKTREE_CLEANUP_INTERVAL_MS,
} = config

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

async function restartTestingServer() {
  if (!LINKED_REMOTE_RESTART_COMMAND) {
    throw new Error('TLDA_DEV_BOT_LINKED_REMOTE_RESTART_COMMAND is not configured')
  }
  const { exec: execCb } = await import('node:child_process')
  await new Promise((resolve, reject) => execCb(
    LINKED_REMOTE_RESTART_COMMAND,
    { timeout: 180_000 },
    (error, stdout, stderr) => error ? reject(new Error(stderr?.trim() || stdout?.trim() || error.message)) : resolve(),
  ))
}

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
      restart: restartTestingServer,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    })
    return await runLinkedRemoteProbe({ driver })
  } finally {
    driver?.close()
    linkedRemoteProbeInFlight = false
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

function compactFailure(results) {
  return results
    .filter(r => !r.ok)
    .map(r => `${r.name}: ${r.indeterminate ? 'indeterminate: ' : ''}${r.error}`)
    .join('\n')
}

async function runChecks() {
  const results = []
  for (const [name, check] of [
    ['doc-load', checkDocumentLoads],
    ['spawn-wake-seat', checkSpawnWakeSeat],
    ['linked-remote-safety', checkLinkedRemoteSafety],
  ]) {
    try {
      const detail = await check()
      if (detail?.skipped) {
        results.push({ name, ok: true, skipped: true, detail })
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
  const failures = results.filter(r => !r.ok)
  if (!failures.length) return { ok: true, results }
  const setupFailures = failures.filter(r => r.setup)
  const testFailures = failures.filter(r => !r.setup)
  return {
    ok: false,
    setupOnly: testFailures.length === 0 && setupFailures.length > 0,
    results,
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

async function nudgeTargets() {
  if (NUDGE_TO_OVERRIDE) return [NUDGE_TO_OVERRIDE]
  if (!NUDGE_LABEL) return []
  const filter = encodeURIComponent(`awake & ${NUDGE_LABEL}`)
  const data = await fetchJson(FLEET_SERVER, `/api/fleet-table?filter=${filter}&limit=500`)
  const agents = Array.isArray(data?.agents) ? data.agents : []
  return agents.filter(isNudgeTarget).map(agent => agent.id)
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
  const targets = await nudgeTargets()
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
    `Environment: \`${CONFIG_NAME}\``,
    `Fleet: \`${FLEET_SERVER}\``,
    `Store: \`${STORE_SERVER}\``,
    '',
    'Coverage: real document SVG load; disposable linked Git remote source/render/history, reverse commit, conflict/no-overwrite, restart/no-echo; opt-in core phi spawn/wake path.',
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
      writeHeartbeat('healthy', {
        checks: report.results.filter(r => !r.skipped).map(r => r.name),
        skipped: report.results.filter(r => r.skipped).map(r => `${r.name}:${r.detail?.reason || 'skipped'}`),
      })
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
