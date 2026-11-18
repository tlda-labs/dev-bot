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
import os from 'os'
import { createHash, randomUUID } from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'child_process'
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
import { labelsForAgent, reapIdlePreviews, surveyBotHeartbeats } from '@tlda/bot'
import {
  BoxDiskSetupError,
  collectDiskSample,
  collectTopDiskConsumers,
  DEFAULT_DISK_CRITICAL_FREE_BYTES,
  DEFAULT_DISK_WARN_FREE_BYTES,
  evaluateDiskSample,
  formatDiskNotice,
  formatMiB,
} from './box-disk.mjs'
import { BoxMemorySetupError, collectSample as collectBoxMemorySample, createBoxMemoryWatch, formatExcursionNotice } from './box-memory.mjs'
import {
  createClaudeTmpCleanup,
  createClimberReaper,
  createConfigLogCleanup,
  createHarnessRolloutCleanup,
  createPlaywrightPoolCleanup,
  createWorktreeCleanup,
} from './resource-cleanup.mjs'
import { pathToFileURL as importCheckUrl } from 'node:url'
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
  // Holding one check out is not the same as deleting it. A name here stops that
  // check running and lands it in the sweep's `missing` list, so the heartbeat
  // reads `degraded` rather than `healthy` for exactly as long as it is held out
  // -- the same treatment a check removed from the table gets. That is the point:
  // the alternative to a named, visible hold-out is shelving the whole bot, and
  // shelving the whole bot is what cost 32 hours of blindness.
  disabledChecks: { env: 'TLDA_DEV_BOT_DISABLED_CHECKS', default: '', description: 'Comma-separated check names to hold out of the sweep. Held-out checks report the sweep as degraded, never healthy.', parse: configTypes.string },
  failureCooldownMs: { env: 'TLDA_DEV_BOT_FAILURE_COOLDOWN_MS', default: 300_000, description: 'Minimum interval between identical failure notices.', parse: configTypes.integer, validate: positive },
  requestTimeoutMs: { env: 'TLDA_DEV_BOT_REQUEST_TIMEOUT_MS', default: 15_000, description: 'Fleet and HTTP request timeout in milliseconds.', parse: configTypes.integer, validate: positive },
  spawnWakeIntervalMs: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_INTERVAL_MS', default: 1_800_000, description: 'Spawn/wake probe cadence in milliseconds.', parse: configTypes.integer, validate: positive },
  spawnWakeTimeoutMs: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_TIMEOUT_MS', default: 180_000, description: 'Overall spawn/wake probe deadline.', parse: configTypes.integer, validate: positive },
  spawnWakeEnabled: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_ENABLED', default: false, description: 'Whether the mutating disposable core phi probe runs after shadow verification.', parse: configTypes.boolean },
  spawnWakeModel: { env: 'TLDA_DEV_BOT_SPAWN_WAKE_MODEL', default: '', description: 'Optional model override for the disposable probe agent.', parse: configTypes.string },
  notificationConsumptionTimeoutMs: { env: 'TLDA_DEV_BOT_NOTIFICATION_CONSUMPTION_TIMEOUT_MS', default: 120_000, description: 'Deadline for live Claude/Codex notification canaries to consume and acknowledge a probe message.', parse: configTypes.integer, validate: positive },
  notificationConsumptionClaudeModel: { env: 'TLDA_DEV_BOT_NOTIFICATION_CONSUMPTION_CLAUDE_MODEL', default: 'opus', description: 'Claude-family model alias used for the standing notification-consumption canary.', parse: configTypes.string },
  notificationConsumptionCodexModel: { env: 'TLDA_DEV_BOT_NOTIFICATION_CONSUMPTION_CODEX_MODEL', default: 'terra', description: 'Codex-family model alias used for the standing notification-consumption canary.', parse: configTypes.string },
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
  loadReportProject: { env: 'TLDA_DEV_BOT_LOAD_REPORT_PROJECT', default: 'mini-load', description: 'Project name for the live Mini load OJS report.', parse: configTypes.string },
  loadReportSourceFile: { env: 'TLDA_DEV_BOT_LOAD_REPORT_SOURCE_FILE', default: 'index.qmd', description: 'Main QMD file for the live Mini load OJS report.', parse: configTypes.string },
  loadReportDataFile: { env: 'TLDA_DEV_BOT_LOAD_REPORT_DATA_FILE', default: 'mini-load.csv', description: 'CSV source file appended by the live Mini load OJS report publisher.', parse: configTypes.string },
  loadReportEnabled: { env: 'TLDA_DEV_BOT_LOAD_REPORT_ENABLED', default: false, description: 'Whether the periodic Mini load CSV publisher starts with the dev bot.', parse: configTypes.boolean },
  loadReportIntervalMs: { env: 'TLDA_DEV_BOT_LOAD_REPORT_INTERVAL_MS', default: 60_000, description: 'Cadence for appending one real Mini load report row.', parse: configTypes.integer, validate: positive },
  loadReportRetainedSamples: { env: 'TLDA_DEV_BOT_LOAD_REPORT_RETAINED_SAMPLES', default: 120, description: 'Rolling newest-row bound for the Mini load CSV source file.', parse: configTypes.integer, validate: positive },
  agentSilenceWindowMs: { env: 'TLDA_DEV_BOT_AGENT_SILENCE_WINDOW_MS', default: 7_200_000, description: 'How long an agent may hold a delivered message without producing anything before it is reported silent.', parse: configTypes.integer, validate: positive },
  agentSilenceLookbackMs: { env: 'TLDA_DEV_BOT_AGENT_SILENCE_LOOKBACK_MS', default: 86_400_000, description: 'How far back to look for the delivery that an agent is silent on.', parse: configTypes.integer, validate: positive },
  agentWatchIntervalMs: { env: 'TLDA_DEV_BOT_AGENT_WATCH_INTERVAL_MS', default: 300_000, description: 'Cadence for the agent silence check, which costs one whole-roster read.', parse: configTypes.integer, validate: positive },
  agentJoinGraceMs: { env: 'TLDA_DEV_BOT_AGENT_JOIN_GRACE_MS', default: 300_000, description: 'Minimum mint age before an incomplete agent join is reported stranded.', parse: configTypes.integer, validate: positive },
  serverImportsRepo: { env: 'TLDA_DEV_BOT_SERVER_IMPORTS_REPO', default: '', description: 'tlda checkout whose server boot path is checked against the shipped dependency manifest. Empty disables the check.', parse: configTypes.string },
  serverImportsIntervalMs: { env: 'TLDA_DEV_BOT_SERVER_IMPORTS_INTERVAL_MS', default: 600_000, description: 'Cadence for the server import resolution check.', parse: configTypes.integer, validate: positive },
  botHeartbeatStaleMs: { env: 'TLDA_DEV_BOT_BOT_HEARTBEAT_STALE_MS', default: 900_000, description: 'How long a bot declared for this environment may go without writing a heartbeat before it is reported inert.', parse: configTypes.integer, validate: positive },
  healthStateDb: { env: 'TLDA_DEV_BOT_HEALTH_STATE_DB', default: path.join(CONFIG_DIR, `${BOT_KEY}.${CONFIG_NAME}.health.sqlite`), description: 'Small local SQLite current-state file for bot health; append-only heartbeats remain the history.', parse: configTypes.string },
  daemonMintDb: { env: 'TLDA_DEV_BOT_DAEMON_MINT_DB', default: path.join(CONFIG_DIR, 'daemon-mints.sqlite'), description: 'Local daemon mint store, read to detect incomplete async agent joins.', parse: configTypes.string },
  daemonLedgerDb: { env: 'TLDA_DEV_BOT_DAEMON_LEDGER_DB', default: path.join(CONFIG_DIR, 'fleet-daemon.db'), description: 'Daemon permission_grants ledger, read to say whether a silent agent can be placed by the daemon at all.', parse: configTypes.string },
  rosterTimeoutMs: { env: 'TLDA_DEV_BOT_ROSTER_TIMEOUT_MS', default: 90_000, description: 'Timeout for a whole-roster read, which is far slower than an ordinary fleet request.', parse: configTypes.integer, validate: positive },
  boxMemorySwapoutWindowMs: { env: 'TLDA_DEV_BOT_BOX_MEMORY_SWAPOUT_WINDOW_MS', default: 600_000, description: 'Trailing window for the box-memory swapout rate.', parse: configTypes.integer, validate: positive },
  boxMemorySwapoutRatePerS: { env: 'TLDA_DEV_BOT_BOX_MEMORY_SWAPOUT_RATE_PER_S', default: 100, description: 'Swapout pages/s at or above which the box-memory swap leg trips.', parse: configTypes.integer, validate: positive },
  boxMemoryTopN: { env: 'TLDA_DEV_BOT_BOX_MEMORY_TOP_N', default: 5, description: 'Top-N RSS entries carried per box-memory sample.', parse: configTypes.integer, validate: positive },
  boxMemoryClimbSamples: { env: 'TLDA_DEV_BOT_BOX_MEMORY_CLIMB_SAMPLES', default: 3, description: 'Trailing readings per pid for the box-memory climber leg.', parse: configTypes.integer, validate: positive },
  boxMemoryClimbRateMbPerMin: { env: 'TLDA_DEV_BOT_BOX_MEMORY_CLIMB_RATE_MB_PER_MIN', default: 850, description: 'Per-process growth MB/min that trips the box-memory climber leg.', parse: configTypes.integer, validate: positive },
  boxMemoryReapClimbers: { env: 'TLDA_DEV_BOT_BOX_MEMORY_REAP_CLIMBERS', default: false, description: 'Whether the climber leg reaps verified climbing renderers. Detection and alerting run regardless.', parse: configTypes.boolean },
})
const config = parseConfig(configSchema)
const {
  intervalMs: INTERVAL_MS, failureCooldownMs: FAILURE_COOLDOWN_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS,
  disabledChecks: DISABLED_CHECKS_RAW,
  spawnWakeIntervalMs: SPAWN_WAKE_INTERVAL_MS, spawnWakeTimeoutMs: SPAWN_WAKE_TIMEOUT_MS,
  spawnWakeEnabled: SPAWN_WAKE_ENABLED, spawnWakeModel: SPAWN_WAKE_MODEL, probeDoc: PROBE_DOC,
  notificationConsumptionTimeoutMs: NOTIFICATION_CONSUMPTION_TIMEOUT_MS,
  notificationConsumptionClaudeModel: NOTIFICATION_CONSUMPTION_CLAUDE_MODEL,
  notificationConsumptionCodexModel: NOTIFICATION_CONSUMPTION_CODEX_MODEL,
  linkedRemoteEnabled: LINKED_REMOTE_ENABLED, linkedRemoteIntervalMs: LINKED_REMOTE_INTERVAL_MS,
  linkedRemoteUrl: LINKED_REMOTE_URL, linkedRemoteTokenFile: LINKED_REMOTE_TOKEN_FILE,
  linkedRemoteHost: LINKED_REMOTE_HOST, linkedRemotePort: LINKED_REMOTE_PORT,
  assetPathOverride: ASSET_PATH_OVERRIDE, allowNondefault: ALLOW_NONDEFAULT, nudgeTo: NUDGE_TO_OVERRIDE,
  nudgeLabel: NUDGE_LABEL, nudgeOnSetup: NUDGE_ON_SETUP, nudgeDryRun: NUDGE_DRY_RUN,
  resourceCleanupIntervalMs: RESOURCE_CLEANUP_INTERVAL_MS, worktreeCleanupIntervalMs: WORKTREE_CLEANUP_INTERVAL_MS,
  loadReportProject: LOAD_REPORT_PROJECT, loadReportSourceFile: LOAD_REPORT_SOURCE_FILE,
  loadReportDataFile: LOAD_REPORT_DATA_FILE, loadReportEnabled: LOAD_REPORT_ENABLED,
  loadReportIntervalMs: LOAD_REPORT_INTERVAL_MS,
  loadReportRetainedSamples: LOAD_REPORT_RETAINED_SAMPLES,
  agentSilenceWindowMs: AGENT_SILENCE_WINDOW_MS, agentSilenceLookbackMs: AGENT_SILENCE_LOOKBACK_MS,
  agentWatchIntervalMs: AGENT_WATCH_INTERVAL_MS, agentJoinGraceMs: AGENT_JOIN_GRACE_MS,
  rosterTimeoutMs: ROSTER_TIMEOUT_MS,
  boxMemorySwapoutWindowMs: BOX_MEMORY_SWAPOUT_WINDOW_MS, boxMemorySwapoutRatePerS: BOX_MEMORY_SWAPOUT_RATE_PER_S,
  boxMemoryTopN: BOX_MEMORY_TOP_N, boxMemoryClimbSamples: BOX_MEMORY_CLIMB_SAMPLES,
  boxMemoryClimbRateMbPerMin: BOX_MEMORY_CLIMB_RATE_MB_PER_MIN, boxMemoryReapClimbers: BOX_MEMORY_REAP_CLIMBERS,
  serverImportsRepo: SERVER_IMPORTS_REPO, serverImportsIntervalMs: SERVER_IMPORTS_INTERVAL_MS,
  daemonLedgerDb: DAEMON_LEDGER_DB, daemonMintDb: DAEMON_MINT_DB,
  botHeartbeatStaleMs: BOT_HEARTBEAT_STALE_MS,
  healthStateDb: HEALTH_STATE_DB,
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
let lastFleetEventId = 0
let lastCheckOutcome = 'startup'
let lastFailureKind = null
let lastSuccessfulCheckAt = null
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
      key: failureKey(entry.summary),
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
const configLogCleanup = createConfigLogCleanup({ configDir: CONFIG_DIR })
const claudeTmpCleanup = createClaudeTmpCleanup()
const harnessRolloutCleanup = createHarnessRolloutCleanup({
  mintDbPath: DAEMON_MINT_DB,
  ledgerDbPath: DAEMON_LEDGER_DB,
  lookupAgentsByIds: ids => lookupAgentsByIds(ids),
})
const boxMemoryWatch = createBoxMemoryWatch({
  swapoutWindowMs: BOX_MEMORY_SWAPOUT_WINDOW_MS,
  swapoutRateThresholdPerS: BOX_MEMORY_SWAPOUT_RATE_PER_S,
  topN: BOX_MEMORY_TOP_N,
  climbSamples: BOX_MEMORY_CLIMB_SAMPLES,
  climbRateMbPerMin: BOX_MEMORY_CLIMB_RATE_MB_PER_MIN,
})
const climberReaper = createClimberReaper()
let resourceCleanupTimer = null
let resourceCleanupInFlight = false
let lastWorktreeCleanupAt = 0
const statusSamples = []
let miniLoadReportTimer = null
let miniLoadReportInFlight = false
let miniLoadReportBootstrapped = false

class ProbeSetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeSetupError'
  }
}

class CanaryProvisioningError extends ProbeSetupError {
  constructor(message, { family, reason } = {}) {
    super(message)
    this.name = 'CanaryProvisioningError'
    this.failureKind = 'canary-provisioning'
    this.family = family || null
    this.reason = reason || null
  }
}

class NotificationConsumptionError extends Error {
  constructor(message, { family } = {}) {
    super(message)
    this.name = 'NotificationConsumptionError'
    this.failureKind = 'notification-consumption'
    this.family = family || null
  }
}

class ProbeIndeterminateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProbeIndeterminateError'
  }
}

let _healthDb = null
let _healthDbFailed = false
function healthDb() {
  if (_healthDb || _healthDbFailed) return _healthDb
  try {
    _healthDb = new DatabaseSync(HEALTH_STATE_DB)
    _healthDb.exec(`CREATE TABLE IF NOT EXISTS bot_health (
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pid INTEGER NOT NULL,
      reason TEXT NOT NULL,
      last_fleet_event_id INTEGER NOT NULL DEFAULT 0,
      last_check_outcome TEXT,
      last_failure_kind TEXT,
      last_success_at TEXT,
      PRIMARY KEY (name, config)
    )`)
    const columns = new Set(_healthDb.prepare(`PRAGMA table_info(bot_health)`).all().map(row => row.name))
    if (!columns.has('last_failure_kind')) {
      _healthDb.exec(`ALTER TABLE bot_health ADD COLUMN last_failure_kind TEXT`)
    }
  } catch (e) {
    _healthDbFailed = true
    console.error(`[dev-bot] cannot open health state ${HEALTH_STATE_DB}: ${e.message}`)
  }
  return _healthDb
}

function recordHealthState(entry) {
  try {
    healthDb()?.prepare(`INSERT INTO bot_health (
      name, config, updated_at, pid, reason, last_fleet_event_id,
      last_check_outcome, last_failure_kind, last_success_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name, config) DO UPDATE SET
      updated_at = excluded.updated_at,
      pid = excluded.pid,
      reason = excluded.reason,
      last_fleet_event_id = excluded.last_fleet_event_id,
      last_check_outcome = excluded.last_check_outcome,
      last_failure_kind = excluded.last_failure_kind,
      last_success_at = excluded.last_success_at`).run(
      BOT_KEY,
      CONFIG_NAME,
      entry.ts,
      entry.pid,
      entry.reason,
      Number(entry.lastFleetEventId) || 0,
      entry.lastCheckOutcome || null,
      entry.lastFailureKind || null,
      entry.lastSuccessfulCheckAt || null,
    )
  } catch (e) {
    console.error(`[dev-bot] health state write failed: ${e.message}`)
  }
}

function writeHeartbeat(reason, detail = {}) {
  const entry = {
    ts: new Date().toISOString(),
    pid: process.pid,
    bot: BOT_KEY,
    reason,
    config: CONFIG_NAME,
    fleet: FLEET_SERVER,
    store: STORE_SERVER,
    lastFleetEventId,
    lastCheckOutcome,
    lastFailureKind,
    lastSuccessfulCheckAt,
    ...detail,
  }
  try {
    fs.appendFileSync(HEARTBEAT_FILE, JSON.stringify(entry) + '\n')
  } catch (e) {
    // Best-effort telemetry; probe state still goes to process logs.
    console.error(`[dev-bot] heartbeat write failed: ${e.message}`)
  }
  recordHealthState(entry)
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

async function fetchText(base, urlPath) {
  const res = await fetch(`${base}${urlPath}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${urlPath} returned HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  return text
}

function serverRelativePath(rawUrl, base) {
  const url = new URL(rawUrl, base)
  const baseUrl = new URL(base)
  if (url.origin !== baseUrl.origin) {
    throw new Error(`attachment URL ${rawUrl} is not on expected server ${baseUrl.origin}`)
  }
  return `${url.pathname}${url.search}`
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function uploadMarkdownAttachment(fleetServer, filePath) {
  const buf = fs.readFileSync(filePath)
  const name = path.basename(filePath)
  const res = await fetch(`${fleetServer}/api/upload`, {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(name) },
    body: buf,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`upload ${name} returned HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch (e) {
    throw new Error(`upload ${name} returned invalid JSON: ${e.message}`)
  }
  if (!body.url) throw new Error(`upload ${name} returned no url`)
  return {
    type: 'file',
    id: 0,
    path: filePath,
    name,
    url: new URL(body.url, fleetServer).toString(),
    size: buf.length,
    mimeType: 'text/markdown',
    sha256: sha256(buf),
  }
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

const DOCUMENT_RENDER_PROBES = [
  {
    kind: 'markdown',
    format: 'markdown',
    mainFile: 'index.md',
    artifactPath: 'index.html',
    source: marker => `# Devbot Markdown Render\n\n${marker}\n\nInline math $a^2 + b^2 = c^2$.\n`,
  },
  {
    kind: 'latex',
    format: 'svg',
    mainFile: 'main.tex',
    artifactPath: 'main-page-1.svg',
    source: marker => `\\documentclass{article}
\\begin{document}
Devbot LaTeX render

${marker}

\\[
a^2 + b^2 = c^2
\\]
\\end{document}
`,
  },
  {
    kind: 'quarto',
    format: 'qmd',
    mainFile: 'index.qmd',
    artifactPath: 'index.html',
    source: marker => `---
title: Devbot Quarto Render
format: html
---

${marker}

This is the Quarto render probe.
`,
  },
]

function assertRenderedArtifact(probe, artifact, pageInfo, marker, artifactPath) {
  if (!Array.isArray(pageInfo) || pageInfo.length < 1) {
    throw new Error(`${probe.kind} render produced no page-info rows`)
  }
  if (probe.kind === 'latex') {
    if (!/<svg[\s>]/i.test(artifact.slice(0, 1000))) throw new Error(`${probe.kind} artifact ${artifactPath} is not SVG`)
    if (artifact.length < 1000) throw new Error(`${probe.kind} artifact ${artifactPath} is too small to be a rendered page (${artifact.length} bytes)`)
    if (!/<(?:path|use|glyph|text)\b/i.test(artifact)) throw new Error(`${probe.kind} artifact ${artifactPath} has no rendered glyph/path content`)
    return
  }
  if (!/<html[\s>]/i.test(artifact.slice(0, 1000))) throw new Error(`${probe.kind} artifact ${artifactPath} is not HTML`)
  if (!artifact.includes(marker)) throw new Error(`${probe.kind} artifact ${artifactPath} is missing marker ${marker}`)
  if (probe.kind === 'markdown' && !/katex/i.test(artifact)) throw new Error(`${probe.kind} artifact ${artifactPath} is missing KaTeX output`)
}

export async function checkDocumentRenders({
  storeServer = STORE_SERVER,
  requestJson = fetchJsonMaybe,
  requestText = fetchText,
  uuid = randomUUID,
  now = () => Date.now(),
  sleepMs = sleep,
  probes = DOCUMENT_RENDER_PROBES,
} = {}) {
  if (!Array.isArray(probes) || probes.length === 0) {
    return { skipped: true, blocked: true, reason: 'no document render probes configured' }
  }
  const prefix = `devbot-render-${uuid().slice(0, 8)}`
  const rendered = []
  const blocked = []
  const cleanupFailures = []
  try {
    for (const probe of probes) {
      if (probe.kind === 'latex') {
        blocked.push('latex: disposable SVG source render requires a daemon-watched source project; the public project API cannot create one')
        continue
      }
      const name = `${prefix}-${probe.kind}`
      const marker = `DEV-BOT-RENDER-${probe.kind.toUpperCase()}-${uuid()}`
      const source = probe.source(marker)
      await requestJson(storeServer, '/api/projects', {
        method: 'POST',
        body: { name, title: `Devbot ${probe.kind} render probe`, mainFile: probe.mainFile, format: probe.format },
      })
      const authority = (await requestJson(storeServer, `/api/projects/${encodeURIComponent(name)}/source-authority`)).body
      const push = await requestJson(storeServer, `/api/projects/${encodeURIComponent(name)}/push`, {
        method: 'POST',
        body: {
          files: [{ path: probe.mainFile, content: source }],
          sourceManifest: [probe.mainFile],
          expectedRevision: authority?.currentRevision ?? null,
          editedBy: AGENT_ID,
        },
      })
      if (!push.body?.ok) throw new Error(`${probe.kind} source push was not accepted`)

      const deadline = now() + 120_000
      let status = null
      while (now() < deadline) {
        status = (await requestJson(storeServer, `/api/projects/${encodeURIComponent(name)}/build/status`)).body
        if (status?.status === 'success') break
        if (status?.status === 'error') {
          throw new Error(`${probe.kind} render failed: ${(status.errors || []).join('; ') || String(status.log || '').slice(-500) || 'build status error'}`)
        }
        await sleepMs(1000)
      }
      if (status?.status !== 'success') {
        return { skipped: true, blocked: true, reason: `${probe.kind} render did not finish before timeout` }
      }

      const artifactPath = `/docs/${encodeURIComponent(name)}/${probe.artifactPath}`
      const [artifact, pageInfoText] = await Promise.all([
        requestText(storeServer, `${artifactPath}?t=${now()}`),
        requestText(storeServer, `/docs/${encodeURIComponent(name)}/page-info.json?t=${now()}`),
      ])
      let pageInfo
      try {
        pageInfo = JSON.parse(pageInfoText)
      } catch (e) {
        throw new Error(`${probe.kind} page-info.json did not parse: ${e.message}`)
      }
      assertRenderedArtifact(probe, artifact, pageInfo, marker, artifactPath)
      rendered.push({ kind: probe.kind, project: name, artifactPath, bytes: artifact.length, pages: pageInfo.length })
    }
    return { rendered, ...(blocked.length ? { blocked: true, reason: blocked.join('; ') } : {}) }
  } finally {
    await Promise.allSettled(probes.map(async probe => {
      const name = `${prefix}-${probe.kind}`
      try {
        await requestJson(storeServer, `/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE', okStatuses: [404] })
      } catch (e) {
        cleanupFailures.push(`${name}: ${e.message}`)
      }
    }))
    if (cleanupFailures.length) console.error(`[dev-bot] document render probe cleanup failed: ${cleanupFailures.join('; ')}`)
  }
}

export async function checkFileMaterialization({
  fleetServer = FLEET_SERVER,
  storeServer = STORE_SERVER,
  request = sendRequest,
  requestJson = fetchJsonMaybe,
  requestText = fetchText,
  openConnection = openProbeConnection,
  uploadAttachment = uploadMarkdownAttachment,
  uuid = randomUUID,
  now = () => Date.now(),
  sleepMs = sleep,
} = {}) {
  const token = `DEV-BOT-FILE-MATERIALIZATION-${uuid()}`
  const project = `devbot-materialize-${uuid().slice(0, 8)}`
  const senderId = `fleet:dev-probe-${uuid().slice(0, 8)}`
  const senderName = `dev-probe-${uuid().slice(0, 6)}`
  const tempDir = fs.mkdtempSync(path.join(CONFIG_DIR, `${BOT_KEY}.${CONFIG_NAME}.materialize-`))
  const markdownPath = path.join(tempDir, 'chip.md')
  const markdown = `# Devbot File Materialization\n\n${token}\n\nInline math $x^2$.\n`
  let sender = null
  let senderRegistered = false
  try {
    fs.writeFileSync(markdownPath, markdown)
    await requestJson(storeServer, '/api/projects', {
      method: 'POST',
      body: { name: project, title: 'Devbot file materialization probe', mainFile: 'index.md', format: 'markdown' },
    })
    const authority = (await requestJson(storeServer, `/api/projects/${encodeURIComponent(project)}/source-authority`)).body
    await requestJson(storeServer, `/api/projects/${encodeURIComponent(project)}/push`, {
      method: 'POST',
      body: {
        files: [{ path: 'index.md', content: '# Devbot materialization target\n' }],
        sourceManifest: ['index.md'],
        expectedRevision: authority?.currentRevision ?? null,
        editedBy: AGENT_ID,
      },
    })

    const attachment = await uploadAttachment(fleetServer, markdownPath)
    if (!attachment?.url) throw new Error('markdown attachment upload returned no URL')
    sender = await openConnection()
    const payload = {
      agent_id: senderId,
      name: senderName,
      cwd: REPO_ROOT,
      labels: ['dev-probe'],
      metadata: { bot_probe: BOT_KEY, disposable: true, file_materialization_probe: true },
    }
    await sender.request({ ...payload, type: 'reserve-shell' })
    await sender.request({ ...payload, type: 'login' })
    senderRegistered = true
    const sent = await sender.request({
      type: 'chat',
      from: senderId,
      to: AGENT_ID,
      message: `file-materialization probe ${token}\n\n{{att:0}}`,
      inline_attachments: [attachment],
      _tempId: token,
    }, REQUEST_TIMEOUT_MS)
    const ackEventIds = Array.isArray(sent?.event_ids) ? sent.event_ids.map(Number) : []
    if (!ackEventIds.length) throw new Error('file materialization chat did not return an accepted event id')

    const since = new Date(now() - 60_000).toISOString()
    const deadline = now() + REQUEST_TIMEOUT_MS
    let event = null
    while (now() < deadline) {
      const history = await request({
        type: 'fleet-search',
        query: '',
        me: AGENT_ID,
        agent: AGENT_ID,
        historyOnly: true,
        eventOnly: true,
        eventType: 'chat',
        since,
        limit: 40,
      }, REQUEST_TIMEOUT_MS)
      const events = (Array.isArray(history?.results) ? history.results : []).filter(r => r.source === 'fleet')
      event = events.find(row => ackEventIds.includes(Number(row.id || row.event_id)) || String(row.text || row.message || '').includes(token))
      const eventAttachment = event?.metadata?.inline_attachments?.[0]
      if (event && eventAttachment?.url) break
      await sleepMs(500)
    }
    if (!event) throw new Error('accepted file-chip chat did not arrive in dev bot chat history')
    const eventAttachment = event.metadata?.inline_attachments?.[0]
    if (!eventAttachment?.url) throw new Error('file-chip chat event has no attachment URL')
    const ref = event.metadata?.recipient_refs?.[AGENT_ID]?.attachments?.['0']

    const chipMarkdown = await requestText(fleetServer, serverRelativePath(eventAttachment.url, fleetServer))
    if (!chipMarkdown.includes(token)) throw new Error('file-chip URL resolved but did not contain the probe marker')
    const materialized = (await requestJson(storeServer, `/api/projects/${encodeURIComponent(project)}/parts`, {
      method: 'POST',
      body: {
        markdown: chipMarkdown,
        title: 'Devbot file materialization chip',
        provenance: { source: 'dev-bot-file-materialization', eventId: event.id || event.event_id || null },
      },
    })).body
    if (!materialized?.ok || !materialized.outputFile) {
      throw new Error(`project part materialization failed: ${materialized?.error || 'no outputFile'}`)
    }
    const artifactPath = `/docs/${encodeURIComponent(project)}/${materialized.outputFile}`
    const artifact = await requestText(storeServer, `${artifactPath}?t=${now()}`)
    if (!/<html[\s>]/i.test(artifact.slice(0, 1000))) throw new Error(`materialized markdown artifact ${artifactPath} is not HTML`)
    if (!artifact.includes(token)) throw new Error(`materialized markdown artifact ${artifactPath} is missing marker`)
    return {
      eventId: event.id || event.event_id || null,
      project,
      attachmentUrl: eventAttachment.url,
      recipientMaterializationState: ref?.state || null,
      recipientMaterializationError: ref?.error || null,
      materializedPath: materialized.outputFile,
      artifactPath,
      bytes: artifact.length,
    }
  } finally {
    if (senderRegistered) {
      try {
        await sender.request({ type: 'mark-dead', agent: senderId }, 5000)
      } catch (e) {
        console.error(`[dev-bot] disposable sender cleanup failed for ${senderId}: ${e.message}`)
      }
    }
    sender?.close()
    await requestJson(storeServer, `/api/projects/${encodeURIComponent(project)}`, { method: 'DELETE', okStatuses: [404] })
      .catch(e => console.error(`[dev-bot] file materialization probe cleanup failed for ${project}: ${e.message}`))
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

let lastSpawnWakeProbeAt = 0
let spawnWakeProbeInFlight = false
let notificationConsumptionProbeInFlight = false
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
export async function checkMessageRoundTrip({
  openConnection = openProbeConnection,
  request = sendRequest,
  uuid = randomUUID,
  now = () => Date.now(),
} = {}) {
  const senderId = `fleet:dev-probe-${uuid().slice(0, 8)}`
  const senderName = `dev-probe-${uuid().slice(0, 6)}`
  const token = `dev-probe:${uuid()}`
  let sender = null
  let senderRegistered = false
  try {
    sender = await openConnection()
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
    const since = new Date(now() - 60_000).toISOString()
    const deadline = now() + REQUEST_TIMEOUT_MS
    while (now() < deadline) {
      // The original read back through `chat-history`. That message type no
      // longer exists; `fleet-search` is what serves thread() now, so the poll
      // moves to it and the shape is unchanged — an independent read of the
      // recipient's own history, never a re-inspection of the send's own ack.
      const history = await request({
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
      await sleep(500)
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

export async function checkMcpSurface({
  request = sendRequest,
  openConnection = openProbeConnection,
  uuid = randomUUID,
  now = () => Date.now(),
  sleepMs = sleep,
} = {}) {
  const agent = await request({ type: 'resolve-agent', agent: AGENT_ID }, REQUEST_TIMEOUT_MS)
  const row = agent?.agent || null
  if (!row?.id || row.id !== AGENT_ID || row.dead) {
    throw new Error(`MCP resolve-agent did not read back this bot as a live agent (${JSON.stringify(row)})`)
  }
  if (row.model === 'bot') {
    throw new Error(`bot row ${AGENT_ID} reports model=bot; bot is a harness/kind, not the model`)
  }

  const probeId = `fleet:mcp-probe-${uuid().slice(0, 8)}`
  const probeName = `mcp-probe-${uuid().slice(0, 6)}`
  const token = `mcp-probe:${uuid()}`
  const toolNames = []
  let probe = null
  let probeRegistered = false
  try {
    probe = await openConnection()
    const loginPayload = {
      agent_id: probeId,
      name: probeName,
      cwd: REPO_ROOT,
      labels: ['dev-probe'],
      metadata: { bot_probe: BOT_KEY, disposable: true, mcp_surface_probe: true },
    }
    await probe.request({ ...loginPayload, type: 'reserve-shell' })
    toolNames.push('login')
    await probe.request({ ...loginPayload, type: 'login' })
    probeRegistered = true

    toolNames.push('inbox')
    const inbox = await request({ type: 'my-task', agent: probeId, peek: true }, REQUEST_TIMEOUT_MS)
    if (!inbox || typeof inbox !== 'object') {
      throw new Error('MCP inbox/my-task did not return an object')
    }

    toolNames.push('chat')
    const sent = await probe.request({ type: 'chat', from: probeId, to: AGENT_ID, message: token, _tempId: token }, REQUEST_TIMEOUT_MS)
    const ackEventIds = Array.isArray(sent?.event_ids) ? sent.event_ids : []
    if (!ackEventIds.length) throw new Error('MCP chat did not return an accepted event id')

    toolNames.push('thread')
    const since = new Date(now() - 60_000).toISOString()
    const deadline = now() + REQUEST_TIMEOUT_MS
    let found = null
    while (now() < deadline) {
      const thread = await request({
        type: 'fleet-search',
        query: '',
        me: AGENT_ID,
        agent: AGENT_ID,
        historyOnly: true,
        eventOnly: true,
        eventType: 'chat',
        since,
        limit: 30,
      }, REQUEST_TIMEOUT_MS)
      if (!thread || !Array.isArray(thread.results)) {
        throw new Error('MCP thread/fleet-search did not return a results array')
      }
      found = thread.results.find(event =>
        event.source === 'fleet' &&
        ((event.text || event.message) === token || ackEventIds.includes(Number(event.id || event.event_id))),
      )
      if (found) {
        return {
          agentId: row.id,
          probeId,
          assignedName: row.name || row.friendly_name || null,
          inboxKeys: Object.keys(inbox).sort(),
          eventId: found.id || found.event_id || null,
          tools: toolNames,
          transport: 'real-mcp',
          healthRecord: HEALTH_STATE_DB,
        }
      }
      await sleepMs(500)
    }
    throw new Error('MCP chat accepted but thread readback did not contain the message')
  } finally {
    if (probeRegistered) {
      try {
        await probe.request({ type: 'mark-dead', agent: probeId }, 5000)
      } catch (e) {
        console.error(`[dev-bot] MCP surface probe cleanup failed for ${probeId}: ${e.message}`)
      }
    }
    probe?.close()
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

const NOTIFICATION_CANARY_FAMILIES = [
  { family: 'claude', name: `${BOT_KEY}-notify-canary-claude`, model: () => NOTIFICATION_CONSUMPTION_CLAUDE_MODEL },
  { family: 'codex', name: `${BOT_KEY}-notify-canary-codex`, model: () => NOTIFICATION_CONSUMPTION_CODEX_MODEL },
]

function canaryProvisioningError(family, message, reason = null) {
  return new CanaryProvisioningError(`${family} canary provisioning failure: ${message}`, { family, reason })
}

function notificationConsumptionError(family, message) {
  return new NotificationConsumptionError(`${family} notification consumption failure: ${message}`, { family })
}

function requestPayload(response) {
  return response && typeof response === 'object' && response.result && typeof response.result === 'object'
    ? response.result
    : response
}

function isCheckAliveTransportTimeout(error) {
  return /^check-alive timed out after \d+ms$/.test(String(error?.message || error))
}

async function wakeNotificationCanary(agentId) {
  return fetchJson(FLEET_SERVER, `/api/agents/${encodeURIComponent(agentId)}/wake`, { method: 'POST' })
}

async function proveCanaryRoute({ family, agentId, request = sendRequest, resolve = resolveAgent, readSeat = readAgentSeat, wake = wakeNotificationCanary }) {
  const agent = await resolve(agentId)
  if (!agent || agent.dead) {
    throw canaryProvisioningError(family, `${agentId} does not resolve to a live agent`)
  }
  if (metadataOf(agent).shell === true) {
    throw canaryProvisioningError(family, `${agentId} is still a pending shell`)
  }
  const seat = await readSeat(agent.id)
  if (!seat?.daemon_key) {
    throw canaryProvisioningError(family, `${agent.id} has no current daemon route/terminal seat`, 'missing-route')
  }
  let alive
  try {
    alive = requestPayload(await request({ type: 'check-alive', agent: agent.id }, REQUEST_TIMEOUT_MS))
  } catch (error) {
    if (isCheckAliveTransportTimeout(error)) {
      throw canaryProvisioningError(family, `${agent.id} check-alive transport timed out`, 'indeterminate')
    }
    throw error
  }
  const wakeable = alive?.state === 'hibernating'
    || (alive?.state === 'dead' && /terminal capability unavailable|no tmux/i.test(String(alive?.reason || '')))
  if (wakeable) {
    let woke
    try {
      woke = requestPayload(await wake(agent.id))
    } catch (error) {
      throw canaryProvisioningError(family, `wake failed for ${agent.id}: ${error?.message || error}`, 'wake-failed')
    }
    if (!woke?.ok || (woke.agent_id && woke.agent_id !== agent.id)) {
      throw canaryProvisioningError(family, `wake did not confirm the same canary identity ${agent.id} (${JSON.stringify(woke)})`, 'wake-refused')
    }
    const resumed = await resolve(agent.id)
    const resumedSeat = resumed?.id === agent.id ? await readSeat(resumed.id) : null
    if (!resumed || resumed.dead || resumed.id !== agent.id || !resumedSeat?.session_id || !resumedSeat?.terminal_capability || resumedSeat.daemon_key !== seat.daemon_key) {
      throw canaryProvisioningError(family, `wake did not preserve ${agent.id} on daemon route ${seat.daemon_key}`, 'wake-route-mismatch')
    }
    try {
      alive = requestPayload(await request({ type: 'check-alive', agent: resumed.id }, REQUEST_TIMEOUT_MS))
    } catch (error) {
      if (isCheckAliveTransportTimeout(error)) {
        throw canaryProvisioningError(family, `${resumed.id} post-wake check-alive transport timed out`, 'indeterminate')
      }
      throw error
    }
    if (alive?.state === 'alive') return { agent: resumed, seat: resumedSeat }
  }
  if (alive?.state !== 'alive') {
    throw canaryProvisioningError(family, `${agent.id} route exists but daemon reports state=${alive?.state || 'unknown'} reason=${alive?.reason || 'none'}`)
  }
  if (!seat.session_id || !seat.terminal_capability) {
    throw canaryProvisioningError(family, `${agent.id} has no current daemon route/terminal seat`)
  }
  return { agent, seat }
}

export async function ensureNotificationCanary(spec, {
  request = sendRequest,
  waitReady = waitForSpawnReady,
  resolve = resolveAgent,
  readSeat = readAgentSeat,
  wake = wakeNotificationCanary,
  now = () => Date.now(),
} = {}) {
  const model = String(spec.model() || '').trim()
  if (!model) throw canaryProvisioningError(spec.family, 'no model configured')
  const existing = await resolve(spec.name)
  if (existing && !existing.dead && metadataOf(existing).shell !== true) {
    const route = await proveCanaryRoute({ family: spec.family, agentId: existing.id, request, resolve, readSeat, wake })
    return { ...route, spawned: false, model }
  }

  const spawn = requestPayload(await request({
    type: 'spawn',
    fresh: true,
    name: spec.name,
    cwd: REPO_ROOT,
    model,
    effort: 'low',
    mailboxTarget: AGENT_ID,
  }, REQUEST_TIMEOUT_MS))
  if (!spawn?.ok || spawn.status !== 'pending' || !spawn.agent_id) {
    throw canaryProvisioningError(spec.family, `spawn did not return a pending canary agent (${JSON.stringify(spawn)})`)
  }
  const ready = await waitReady(spawn.agent_id, now() + NOTIFICATION_CONSUMPTION_TIMEOUT_MS)
  const route = await proveCanaryRoute({ family: spec.family, agentId: ready.agent.id, request, resolve, readSeat, wake })
  return { ...route, spawned: true, mailboxId: spawn.mailbox_id || null, model }
}

function eventHasRecipient(event, agentId) {
  const recipients = event.recipients || event.to || event.to_ids || event.recipient_ids || null
  if (!recipients) return true
  if (Array.isArray(recipients)) return recipients.includes(agentId)
  return String(recipients || '').includes(agentId)
}

function eventFrom(event) {
  return event.from_id || event.from || event.sender || event.agent_id || null
}

async function waitForCanaryReply({ family, canaryId, token, since, deadline, request = sendRequest, now = () => Date.now(), sleepMs = sleep }) {
  while (now() < deadline) {
    const history = requestPayload(await request({
      type: 'fleet-search',
      query: token,
      me: AGENT_ID,
      agent: AGENT_ID,
      agentOnly: true,
      historyOnly: true,
      eventOnly: true,
      eventType: 'chat',
      since,
      limit: 50,
    }, 5000))
    const events = (Array.isArray(history?.results) ? history.results : []).filter(r => r.source === 'fleet')
    const found = events.find(event => {
      const text = event.text || event.message || ''
      return text.includes(token) && eventFrom(event) === canaryId && eventHasRecipient(event, AGENT_ID)
    })
    if (found) return found
    await sleepMs(1000)
  }
  throw notificationConsumptionError(family, `${canaryId} did not produce token ${token} before deadline`)
}

async function checkOneNotificationCanary(spec, {
  request = sendRequest,
  waitReady = waitForSpawnReady,
  resolve = resolveAgent,
  readSeat = readAgentSeat,
  wake = wakeNotificationCanary,
  uuid = randomUUID,
  now = () => Date.now(),
  sleepMs = sleep,
} = {}) {
  const canary = await ensureNotificationCanary(spec, { request, waitReady, resolve, readSeat, wake, now })
  const hibernated = requestPayload(await request({ type: 'hibernate-session', agent: canary.agent.id }, REQUEST_TIMEOUT_MS))
  if (!hibernated?.ok) {
    throw canaryProvisioningError(spec.family, `hibernate did not confirm ${canary.agent.id} can be controlled (${JSON.stringify(hibernated)})`)
  }
  const token = `notify-consumed:${spec.family}:${uuid()}`
  const since = new Date(now() - 60_000).toISOString()
  const sentAt = new Date().toISOString()
  const message = [
    `Dev bot live notification consumption probe.`,
    `Call inbox() now, then reply to ${AGENT_NAME} with exactly this token:`,
    token,
  ].join('\n')
  const sent = requestPayload(await request({
    type: 'chat',
    from: AGENT_ID,
    to: canary.agent.id,
    message,
    _tempId: `${BOT_KEY}:notification-consumption:${token}`,
  }, REQUEST_TIMEOUT_MS))
  const eventIds = Array.isArray(sent?.event_ids) ? sent.event_ids.map(Number).filter(Number.isFinite) : []
  if (!eventIds.length) {
    throw notificationConsumptionError(spec.family, `chat to ${canary.agent.id} returned no accepted event id`)
  }
  const reply = await waitForCanaryReply({
    family: spec.family,
    canaryId: canary.agent.id,
    token,
    since,
    deadline: now() + NOTIFICATION_CONSUMPTION_TIMEOUT_MS,
    request,
    now,
    sleepMs,
  })
  return {
    family: spec.family,
    canaryId: canary.agent.id,
    canaryName: canary.agent.friendly_name || canary.agent.name || spec.name,
    model: canary.model,
    spawned: canary.spawned,
    sentEventIds: eventIds,
    replyEventId: reply.id || reply.event_id || null,
    sentAt,
    consumedAt: reply.timestamp || reply.ts || null,
    seat: {
      sessionId: canary.seat.session_id,
      daemonKey: canary.seat.daemon_key,
    },
  }
}

export async function checkNotificationConsumption(options = {}) {
  if (notificationConsumptionProbeInFlight) {
    return { skipped: true, reason: 'previous probe still in flight' }
  }
  notificationConsumptionProbeInFlight = true
  try {
    const results = await Promise.all(NOTIFICATION_CANARY_FAMILIES.map(spec => checkOneNotificationCanary(spec, options)))
    return { canaries: results }
  } finally {
    notificationConsumptionProbeInFlight = false
  }
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

// Whether ANY daemon claims this agent. Distinct from daemonCanPlace, which asks
// about this one: an agent belonging to another machine legitimately has a row
// under a different key, and must not be called stale for it.
function daemonKnowsAnywhere(agentId) {
  if (!DAEMON_LEDGER_DB) return null
  try {
    return !!daemonLedger()?.prepare('SELECT 1 FROM permission_grants WHERE id = ? LIMIT 1').get(agentId)
  } catch {
    return null
  }
}

function hasLocalSession(name) {
  if (!name) return null
  try {
    execFileSync('tmux', ['has-session', '-t', `fleet-${name}`], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch (e) {
    // Exit 1 is "no such session", which is the answer. Anything else -- tmux
    // missing, server unreachable -- is not measured, and must not read as absent.
    return e?.status === 1 ? false : null
  }
}

function tmuxSessionExists(sessionName) {
  if (!sessionName) return null
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch (e) {
    return e?.status === 1 ? false : null
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
// A roster read that fails is this check being unable to run, NOT a finding about
// any agent -- so it raises ProbeSetupError, which the notifier suppresses by
// default. On 2026-08-08 a deploy window returned HTTP 502 here and on-call was
// nudged with `fleet-table (awake) returned HTTP 502`, which is an alarm crying
// during normal operation: deploys are normal, and this bot is restarted through
// them all evening.
//
// Nothing is lost by not shouting. A server that is genuinely down fails
// `doc-load` and `chat-roundtrip`, which ARE findings and do nudge; a server that
// blinked for thirty seconds should say nothing. The suppression is recorded as
// `probe-setup-failed` in the heartbeat either way, so a roster read that fails
// forever is still visible to anyone looking.
async function fleetTableRows(filter) {
  let res
  try {
    res = await fetch(`${FLEET_SERVER}/api/fleet-table?filter=${encodeURIComponent(filter)}&limit=500`, {
      signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
    })
  } catch (e) {
    throw new ProbeSetupError(`fleet-table (${filter}) did not answer: ${e.message}`)
  }
  if (!res.ok) throw new ProbeSetupError(`fleet-table (${filter}) returned HTTP ${res.status}`)
  let data
  try {
    data = await res.json()
  } catch (e) {
    throw new ProbeSetupError(`fleet-table (${filter}) returned invalid JSON: ${e.message}`)
  }
  return Array.isArray(data?.agents) ? data.agents : []
}

async function lookupAgentsByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean).map(String))]
  if (!unique.length) return []
  const agents = []
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200)
    let res
    try {
      res = await fetch(`${FLEET_SERVER}/api/agents/lookup?ids=${encodeURIComponent(batch.join(','))}`, {
        signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
      })
    } catch (e) {
      throw new ProbeSetupError(`agents lookup did not answer: ${e.message}`)
    }
    if (!res.ok) throw new ProbeSetupError(`agents lookup returned HTTP ${res.status}`)
    let data
    try {
      data = await res.json()
    } catch (e) {
      throw new ProbeSetupError(`agents lookup returned invalid JSON: ${e.message}`)
    }
    if (Array.isArray(data?.agents)) agents.push(...data.agents)
  }
  return agents
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
  }, 10_000).catch(e => { throw new ProbeSetupError(`session history for ${agentId} did not answer: ${e.message}`) })
  const rows = (Array.isArray(result?.results) ? result.results : []).filter(r => r.source === 'session')
  return rows[0]?.timestamp || null
}

// The most recent chat this agent RECEIVED from something that is not a bot and
// not itself. Bot senders are excluded by sender id, not by guessing at text:
// over three days of testing history, todd check-ins and build notices were 15
// of the 37 raw instances of this condition and every one of them was benign.
// An agent does not owe a bot nudge a reaction.
async function lastRealDeliveryTo(agentId, botIds, sinceIso) {
  const rows = await chatRows(agentId, sinceIso)
  const received = rows.filter(row =>
    row.from && row.from !== agentId && !botIds.has(row.from) &&
    (Array.isArray(row.recipients) ? row.recipients.includes(agentId) : true))
  received.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
  return received[0] || null
}

async function chatRows(agentId, sinceIso) {
  const result = await sendRequest({
    type: 'fleet-search', query: '', me: AGENT_ID, agent: agentId, agentOnly: true,
    historyOnly: true, eventOnly: true, eventType: 'chat', since: sinceIso, limit: 50,
  }, 10_000).catch(e => { throw new ProbeSetupError(`chat history for ${agentId} did not answer: ${e.message}`) })
  return (Array.isArray(result?.results) ? result.results : []).filter(r => r.source === 'fleet')
}

// A chat the agent sent after the delivery is output, whatever runs it: a
// cloud session has no transcript here, so its session history is always
// empty, and a cloud agent answering every message read as having produced
// nothing (app-qc-reviewer, 2026-11-11). Read from the delivery forward:
// paging runs oldest-first, so a read over the whole lookback returns a busy
// agent's oldest fifty chats and never reaches its recent ones.
async function sentChatSince(agentId, sinceIso) {
  return (await chatRows(agentId, sinceIso)).some(row => row.from === agentId && String(row.timestamp || '') > sinceIso)
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

function readJsonObject(text, context) {
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch (e) {
    throw new ProbeSetupError(`${context} contains invalid JSON: ${e.message}`)
  }
}

function readDaemonMintRows(dbPath = DAEMON_MINT_DB) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare(`SELECT
        mint_id, fleet_id, friendly_name, metadata, launch_recipe, process_state,
        session_id, session_path, joined_at, created_at, updated_at
        FROM daemon_mints`).all()
    } finally {
      db.close()
    }
  } catch (e) {
    throw new ProbeSetupError(`daemon mint store ${dbPath} could not be read: ${e.message}`)
  }
}

function readDaemonGrantRows() {
  try {
    const db = daemonLedger()
    if (!db) throw new Error('ledger did not open')
    return db.prepare(`SELECT
      id, permission_grant, updated_at, source, friendly_name, session_id,
      session_kind, session_path, tmux_session, model, machine_id, env_name,
      daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants`).all() || []
  } catch (e) {
    throw new ProbeSetupError(`permission_grants ledger ${DAEMON_LEDGER_DB} could not be read: ${e.message}`)
  }
}

function explicitMintEnv(row, processState, grant) {
  const botEnv = String(row.mint_id || '').match(/^bot:([^:]+):/)?.[1] || null
  return processState?.env_name || grant?.env_name || botEnv || null
}

function mintBelongsToConfig(row, processState, grant) {
  const env = explicitMintEnv(row, processState, grant)
  if (env && env !== CONFIG_NAME) return false
  const daemonKey = processState?.daemon_key || grant?.daemon_key || null
  if (daemonKey && daemonKey !== DAEMON_KEY) return false
  return true
}

function ageMinutes(now, iso) {
  const at = Date.parse(iso || '')
  if (!Number.isFinite(at)) return null
  return Math.round((now - at) / 60_000)
}

function agentLabel(row) {
  return row.friendly_name || row.fleet_id || row.mint_id
}

function formatJoinFinding(row, reasons, ageMin) {
  const id = row.fleet_id ? ` (\`${row.fleet_id}\`)` : ''
  return [
    `**${agentLabel(row)}**${id} has incoherent mint/daemon join state after ${ageMin} minutes.`,
    ...reasons.map(reason => `- ${reason}`),
  ].join('\n')
}

export async function checkMisconfiguredAgents({
  mintRows = readDaemonMintRows(),
  grantRows = readDaemonGrantRows(),
  agentRowsByIds = lookupAgentsByIds,
  now = () => Date.now(),
  joinGraceMs = AGENT_JOIN_GRACE_MS,
  sessionExists = tmuxSessionExists,
} = {}) {
  const currentTime = now()
  const grants = new Map(grantRows.filter(row => row?.id).map(row => [row.id, row]))
  const candidateFindings = []
  const findings = []
  let checked = 0
  let young = 0
  for (const row of mintRows) {
    const processState = readJsonObject(row.process_state, `mint ${row.mint_id} process_state`)
    const grant = row.fleet_id ? grants.get(row.fleet_id) || null : null
    if (!mintBelongsToConfig(row, processState, grant)) continue

    const createdAt = Date.parse(row.created_at || '')
    if (!Number.isFinite(createdAt)) {
      throw new ProbeSetupError(`mint ${row.mint_id} has unreadable created_at ${JSON.stringify(row.created_at)}`)
    }
    if (currentTime - createdAt < joinGraceMs) {
      checked += 1
      young += 1
      continue
    }

    const reasons = []
    const rowSession = row.session_id || null
    const processSession = processState?.session_id || null
    const ageMin = ageMinutes(currentTime, row.created_at)
    if (row.fleet_id && !grant) {
      reasons.push('fleet seat exists, but there is no `permission_grants` row; daemon terminal operations cannot place it')
    }
    if (row.fleet_id && !rowSession && !processSession) {
      if (processState) {
        const tmuxSession = processState.tmux_session || null
        const exists = sessionExists(tmuxSession)
        reasons.push(`process_state exists${tmuxSession ? ` for \`${tmuxSession}\`` : ''}, but no session_id ever joined${exists === true ? '; the tmux session still exists' : exists === false ? '; the tmux session is gone' : ''}`)
      } else {
        reasons.push('fleet seat exists, but the mint has no process_state and no session_id')
      }
    }
    if (!row.fleet_id && processState) {
      reasons.push('process_state exists, but no fleet seat was recorded')
    }
    if (grant && row.fleet_id && !grant.session_id) {
      reasons.push('permission_grants row exists, but it has no session_id')
    }
    if (grant?.daemon_key && processState?.daemon_key && grant.daemon_key !== processState.daemon_key) {
      reasons.push(`permission_grants daemon_key \`${grant.daemon_key}\` disagrees with process_state daemon_key \`${processState.daemon_key}\``)
    }
    if (reasons.length) {
      candidateFindings.push({ row, reasons, ageMin })
    } else {
      checked += 1
    }
  }

  const candidateFleetIds = candidateFindings.map(({ row }) => row.fleet_id).filter(Boolean)
  const agentRows = candidateFleetIds.length ? await agentRowsByIds(candidateFleetIds) : []
  const agentsById = new Map(agentRows.filter(agent => agent?.id).map(agent => [agent.id, agent]))
  for (const candidate of candidateFindings) {
    const { row, reasons, ageMin } = candidate
    const agent = row.fleet_id ? agentsById.get(row.fleet_id) || null : null
    if (agent?.dead === true || agent?.dead === 1) continue
    checked += 1
    findings.push(formatJoinFinding(row, reasons, ageMin))
  }

  if (findings.length) {
    throw new Error(findings.join('\n\n'))
  }
  return {
    checked,
    young,
    graceMin: Math.round(joinGraceMs / 60_000),
    mintStore: DAEMON_MINT_DB,
    ledger: DAEMON_LEDGER_DB,
  }
}

export async function checkAgentReceiving() {
  if (!agentWatchDue('receiving')) return agentWatchReplay('receiving')
  try {
    const result = await runAgentReceiving()
    agentWatchRecord('receiving', result, null)
    return result
  } catch (e) {
    // A setup failure is not cached and does not hold the cadence. Caching it
    // would replay a transient -- a deploy window's HTTP 502 -- for the whole
    // five-minute window, and the replay path reconstructs a plain Error, which
    // would launder it into a real finding and nudge on-call about a blip.
    if (e instanceof ProbeSetupError) {
      agentWatchState.delete('receiving')
      throw e
    }
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
    if (await sentChatSince(row.id, delivery.timestamp)) continue
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
      knownAnywhere: daemonKnowsAnywhere(row.id),
      localSession: hasLocalSession(row.name || null),
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
        ? '- **no `permission_grants` row for this daemon — it cannot be killed, restarted or typed into. `restart-mcp` will print `ok` and do nothing.**'
        : entry.placeable === null ? '- daemon placement: not measured (ledger unreadable)' : null,
      // A stale row and a silent agent need different actions, and until now the
      // notice said the same thing about both. When no daemon anywhere claims the
      // agent AND no tmux session exists on this machine, nothing is running it,
      // so `awake` is the row being wrong rather than the agent being quiet. The
      // one path that could correct it -- `hibernate` -- short-circuits on
      // "already hibernating" without emitting a transition, so the row stays
      // wrong forever and this alarm cannot clear on its own. Both conditions are
      // required: an agent on another machine legitimately has a row elsewhere.
      entry.knownAnywhere === false && entry.localSession === false
        ? '- **the roster says `awake`, and nothing is running it** — no tmux session on this machine, no daemon ledger row anywhere. This is a stuck row, not a silent agent, and `hibernate` short-circuits without correcting it.'
        : null,
    ].filter(Boolean).join('\n')).join('\n\n')
    const preface = hasActivityAt
      ? ''
      : '_Degraded: this server does not send `activity_at`, so every awake agent was queried instead of only the silent ones._\n\n'
    throw new Error(`${preface}${lines}`)
  }
  return {
    watched: rows.length,
    queried: candidates.length,
    windowMin: Math.round(AGENT_SILENCE_WINDOW_MS / 60_000),
    watchedIds: rows.map(row => row.id),
  }
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
  let report, describeServerImportFailures
  try {
    // The check comes from the checkout it checks, so its list of what the
    // image ships cannot fall behind that checkout's Dockerfile. A private copy
    // here did, on 2026-11-10, and reported shipped files as missing.
    // Keyed by the file's mtime: the script holds the shipped-path list as a
    // module constant, so a cached import keeps checking against a stale list.
    const checkPath = `${SERVER_IMPORTS_REPO}/scripts/check-server-imports.mjs`
    const check = await import(`${importCheckUrl(checkPath).href}?mtime=${fs.statSync(checkPath).mtimeMs}`)
    describeServerImportFailures = check.describeServerImportFailures
    report = check.checkServerImports({ repoRoot: SERVER_IMPORTS_REPO })
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
// A rename is the sanctioned bot stop, so a bot living under a name that is not
// its own was switched off on purpose. Only the ledger records that: on disk a
// bot somebody quieted and a bot that crashed are the same stale heartbeat file.
//
// Asked as POSITIVE evidence, deliberately. The obvious test -- "no living agent
// holds the canonical name" -- is an absence, and an absence is also what a
// broken query returns: one bad filter and every bot looks quieted and nothing
// can ever alarm again. So a bot counts as quieted only when the roster actually
// shows an agent OF THAT MODEL living under a different name. An empty answer
// proves nothing and alarms, which is the safe direction.
//
// Keyed on the model rather than the name because that is what survives a rename
// -- `AGENTS.md` §"One bot of a model, for its whole life". Same rule and same
// reasoning as todd's `quietedBotNames`; the survey underneath is now literally
// the same function.
export async function quietedBotNames(declared, { fetchRows = fleetTableRows } = {}) {
  if (!declared.length) return new Set()
  let rows
  try {
    rows = await fetchRows(declared.map(name => `model:${name}`).join(' | '))
  } catch (e) {
    console.error(`[dev-bot] quieted-bot lookup failed: ${e.message}`)
    return new Set()
  }
  // `/api/fleet-table` rows carry `name` and `status`. They do NOT carry
  // `friendly_name` or `dead`, and reading those instead is not a near miss: the
  // canonical-name test silently never matches, so every model with any living
  // agent reads as quieted and the whole alarm goes away. Measured against the
  // live store on 2026-09-12 — `todd` was running under its own name and would
  // have been classified quieted. The test below holds this down.
  const living = rows.filter(agent => agent && agent.status !== 'dead')
  const quieted = new Set()
  for (const name of declared) {
    const ofModel = living.filter(agent => String(agent.model || '').toLowerCase() === name)
    if (!ofModel.length) continue
    if (ofModel.some(agent => String(agent.name || '').toLowerCase() === name)) continue
    quieted.add(name)
  }
  return quieted
}

// This check used to carry its own copy of the survey, and the copy is what made
// the defect survivable: todd's was fixed on 2026-09-12 and this one alarmed on
// exactly the same false positive because nothing connected them. `@tlda/bot`
// has exported `surveyBotHeartbeats` for both bots since it was written -- the
// export comment says "todd, dev" -- so there is one classifier again and the
// count of implementations goes from two to one.
//
// What this check does with the classification is still its own: it alarms on
// `stopped` and `deaf`, degrades on `unmonitored`, and now reports `quieted` and
// `undeclared` as context without alarming on either. `undeclared` is new
// information the shared survey produces and the old copy could not see; it is
// reported rather than alarmed on, because adding an alarm nobody asked for is a
// separate decision from removing a false one.
export async function checkBotHeartbeats({
  declaredBots = BOT_ENVIRONMENTS[CONFIG_NAME] || [],
  heartbeatDir = CONFIG_DIR,
  now = () => Date.now(),
  quietedNames = quietedBotNames,
} = {}) {
  const declared = declaredBots
    .map(name => String(name).toLowerCase())
    .filter(name => name !== BOT_KEY)
  if (!declared.length) return { skipped: true, blocked: true, reason: `no bots declared for environment ${CONFIG_NAME}` }

  const quieted = await quietedNames(declared)
  const survey = surveyBotHeartbeats({
    declaredBots: declared,
    heartbeatDir,
    envName: CONFIG_NAME,
    staleMs: BOT_HEARTBEAT_STALE_MS,
    exclude: [BOT_KEY],
    isQuieted: name => quieted.has(name),
    now,
  })

  const stopped = survey.stopped || []
  const deaf = survey.deaf || []
  const quietedRows = survey.quieted || []
  const undeclared = survey.undeclared || []
  const unmonitored = (survey.unmonitored || []).map(entry => entry.name)

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
  if (stopped.length || deaf.length) {
    const lines = [
      ...stopped.map(entry =>
        `**${entry.name}** is declared for \`${CONFIG_NAME}\` and has not written a heartbeat for ${entry.staleMin} minutes (\`${entry.file}\`). It was beating before, so it stopped.`),
      ...deaf.map(entry =>
        `**${entry.name}** is declared for \`${CONFIG_NAME}\` and has written heartbeats for ${entry.staleMin} minutes without hearing a fleet event (\`${entry.file}\`, last reason: ${entry.reason || 'unknown'}). It is alive but deaf.`),
    ]
    if (quietedRows.length) {
      lines.push(`Quieted on purpose, not a fault: ${quietedRows.map(entry => entry.name).join(', ')} — renamed away from the canonical name, so inert by design.`)
    }
    throw new Error(lines.join('\n\n') + `\n\nBeating: ${survey.beating.length ? survey.beating.join(', ') : 'none'}. Either restore the bot's fleet hearing, start it, or stop declaring it in \`bots.yaml\`; those clear this.`)
  }
  return {
    declared: declared.length,
    beating: survey.beating,
    ...(quietedRows.length ? { quieted: quietedRows.map(entry => entry.name) } : {}),
    ...(undeclared.length ? { undeclared: undeclared.map(entry => entry.name) } : {}),
    ...(unmonitored.length ? { unmonitored, blocked: true, reason: `declared with no heartbeat instrument: ${unmonitored.join(', ')}` } : {}),
  }
}

function compactFailure(results) {
  return results
    .filter(r => !r.ok)
    .map(r => `${r.name}${r.failureKind ? ` [${r.failureKind}]` : ''}${r.family ? ` [${r.family}]` : ''}: ${r.indeterminate ? 'indeterminate: ' : ''}${r.error}`)
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
const REQUIRED_CHECKS = ['doc-load', 'doc-render', 'chat-roundtrip', 'mcp-surface', 'spawn-wake-seat', 'notification-consumption', 'linked-remote-safety', 'agent-receiving', 'misconfigured-agents', 'file-materialization', 'server-imports', 'bot-heartbeats', 'resource-cleanup', 'box-memory', 'box-disk']

// The box-memory watch: Mini memory-pressure signals for the ops team, from
// ops-oncall's night of hand sampling (swapout rate, top-N by full command
// with per-pid deltas, pressure transitions, playwright triple) plus the
// chief's climber leg (single-process growth rate, browsers only).
//
// An open excursion fails the check, which nudges on-call with the transition,
// the rate and window, the largest process by full command line, and the
// firing state; the standard recovery path announces the clear. No leg acts on
// anything except the climber leg feeding the reaper, and only when
// TLDA_DEV_BOT_BOX_MEMORY_REAP_CLIMBERS is set: detection and alerting run
// regardless of the flag. A pid killed on one sweep is gone from the next
// sample and stops tripping on its own, so no sent-pids set is needed — the
// reaper's fresh-read verification is the guard against pid reuse.
function boxMemoryRunner(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 })
}

export async function checkBoxMemory({
  watch = boxMemoryWatch,
  reaper = climberReaper,
  reapClimbers = BOX_MEMORY_REAP_CLIMBERS,
  run = boxMemoryRunner,
  sample = null,
} = {}) {
  let assessment
  try {
    assessment = watch.observe(sample || collectBoxMemorySample({ run }))
  } catch (e) {
    if (e instanceof BoxMemorySetupError) throw new ProbeSetupError(`box-memory: ${e.message}`)
    throw e
  }
  if (!assessment.excursion) {
    return {
      pressure: assessment.pressure.level,
      settledLevel: assessment.pressure.settledLevel,
      swapoutRatePerS: assessment.swap.ratePerS,
      swapoutWindowS: assessment.swap.windowS,
      triple: { servers: assessment.triple.servers, browsers: assessment.triple.browsers, orphans: assessment.triple.orphans },
      largest: assessment.largest ? { pid: assessment.largest.pid, rssKb: assessment.largest.rssKb } : null,
    }
  }
  const notice = [formatExcursionNotice(assessment)]
  const climberLeg = assessment.excursion.legs.climber
  if (climberLeg) {
    if (!reapClimbers) {
      notice.push('- climber reaping: disabled (TLDA_DEV_BOT_BOX_MEMORY_REAP_CLIMBERS is off); detection and alerting only')
    } else {
      const candidates = assessment.climbers.map(entry => ({ pid: entry.pid, rssKb: entry.rssKb }))
      const results = await reaper.reap(candidates)
      for (const result of results) {
        // Continuation lines, not `- ` lines: reap outcomes change sweep to
        // sweep (killed, then gone) and must not churn the nudge key. The
        // durable record is the heartbeat below, written on every action.
        notice.push(`  reap pid ${result.pid}: ${result.killed ? 'killed' : 'NOT killed'} — ${result.reason}`)
      }
      if (results.length) {
        writeHeartbeat('box-memory-reap', {
          pids: results.map(result => result.pid),
          killed: results.filter(result => result.killed).map(result => result.pid),
          results: results.map(({ pid, verified, killed, reason }) => ({ pid, verified, killed, reason })),
        })
      }
    }
  }
  throw new Error(notice.join('\n'))
}

function summarizeCleanupReclaimed(cleanupDetail) {
  if (!cleanupDetail || typeof cleanupDetail !== 'object') return null
  if (cleanupDetail.skipped) return `skipped (${cleanupDetail.reason || 'in flight'})`
  const parts = []
  if (cleanupDetail.worktrees) {
    const reclaimedWorktreeBytes = Math.max(
      0,
      (Number(cleanupDetail.worktrees.totalBytes) || 0) - (Number(cleanupDetail.worktrees.retainedBytes) || 0),
    )
    parts.push(`worktrees evicted=${cleanupDetail.worktrees.evicted || 0} (${formatMiB(reclaimedWorktreeBytes)})`)
  }
  if (cleanupDetail.configLogs) {
    parts.push(`configLogs trimmed=${cleanupDetail.configLogs.trimmedCount || 0} (${formatMiB(cleanupDetail.configLogs.reclaimedBytes || 0)})`)
  }
  if (cleanupDetail.claudeTmp) {
    parts.push(`claudeTmp removed=${cleanupDetail.claudeTmp.removed || 0} (${formatMiB(cleanupDetail.claudeTmp.removedBytes || 0)})`)
  }
  if (cleanupDetail.harnessRollouts) {
    if (cleanupDetail.harnessRollouts.skippedFailClosed) {
      parts.push(`harnessRollouts=fail-closed (${cleanupDetail.harnessRollouts.reason})`)
    } else {
      parts.push(`harnessRollouts removed=${cleanupDetail.harnessRollouts.removed || 0} (${formatMiB(cleanupDetail.harnessRollouts.removedBytes || 0)})`)
    }
  }
  return parts.length ? parts.join(', ') : '0 B reclaimed'
}

const boxDiskState = { tripped: false }

export async function checkBoxDisk({
  state = boxDiskState,
  sampleDisk = () => collectDiskSample(),
  warnFreeBytes = DEFAULT_DISK_WARN_FREE_BYTES,
  criticalFreeBytes = DEFAULT_DISK_CRITICAL_FREE_BYTES,
  runCleanup = options => checkResourceCleanup(options),
  sampleTopConsumers = () => collectTopDiskConsumers(),
} = {}) {
  let sample
  let verdict
  try {
    sample = await sampleDisk()
    verdict = evaluateDiskSample(sample, { warnFreeBytes, criticalFreeBytes, wasTripped: state.tripped })
    state.tripped = verdict.tripped
  } catch (e) {
    if (e instanceof BoxDiskSetupError || e?.setupFailure) {
      throw new ProbeSetupError(`box-disk: ${e.message}`)
    }
    throw e
  }

  if (!verdict.tripped) {
    return {
      mountPoint: verdict.mountPoint,
      freeBytes: verdict.freeBytes,
      totalBytes: verdict.totalBytes,
      usedPct: verdict.usedPct,
      level: verdict.level,
    }
  }

  let cleanupDetail = null
  let cleanupError = null
  try {
    cleanupDetail = await runCleanup({
      forceFullSweep: true,
      worktreeBudgetBytes: verdict.level === 'critical' ? 0 : undefined,
    })
  } catch (e) {
    cleanupError = e?.message || String(e)
  }

  const afterSample = await Promise.resolve().then(() => sampleDisk()).catch(() => null)
  const topConsumers = await Promise.resolve().then(() => sampleTopConsumers()).catch(() => [])
  const cleanupSummary = cleanupError
    ? `failed (${cleanupError})`
    : summarizeCleanupReclaimed(cleanupDetail)

  throw new Error(formatDiskNotice(verdict, { afterSample, cleanupSummary, topConsumers }))
}

export async function checkResourceCleanup({
  previewReaper = reapIdlePreviews,
  playwrightCleanup = playwrightPoolCleanup,
  worktreeCleanupDriver = worktreeCleanup,
  configLogCleanupDriver = null,
  claudeTmpCleanupDriver = null,
  harnessRolloutCleanupDriver = null,
  forceFullSweep = false,
  worktreeBudgetBytes = undefined,
  now = () => Date.now(),
} = {}) {
  if (resourceCleanupInFlight) return { skipped: true, reason: 'previous cleanup still in flight' }
  resourceCleanupInFlight = true
  try {
    const previews = previewReaper()
    const results = await playwrightCleanup.sweep()
    const errors = [
      ...(Array.isArray(previews?.failed) ? previews.failed.map(entry => `preview pid=${entry.pid || '?'} port=${entry.port || '?'}: ${entry.error || 'failed'}`) : []),
      ...results.filter(result => result.state === 'error').map(result => `Playwright ${result.session}: ${result.error || 'failed'}`),
    ]
    const summary = {
      previews: {
        reaped: Array.isArray(previews?.reaped) ? previews.reaped.length : 0,
        failed: Array.isArray(previews?.failed) ? previews.failed.length : 0,
      },
      playwright: results.map(result => ({ session: result.session, state: result.state })),
    }

    if (forceFullSweep || now() - lastWorktreeCleanupAt >= WORKTREE_CLEANUP_INTERVAL_MS) {
      const worktrees = await worktreeCleanupDriver.sweep(
        worktreeBudgetBytes !== undefined ? { budgetBytes: worktreeBudgetBytes } : undefined,
      )
      lastWorktreeCleanupAt = now()
      if (typeof statusSamples !== 'undefined' && Array.isArray(statusSamples)) {
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
      }
      summary.worktrees = {
        removed: worktrees.removedWorktrees.length,
        evicted: worktrees.evicted.length,
        pinned: worktrees.pinned.length,
        abandoned: worktrees.abandoned.length,
        unremovable: worktrees.unremovable.length,
        totalBytes: worktrees.totalBytes,
        retainedBytes: worktrees.retainedBytes,
        overBudgetBytes: worktrees.overBudgetBytes,
      }
      for (const entry of worktrees.unremovable) {
        errors.push(`worktree ${entry.path}: ${entry.error || 'could not remove'}`)
      }

      const useDefaultRetentionDrivers = worktreeCleanupDriver === (typeof worktreeCleanup !== 'undefined' ? worktreeCleanup : null)
      const effectiveConfigLogDriver = configLogCleanupDriver || (useDefaultRetentionDrivers && typeof configLogCleanup !== 'undefined' ? configLogCleanup : null)
      if (effectiveConfigLogDriver?.sweep) {
        const configLogs = await effectiveConfigLogDriver.sweep()
        summary.configLogs = {
          trimmedCount: configLogs.trimmedCount,
          reclaimedBytes: configLogs.reclaimedBytes,
        }
        for (const err of configLogs.errors || []) {
          errors.push(`config-log ${err}`)
        }
      }

      const effectiveClaudeTmpDriver = claudeTmpCleanupDriver || (useDefaultRetentionDrivers && typeof claudeTmpCleanup !== 'undefined' ? claudeTmpCleanup : null)
      if (effectiveClaudeTmpDriver?.sweep) {
        const claudeTmp = await effectiveClaudeTmpDriver.sweep()
        summary.claudeTmp = {
          removed: claudeTmp.removed,
          removedBytes: claudeTmp.removedBytes,
          retained: claudeTmp.retained,
          retainedBytes: claudeTmp.retainedBytes,
        }
        for (const err of claudeTmp.errors || []) {
          errors.push(`claude-tmp ${err}`)
        }
      }

      const effectiveHarnessRolloutDriver = harnessRolloutCleanupDriver || (useDefaultRetentionDrivers && typeof harnessRolloutCleanup !== 'undefined' ? harnessRolloutCleanup : null)
      if (effectiveHarnessRolloutDriver?.sweep) {
        const harnessRollouts = await effectiveHarnessRolloutDriver.sweep()
        summary.harnessRollouts = {
          skippedFailClosed: Boolean(harnessRollouts.skippedFailClosed),
          ...(harnessRollouts.reason ? { reason: harnessRollouts.reason } : {}),
          removed: harnessRollouts.removed,
          removedBytes: harnessRollouts.removedBytes,
          retained: harnessRollouts.retained,
          retainedBytes: harnessRollouts.retainedBytes,
        }
        for (const err of harnessRollouts.errors || []) {
          errors.push(`harness-rollout ${err}`)
        }
      }
    }

    if (errors.length) throw new Error(errors.join('\n'))
    return summary
  } finally {
    resourceCleanupInFlight = false
  }
}

export const DISABLED_CHECKS = new Set(
  String(DISABLED_CHECKS_RAW || '').split(',').map(name => name.trim()).filter(Boolean),
)

export function defaultChecks() {
  return allChecks().filter(([name]) => !DISABLED_CHECKS.has(name))
}

export function allChecks() {
  return [
    ['doc-load', checkDocumentLoads],
    ['doc-render', checkDocumentRenders],
    ['chat-roundtrip', checkMessageRoundTrip],
    ['mcp-surface', checkMcpSurface],
    ['spawn-wake-seat', checkSpawnWakeSeat],
    ['notification-consumption', checkNotificationConsumption],
    ['linked-remote-safety', checkLinkedRemoteSafety],
    ['agent-receiving', checkAgentReceiving],
    ['misconfigured-agents', checkMisconfiguredAgents],
    ['file-materialization', checkFileMaterialization],
    ['server-imports', checkServerImportResolution],
    ['bot-heartbeats', checkBotHeartbeats],
    ['resource-cleanup', checkResourceCleanup],
    ['box-memory', checkBoxMemory],
    ['box-disk', checkBoxDisk],
  ]
}

export async function runChecks({ checks = defaultChecks() } = {}) {
  const results = []
  for (const [name, check] of checks) {
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
        failureKind: e?.failureKind || null,
        family: e?.family || null,
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
    failureKind: [...new Set(failures.map(r => r.failureKind).filter(Boolean))].sort().join('+') || null,
    results,
    missing,
    blocked,
    summary: compactFailure(results),
  }
}

function isNudgeTarget(agent) {
  if (!agent || agent.dead || agent.human || agent.id === OWNER_ID || agent.id === AGENT_ID) return false
  const labels = labelsForAgent(agent)
  if (labels.includes('bot') || labels.includes('human')) return false
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
export async function nudgeTargets({
  nudgeToOverride = NUDGE_TO_OVERRIDE,
  nudgeLabel = NUDGE_LABEL,
  fleetServer = FLEET_SERVER,
  requestJson = fetchJson,
} = {}) {
  if (nudgeToOverride) {
    if (nudgeToOverride === OWNER_ID || nudgeToOverride === AGENT_ID) {
      return { targets: [], fellBack: null }
    }
    return { targets: [nudgeToOverride], fellBack: null }
  }
  if (!nudgeLabel) return { targets: [], fellBack: null }
  const holders = async filter => {
    const data = await requestJson(fleetServer, `/api/fleet-table?filter=${encodeURIComponent(filter)}&limit=500`)
    const agents = Array.isArray(data?.agents) ? data.agents : []
    return agents.filter(isNudgeTarget).map(agent => agent.id)
  }
  const awake = await holders(`awake & ${nudgeLabel} & !human & !bot`)
  if (awake.length) return { targets: awake, fellBack: null }
  const asleep = await holders(`${nudgeLabel} & !human & !bot`)
  if (!asleep.length) return { targets: [], fellBack: null }
  return { targets: asleep, fellBack: `no awake holder of \`${nudgeLabel}\`; queued to ${asleep.length} hibernating holder(s)` }
}

function tmuxPaste(sessionId, message) {
  execFileSync('tmux', ['set-buffer', message], { stdio: 'ignore' })
  execFileSync('tmux', ['paste-buffer', '-t', sessionId], { stdio: 'ignore' })
  execFileSync('tmux', ['send-keys', '-t', sessionId, 'Enter'], { stdio: 'ignore' })
}

export async function sendNotificationConsumptionTmuxAlarm(report, {
  fleetServer = FLEET_SERVER,
  nudgeLabel = NUDGE_LABEL,
  requestJson = fetchJson,
  readSeat = readAgentSeat,
  paste = tmuxPaste,
} = {}) {
  if (!String(report?.failureKind || '').split('+').includes('notification-consumption')) {
    return { skipped: true, reason: 'not notification-consumption' }
  }
  if (!nudgeLabel) {
    return { ok: false, failureKind: 'alarm-no-recipient', reason: 'no on-call label configured' }
  }
  const data = await requestJson(fleetServer, `/api/fleet-table?filter=${encodeURIComponent(`awake & ${nudgeLabel} & !human & !bot`)}&limit=500`)
  const agents = (Array.isArray(data?.agents) ? data.agents : []).filter(isNudgeTarget)
  if (!agents.length) {
    return { ok: false, failureKind: 'alarm-no-recipient', reason: `no awake holder of ${nudgeLabel}` }
  }
  const message = [
    `dev bot: notification consumption check failed`,
    '',
    report.summary || 'notification-consumption failure',
    '',
    `Alarm path: direct tmux paste from ${BOT_KEY}; not fleet chat/MCP/wake.`,
  ].join('\n')
  const delivered = []
  const failures = []
  for (const agent of agents) {
    try {
      const seat = await readSeat(agent.id)
      const sessionId = seat?.session_id || agent.tmux_session || metadataOf(agent).tmux_session || null
      if (!sessionId) {
        failures.push(`${agent.id}: no tmux session in current seat`)
        continue
      }
      paste(sessionId, message)
      delivered.push({ agent: agent.id, sessionId })
    } catch (e) {
      failures.push(`${agent.id}: ${e?.message || String(e)}`)
    }
  }
  if (!delivered.length) {
    return { ok: false, failureKind: 'alarm-no-recipient', reason: failures.join('; ') || `no tmux pane reached for ${nudgeLabel}` }
  }
  return { ok: true, delivered, ...(failures.length ? { failures } : {}) }
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

function normalizeFailureReason(text) {
  return String(text || '')
    .replace(/\b(devbot-(?:render|materialize)-)[a-f0-9]+/gi, '$1#')
    .replace(/\b(fleet:(?:dev|mcp)-probe-)[a-f0-9]+/gi, '$1#')
    .replace(/`[^`]+`/g, '`#`')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

function failureSubjectKey(line) {
  const text = String(line || '')
  const fleetId = text.match(/`(fleet:[^`]+)`/)
  if (fleetId) return fleetId[1]
  const bold = text.match(/\*\*([^*]+)\*\*/)
  if (bold) return normalizeFailureReason(bold[1])
  return normalizeFailureReason(text)
}

function splitFailureSubjectBlocks(error) {
  const blocks = []
  let current = null
  for (const line of String(error || '').split('\n').map(line => line.trim()).filter(Boolean)) {
    if (!current || (line.startsWith('**') && !line.startsWith('**no '))) {
      current = [line]
      blocks.push(current)
    } else {
      current.push(line)
    }
  }
  return blocks.length ? blocks.map(lines => lines.join('\n')) : ['']
}

function keyForFailureSubject(name, error) {
  const lines = String(error || '').split('\n').map(line => line.trim()).filter(Boolean)
  // These notices carry volatile measurements alongside their alert state.
  // Read only the state into the key, for both live reports and heartbeat
  // restoration; retain the complete measurement text in the notice body.
  if (name === 'box-disk') {
    const disk = lines[0]?.match(/^(WARN|CRITICAL) disk headroom on (.+?):/)
    if (disk) return `${name}:${disk[2]}:${disk[1]}`
  }
  if (name === 'box-memory' && lines[0]?.startsWith('**box-memory:')) {
    const pressure = lines.find(line => line.startsWith('- sample '))?.match(/; pressure (\d+) /)?.[1]
    if (pressure !== undefined) {
      const legs = ['pressure', 'swapout-rate', 'climber'].filter(leg => lines[0].includes(leg))
      return `${name}:pressure=${pressure}:legs=${legs.join(',')}`
    }
  }
  const subject = failureSubjectKey(lines[0] || '')
  const reasons = lines
    .filter(line => line.startsWith('- '))
    .map(line => normalizeFailureReason(line.slice(2)))
  const stableReasons = reasons.length ? [...new Set(reasons)].sort() : [normalizeFailureReason(lines[0] || '')]
  return `${name}:${subject}:${stableReasons.join('|')}`
}

function failureSectionsForCheck(name, error) {
  return splitFailureSubjectBlocks(error).map(block => ({
    key: keyForFailureSubject(name, block),
    text: `${name}: ${block}`,
  }))
}

function failureSectionsFromSummary(summary) {
  const sections = []
  let current = null
  for (const line of String(summary || '').split('\n')) {
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/)
    if (match) {
      if (current) sections.push(...failureSectionsForCheck(current.name, current.lines.join('\n')))
      current = { name: match[1], lines: [match[2]] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(...failureSectionsForCheck(current.name, current.lines.join('\n')))
  return sections
}

export function failureKey(reportOrSummary) {
  if (reportOrSummary && typeof reportOrSummary === 'object' && Array.isArray(reportOrSummary.results)) {
    const parts = reportOrSummary.results
      .filter(result => !result.ok)
      .flatMap(result => failureSectionsForCheck(result.name, result.error).map(section => section.key))
    return parts.sort().join('\n')
  }
  return failureSectionsFromSummary(reportOrSummary).map(section => section.key).sort().join('\n')
}

function firstFailureLine(summary) {
  return String(summary || '').split('\n').map(line => line.trim()).find(Boolean) || 'same failure signature'
}

function failureCoverage(report) {
  const results = report.results || []
  const passed = results.filter(r => r.ok && !r.skipped && !r.blocked).map(r => r.name)
  const failed = results.filter(r => !r.ok && !r.skipped && !r.blocked).map(r => r.name)
  const skipped = results.filter(r => r.skipped && !r.blocked)
    .map(r => `${r.name}:${r.detail?.reason || 'skipped'}`)
  const blocked = [...new Set([
    ...results.filter(r => r.blocked).map(r => `${r.name}:${r.detail?.reason || 'blocked'}`),
    ...(report.blocked || []),
  ])]
  const missing = report.missing || []
  return [
    'Coverage in this sweep:',
    results.length ? `- Passed: ${passed.join('; ') || 'none'}` : '- No check results were recorded.',
    ...(failed.length ? [`- Attempted and failed: ${failed.join('; ')}`] : []),
    ...(skipped.length ? [`- Skipped: ${skipped.join('; ')}`] : []),
    ...(blocked.length ? [`- Blocked or incomplete: ${blocked.join('; ')}`] : []),
    ...(missing.length ? [`- Not run: ${missing.join('; ')}`] : []),
  ].join('\n')
}

export function composeFailureNudgeMessage({ report, unchanged, standingFor, firstAt, fellBack }) {
  const message = [
    unchanged
      ? `**dev noticer: still failing, unchanged for ${standingFor} minutes** (first raised ${new Date(firstAt).toISOString()})`
      : report.setupOnly ? '**dev noticer: probe setup needs repair**' : '**dev noticer: testing is failing**',
    '',
    ...(unchanged
      ? [
          `Still failing: ${firstFailureLine(report.summary)}`,
          '',
          '_Full failure details were sent when this condition first raised. Nothing here has changed since then; the next repeat is further out, and a changed finding interrupts immediately._',
          '',
        ]
      : [report.summary, '']),
    ...(fellBack ? [`_Delivery degraded: ${fellBack}._`, ''] : []),
    `Environment: \`${CONFIG_NAME}\``,
    `Fleet: \`${FLEET_SERVER}\``,
    `Store: \`${STORE_SERVER}\``,
    '',
    failureCoverage(report),
  ].join('\n')
  return message
}

export function failureNudgeMessageReport({ report, activeKey }) {
  if (!activeKey) return report
  const activeKeys = new Set(String(activeKey).split('\n').filter(Boolean))
  const sections = failureSectionsFromSummary(report.summary)
  const standingSections = sections.filter(section => activeKeys.has(section.key))
  const newSections = sections.filter(section => !activeKeys.has(section.key))
  if (!newSections.length) return report
  const summary = [
    ...standingSections.map(section => `Still failing: ${section.text.split('\n')[0]}`),
    ...newSections.map(section => section.text),
  ].join('\n')
  return { ...report, summary }
}

async function sendFailureNudge(report) {
  if (report.setupOnly && !NUDGE_ON_SETUP) {
    writeHeartbeat('probe-setup-suppressed', { summary: report.summary })
    return
  }
  // The key must be STABLE while the finding is unchanged, and the rendered
  // summary is not: `agent-receiving` says "has produced nothing for N minutes"
  // and `misconfigured-agents` enumerates every affected agent, so membership
  // churn and elapsed-time prose must not make a known failing check look new.
  //
  // A genuinely new finding still changes the key: a different check, or the
  // same check failing for a different normalized reason, interrupts immediately.
  const key = failureKey(report)
  const sections = failureSectionsFromSummary(report.summary)
  const activeKeys = new Set(activeFailure?.key ? activeFailure.key.split('\n').filter(Boolean) : [])
  const newSections = activeFailure ? sections.filter(section => !activeKeys.has(section.key)) : sections
  const now = Date.now()
  const unchanged = Boolean(activeFailure && (activeFailure.key === key || newSections.length === 0))
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
  const messageReport = unchanged
    ? report
    : failureNudgeMessageReport({ report, activeKey: activeFailure?.key || '' })
  const message = composeFailureNudgeMessage({
    report: messageReport,
    unchanged,
    standingFor,
    firstAt: unchanged ? activeFailure.firstAt : now,
    fellBack,
  })
  for (const target of targets) {
    await sendChat(target, message)
  }
  activeFailure = unchanged
    ? { ...activeFailure, key, lastNudgeAt: now, repeats: activeFailure.repeats + 1, summary: report.summary }
    : { key, firstAt: activeFailure?.firstAt || now, lastNudgeAt: now, repeats: 0, summary: report.summary }
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
        const standingForMin = Math.round((Date.now() - cleared.firstAt) / 60_000)
        // "The condition no longer holds" is not "the subject is fine". An agent
        // that leaves `filter=awake` stops being watched, and reading that as
        // recovery is worse than never firing: a `cleared` line actively tells
        // the reader to stop looking. On 2026-08-08 this bot announced
        // `really-able-to-do-stuff` cleared after 16 minutes when nothing about
        // it had changed except its roster row flipping to `hibernating` -- the
        // wake still failed on an unknown permission profile.
        //
        // So the subjects named in the standing failure are checked against the
        // population actually watched this sweep. Any that are missing left the
        // filter, and that clears as "no longer observable" with their names.
        const watchedNow = new Set(report.results.flatMap(r => r.detail?.watchedIds || []))
        const subjects = [...new Set(cleared.summary.match(/fleet:[0-9a-z-]+/g) || [])]
        const unobserved = subjects.filter(id => !watchedNow.has(id))
        const observable = subjects.length > 0 && unobserved.length === 0
        writeHeartbeat('recovered', {
          summary: cleared.summary,
          standingForMin,
          ...(unobserved.length ? { unobserved } : {}),
        })
        const { targets } = await nudgeTargets()
        const headline = unobserved.length
          ? [
            `**dev noticer: no longer observable** after ${standingForMin} minutes — this is NOT a recovery.`,
            '',
            `${unobserved.join(', ')} left the watched population, so this check can no longer see ${unobserved.length > 1 ? 'them' : 'it'}. Nothing here says ${unobserved.length > 1 ? 'they are' : 'it is'} fixed.`,
          ].join('\n')
          : `**dev noticer: cleared** after ${standingForMin} minutes.${observable ? '' : ''}`
        for (const target of targets) {
          await sendChat(target, `${headline}\n\n${cleared.summary.split('\n')[0]}`)
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
        lastCheckOutcome = 'degraded'
        lastFailureKind = null
        writeHeartbeat('degraded', { ...detail, missing: report.missing, blocked: report.blocked })
      } else {
        lastCheckOutcome = 'healthy'
        lastFailureKind = null
        lastSuccessfulCheckAt = new Date().toISOString()
        writeHeartbeat('healthy', detail)
      }
      return
    }
    lastFailureKind = report.failureKind || null
    lastCheckOutcome = report.failureKind || (report.setupOnly ? 'setup-failed' : 'failed')
    if (report.setupOnly) {
      writeHeartbeat('probe-setup-failed', { summary: report.summary })
    }
    const tmuxAlarm = await sendNotificationConsumptionTmuxAlarm(report).catch(e => ({
      ok: false,
      failureKind: 'alarm-no-recipient',
      reason: e?.message || String(e),
    }))
    if (tmuxAlarm && !tmuxAlarm.skipped) {
      if (tmuxAlarm.ok) {
        writeHeartbeat('notification-consumption-tmux-alarm', tmuxAlarm)
      } else {
        lastFailureKind = [report.failureKind, tmuxAlarm.failureKind].filter(Boolean).join('+') || tmuxAlarm.failureKind || null
        lastCheckOutcome = lastFailureKind || lastCheckOutcome
        writeHeartbeat('notification-consumption-tmux-alarm-failed', tmuxAlarm)
      }
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
  try {
    await checkResourceCleanup()
  } catch (e) {
    console.error(`[dev-bot] resource cleanup failed: ${e.message}`)
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${value.toFixed(1)}%`
}

function cpuTotals(cpus = os.cpus()) {
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

function cpuBusyPercent(previous, current) {
  if (!previous || !current) return null
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (total <= 0) return null
  return Math.max(0, Math.min(100, (1 - idle / total) * 100))
}

async function measureEventLoopLagMs({ delayMs = 100, clock = () => performance.now(), timer = setTimeout } = {}) {
  const started = clock()
  return new Promise(resolve => {
    timer(() => resolve(Math.max(0, clock() - started - delayMs)), delayMs)
  })
}

function readTmuxSessionCounts({ run = execFileSync } = {}) {
  try {
    const output = run('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const sessions = output.split('\n').map(line => line.trim()).filter(Boolean)
    return {
      total: sessions.length,
      fleet: sessions.filter(name => name.startsWith('fleet-')).length,
      playwright: sessions.filter(name => name === 'shared' || name.startsWith('shared-')).length,
    }
  } catch (e) {
    return { total: null, fleet: null, playwright: null, error: e?.message || String(e) }
  }
}

async function readFleetLoadContext({ rows = fleetTableRows } = {}) {
  try {
    const awake = await rows('awake')
    return {
      awakeAgents: awake.length,
      botAgents: awake.filter(row => Array.isArray(row.labels) && row.labels.includes('bot')).length,
      humanAgents: awake.filter(row => row.human).length,
    }
  } catch (e) {
    return { awakeAgents: null, botAgents: null, humanAgents: null, error: e?.message || String(e) }
  }
}

function loadState(latest, cores) {
  if (!latest) return 'No completed load sample is available yet.'
  const perCoreLoad = cores ? latest.load1 / cores : latest.load1
  const busy = Number.isFinite(latest.cpuBusyPercent) ? latest.cpuBusyPercent : 0
  const lag = Number.isFinite(latest.eventLoopLagMs) ? latest.eventLoopLagMs : 0
  if (perCoreLoad < 0.7 && busy < 70 && latest.memoryUsedPercent < 85) {
    return 'The Mini is running comfortably in this window.'
  }
  if (perCoreLoad < 1.2 && busy < 85 && lag < 50) {
    return 'The Mini is carrying load but staying responsive in this window.'
  }
  return 'The Mini is busy enough to show up in this window.'
}

async function collectMiniLoadSample({
  cpuWindowMs = 1000,
  loadavg = () => os.loadavg(),
  totalmem = () => os.totalmem(),
  freemem = () => os.freemem(),
  cpus = () => os.cpus(),
  now = () => new Date(),
  lag = () => measureEventLoopLagMs(),
  wait = sleep,
} = {}) {
  const previousCpu = cpuTotals(cpus())
  await wait(cpuWindowMs)
  const currentCpu = cpuTotals(cpus())
  const totalBytes = totalmem()
  const freeBytes = freemem()
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  const [load1, load5, load15] = loadavg()
  return {
    ts: now().toISOString(),
    load1,
    load5,
    load15,
    cpuBusyPercent: cpuBusyPercent(previousCpu, currentCpu),
    memoryUsedBytes: usedBytes,
    memoryTotalBytes: totalBytes,
    memoryUsedPercent: totalBytes > 0 ? usedBytes / totalBytes * 100 : 0,
    eventLoopLagMs: await lag(),
  }
}

export async function collectMiniLoadSamples({
  count = 1,
  intervalMs = 0,
  hostname = () => os.hostname(),
  now = () => new Date(),
  cores = () => os.cpus().length || 1,
  context = () => Promise.all([readFleetLoadContext(), Promise.resolve(readTmuxSessionCounts())]),
  sample = collectMiniLoadSample,
  wait = sleep,
} = {}) {
  const startedAt = now().toISOString()
  const machine = hostname()
  const coreCount = cores()
  const [fleet, tmux] = await context()
  const samples = []
  for (let index = 0; index < count; index++) {
    if (index > 0) await wait(intervalMs)
    samples.push(await sample())
  }
  return { startedAt, generatedAt: now().toISOString(), machine, cores: coreCount, fleet, tmux, samples }
}

const MINI_LOAD_CSV_COLUMNS = [
  'ts',
  'machine',
  'cores',
  'load1',
  'load5',
  'load15',
  'cpuBusyPercent',
  'memoryUsedBytes',
  'memoryTotalBytes',
  'memoryUsedPercent',
  'eventLoopLagMs',
  'awakeAgents',
  'botAgents',
  'humanAgents',
  'tmuxTotal',
  'tmuxFleet',
  'tmuxPlaywright',
]

function finiteOrBlank(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : ''
}

function csvCell(value) {
  if (value === null || value === undefined || value === '') return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function splitCsvLine(line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"'
        index++
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell)
  return cells
}

export function parseMiniLoadCsv(csv = '') {
  const lines = String(csv || '').split(/\r?\n/).filter(line => line.length)
  if (!lines.length) return []
  const headers = splitCsvLine(lines[0])
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line)
    const row = {}
    headers.forEach((header, index) => { row[header] = cells[index] ?? '' })
    return row
  }).filter(row => row.ts)
}

function miniLoadRowFromSample(report, sample) {
  return {
    ts: sample.ts,
    machine: report.machine,
    cores: report.cores,
    load1: finiteOrBlank(sample.load1),
    load5: finiteOrBlank(sample.load5),
    load15: finiteOrBlank(sample.load15),
    cpuBusyPercent: finiteOrBlank(sample.cpuBusyPercent),
    memoryUsedBytes: finiteOrBlank(sample.memoryUsedBytes),
    memoryTotalBytes: finiteOrBlank(sample.memoryTotalBytes),
    memoryUsedPercent: finiteOrBlank(sample.memoryUsedPercent),
    eventLoopLagMs: finiteOrBlank(sample.eventLoopLagMs),
    awakeAgents: finiteOrBlank(report.fleet?.awakeAgents),
    botAgents: finiteOrBlank(report.fleet?.botAgents),
    humanAgents: finiteOrBlank(report.fleet?.humanAgents),
    tmuxTotal: finiteOrBlank(report.tmux?.total),
    tmuxFleet: finiteOrBlank(report.tmux?.fleet),
    tmuxPlaywright: finiteOrBlank(report.tmux?.playwright),
  }
}

export function renderMiniLoadCsv(rows = []) {
  const body = rows.map(row => MINI_LOAD_CSV_COLUMNS.map(column => csvCell(row[column])).join(','))
  return `${MINI_LOAD_CSV_COLUMNS.join(',')}\n${body.join('\n')}${body.length ? '\n' : ''}`
}

export function renderMiniLoadQmd({
  dataFile = LOAD_REPORT_DATA_FILE,
  retainedSamples = LOAD_REPORT_RETAINED_SAMPLES,
} = {}) {
  return [
    '---',
    'title: Mini load report',
    'format:',
    '  html:',
    '    embed-resources: false',
    'execute:',
    '  echo: false',
    '---',
    '',
    `The dev bot appends one real row to \`${dataFile}\` every ${Math.round(LOAD_REPORT_INTERVAL_MS / 1000)} seconds and keeps the newest ${retainedSamples} rows.`,
    '',
    'Provenance: local `os.loadavg()`, `os.cpus()`, `os.totalmem()`, `os.freemem()`, one event-loop lag timer, `tmux list-sessions`, and the fleet `awake` roster.',
    '',
    '```{ojs}',
    `rows = FileAttachment("${dataFile}").csv({typed: true})`,
    '',
    'latest = rows[rows.length - 1]',
    'cores = latest?.cores || 1',
    'fmtPct = (value) => Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a"',
    'fmtBytes = (bytes) => {',
    '  if (!Number.isFinite(bytes)) return "n/a"',
    '  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`',
    '  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`',
    '  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`',
    '}',
    'summaryText = {',
    '  if (!latest) return "No completed load sample is available yet."',
    '  const perCoreLoad = latest.load1 / cores',
    '  const busy = Number.isFinite(latest.cpuBusyPercent) ? latest.cpuBusyPercent : 0',
    '  const lag = Number.isFinite(latest.eventLoopLagMs) ? latest.eventLoopLagMs : 0',
    '  if (perCoreLoad < 0.7 && busy < 70 && latest.memoryUsedPercent < 85) return "The Mini is running comfortably in this window."',
    '  if (perCoreLoad < 1.2 && busy < 85 && lag < 50) return "The Mini is carrying load but staying responsive in this window."',
    '  return "The Mini is busy enough to show up in this window."',
    '}',
    '',
    'summary = html`<section class="mini-load-summary">',
    '  <p><strong>${summaryText}</strong></p>',
    '  <table>',
    '    <tbody>',
    '      <tr><th>Latest row</th><td>${latest?.ts || "n/a"}</td></tr>',
    '      <tr><th>Machine</th><td>${latest?.machine || "unknown"} (${cores} CPU cores)</td></tr>',
    '      <tr><th>1 min load</th><td>${latest ? latest.load1.toFixed(2) : "n/a"}</td></tr>',
    '      <tr><th>CPU busy</th><td>${latest ? fmtPct(latest.cpuBusyPercent) : "n/a"}</td></tr>',
    '      <tr><th>Memory used</th><td>${latest ? `${fmtBytes(latest.memoryUsedBytes)} / ${fmtBytes(latest.memoryTotalBytes)} (${fmtPct(latest.memoryUsedPercent)})` : "n/a"}</td></tr>',
    '      <tr><th>Event-loop lag</th><td>${latest ? `${latest.eventLoopLagMs.toFixed(1)} ms` : "n/a"}</td></tr>',
    '      <tr><th>Awake fleet agents</th><td>${latest?.awakeAgents ?? "n/a"}</td></tr>',
    '      <tr><th>Tmux sessions</th><td>${latest ? `${latest.tmuxTotal} total, ${latest.tmuxFleet} fleet, ${latest.tmuxPlaywright} Playwright pool` : "n/a"}</td></tr>',
    `      <tr><th>CSV bound</th><td>Newest ${retainedSamples} rows</td></tr>`,
    '    </tbody>',
    '  </table>',
    '</section>`',
    '',
    'timelineRows = rows.flatMap((row) => {',
    '  const ts = row.ts instanceof Date ? row.ts : new Date(row.ts)',
    '  const rowCores = row.cores || 1',
    '  return [',
    '    { ts, metric: "load/core", value: row.load1 / rowCores * 100 },',
    '    { ts, metric: "CPU", value: row.cpuBusyPercent },',
    '    { ts, metric: "memory", value: row.memoryUsedPercent },',
    '  ].filter((row) => Number.isFinite(row.value))',
    '})',
    '',
    'timeline = Plot.plot({',
    '  width: 760,',
    '  height: 280,',
    '  marginLeft: 48,',
    '  y: { grid: true, label: "percent" },',
    '  x: { label: null },',
    '  color: { legend: true },',
    '  marks: [',
    '    Plot.ruleY([100], { stroke: "#999", strokeDasharray: "4,4" }),',
    '    Plot.line(timelineRows, { x: "ts", y: "value", z: "metric", stroke: "metric" }),',
    '    Plot.dot(timelineRows, { x: "ts", y: "value", z: "metric", stroke: "metric", fill: "metric", title: d => `${d.metric}: ${d.value.toFixed(1)}%` })',
    '  ]',
    '})',
    '',
    'sampleTable = Inputs.table(rows.map((row) => ({',
    '  timestamp: row.ts,',
    '  load1: row.load1?.toFixed?.(2),',
    '  load5: row.load5?.toFixed?.(2),',
    '  load15: row.load15?.toFixed?.(2),',
    '  cpu: fmtPct(row.cpuBusyPercent),',
    '  memory: fmtPct(row.memoryUsedPercent),',
    '  eventLoopLagMs: row.eventLoopLagMs?.toFixed?.(1),',
    '  awakeAgents: row.awakeAgents,',
    '})))',
    '```',
    '',
    '## Current snapshot',
    '',
    '${summary}',
    '',
    '## Timeline',
    '',
    '${timeline}',
    '',
    '## Samples',
    '',
    '${sampleTable}',
  ].join('\n')
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
    '# Dev bot disk and worktree status',
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

function miniLoadReportHref() {
  const htmlFile = LOAD_REPORT_SOURCE_FILE.replace(/\.[^.]+$/i, '.html')
  return `/docs/${encodeURIComponent(LOAD_REPORT_PROJECT)}/${encodeURIComponent(htmlFile)}`
}

async function readMiniLoadCsv({ storeServer = STORE_SERVER, requestText = fetchText } = {}) {
  try {
    return await requestText(storeServer, `/api/projects/${encodeURIComponent(LOAD_REPORT_PROJECT)}/source/${encodeURIComponent(LOAD_REPORT_DATA_FILE)}`)
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return ''
    throw e
  }
}

async function ensureMiniLoadProject({ storeServer = STORE_SERVER, requestJson = fetchJsonMaybe } = {}) {
  const existing = await requestJson(storeServer, `/api/projects/${encodeURIComponent(LOAD_REPORT_PROJECT)}`, { okStatuses: [404] })
  if (existing.status === 404) {
    await requestJson(storeServer, '/api/projects', {
      method: 'POST',
      body: {
        name: LOAD_REPORT_PROJECT,
        title: 'Mini load report',
        mainFile: LOAD_REPORT_SOURCE_FILE,
        format: 'qmd',
      },
    })
    return
  }
  const project = existing.body || {}
  if (project.format && project.format !== 'qmd') {
    throw new Error(`project ${LOAD_REPORT_PROJECT} already exists with format ${project.format}, not qmd`)
  }
  if (project.mainFile && project.mainFile !== LOAD_REPORT_SOURCE_FILE) {
    throw new Error(`project ${LOAD_REPORT_PROJECT} already uses main file ${project.mainFile}, not ${LOAD_REPORT_SOURCE_FILE}`)
  }
}

async function pushMiniLoadProjectFiles(files, { storeServer = STORE_SERVER, requestJson = fetchJsonMaybe } = {}) {
  const authority = (await requestJson(storeServer, `/api/projects/${encodeURIComponent(LOAD_REPORT_PROJECT)}/source-authority`)).body
  const push = await requestJson(storeServer, `/api/projects/${encodeURIComponent(LOAD_REPORT_PROJECT)}/push`, {
    method: 'POST',
    body: {
      files,
      sourceManifest: [LOAD_REPORT_SOURCE_FILE, LOAD_REPORT_DATA_FILE],
      expectedRevision: authority?.currentRevision ?? null,
      editedBy: AGENT_ID,
    },
    okStatuses: [409],
  })
  if (push.status === 409) return { conflict: true, error: push.body?.error || 'source revision conflict' }
  if (!push.body?.ok) throw new Error(push.body?.error || 'Mini load source push was not accepted')
  return { ok: true, authority: push.body?.authority || null }
}

export async function publishMiniLoadReport({
  report = null,
  collect = collectMiniLoadSamples,
  storeServer = STORE_SERVER,
  requestJson = fetchJsonMaybe,
  requestText = fetchText,
  bootstrap = !miniLoadReportBootstrapped,
  retries = 2,
} = {}) {
  await ensureMiniLoadProject({ storeServer, requestJson })
  const current = report || await collect()
  const newRows = (current.samples || []).map(sample => miniLoadRowFromSample(current, sample))

  for (let attempt = 0; attempt <= retries; attempt++) {
    const existingRows = parseMiniLoadCsv(await readMiniLoadCsv({ storeServer, requestText }))
    const rows = [...existingRows, ...newRows].slice(-LOAD_REPORT_RETAINED_SAMPLES)
    const files = [
      ...(bootstrap || !miniLoadReportBootstrapped ? [{ path: LOAD_REPORT_SOURCE_FILE, content: renderMiniLoadQmd() }] : []),
      { path: LOAD_REPORT_DATA_FILE, content: renderMiniLoadCsv(rows) },
    ]
    const result = await pushMiniLoadProjectFiles(files, { storeServer, requestJson })
    if (!result.conflict) {
      miniLoadReportBootstrapped = true
      return `[Mini load report](${miniLoadReportHref()})`
    }
  }
  throw new Error(`Mini load source push conflicted after ${retries + 1} attempts`)
}

async function refreshMiniLoadReport() {
  if (miniLoadReportInFlight) return
  miniLoadReportInFlight = true
  try {
    await publishMiniLoadReport({ bootstrap: !miniLoadReportBootstrapped })
    writeHeartbeat('mini-load-report-published', {
      project: LOAD_REPORT_PROJECT,
      csvFile: LOAD_REPORT_DATA_FILE,
      retainedSamples: LOAD_REPORT_RETAINED_SAMPLES,
    })
  } catch (e) {
    writeHeartbeat('mini-load-report-failed', { error: e.message })
    console.error('[dev-bot] Mini load report publish failed:', e.message)
  } finally {
    miniLoadReportInFlight = false
  }
}

export const commands = [{
  name: 'status',
  summary: 'Return the current disk/worktree status report inline.',
  help: 'Replies with the current Markdown report, cleanup measurements, and timeline in chat.',
  examples: ['status'],
  handler: async ({ reply }) => {
    await reply(renderStatusMarkdown())
  },
}, {
  name: 'load',
  summary: 'Publish and return the current Mini load report.',
  help: 'Appends one real Mini load row to the mini-load CSV source file, refreshes the QMD report source when needed, and returns the rendered project link.',
  examples: ['load'],
  handler: async ({ reply }) => {
    await reply(await publishMiniLoadReport({ bootstrap: true }))
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
    if (miniLoadReportTimer) clearInterval(miniLoadReportTimer)
    sweepTimer = setInterval(() => sweep().catch(e => console.error('[dev-bot] sweep failed:', e.message)), INTERVAL_MS)
    if (LOAD_REPORT_ENABLED) {
      miniLoadReportTimer = setInterval(() => refreshMiniLoadReport(), LOAD_REPORT_INTERVAL_MS)
      miniLoadReportTimer.unref?.()
      refreshMiniLoadReport()
    }
    sweep().catch(e => console.error('[dev-bot] initial sweep failed:', e.message))
    cleanupResources().catch(e => console.error('[dev-bot] initial resource cleanup failed:', e.message))
  }).onMessage(msg => {
    if (msg?.event !== 'fleet-event') return
    const id = Number(msg.data?.id || msg.data?.event_id)
    if (Number.isFinite(id) && id > lastFleetEventId) lastFleetEventId = id
  }).start()

  activeFailure = restoreActiveFailure()
  boxDiskState.tripped = /^box-disk: (WARN|CRITICAL) disk headroom on /m.test(activeFailure?.summary || '')
  writeHeartbeat('startup', {
    intervalMs: INTERVAL_MS,
    ...(activeFailure ? { restoredFailure: activeFailure.summary.split('\n')[0], repeats: activeFailure.repeats } : {}),
  })
  resourceCleanupTimer = setInterval(() => cleanupResources().catch(e => console.error('[dev-bot] resource cleanup failed:', e.message)), RESOURCE_CLEANUP_INTERVAL_MS)
  resourceCleanupTimer.unref?.()
}
