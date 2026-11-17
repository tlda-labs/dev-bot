import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export const DEFAULT_DISK_WARN_FREE_BYTES = 50 * 1024 ** 3
export const DEFAULT_DISK_CRITICAL_FREE_BYTES = 30 * 1024 ** 3
export const DEFAULT_DISK_MOUNT_CANDIDATES = ['/System/Volumes/Data', '/']

export class BoxDiskSetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoxDiskSetupError'
    this.setupFailure = true
  }
}

export function formatGiB(bytes) {
  if (!Number.isFinite(bytes)) return '? GiB'
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function formatMiB(bytes) {
  if (!Number.isFinite(bytes)) return '? MiB'
  if (bytes >= 1024 ** 3) return formatGiB(bytes)
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

export function parseDfKilobyteTable(text, requestedMount = null) {
  const lines = String(text || '')
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    throw new BoxDiskSetupError(`df -k output had no data rows: ${JSON.stringify(String(text || '').slice(0, 160))}`)
  }
  const dataLine = lines[lines.length - 1]
  // POSIX/macOS `df -k -P` or `df -k <mount>`:
  // Filesystem 1024-blocks Used Available Capacity [iused ifree %iused] Mounted on
  const match = dataLine.match(/^(\S+(?:\s+\S+)*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%(?:\s+\d+\s+\d+\s+\d+%)?\s+(\/.*)$/)
  if (!match) {
    throw new BoxDiskSetupError(`could not parse df -k row: ${JSON.stringify(dataLine)}`)
  }
  const totalBlocksKb = Number(match[2])
  const usedBlocksKb = Number(match[3])
  const availableBlocksKb = Number(match[4])
  const capacityPct = Number(match[5])
  const mountPoint = match[6].trim() || requestedMount || '/'
  if (!Number.isFinite(totalBlocksKb) || totalBlocksKb <= 0 || !Number.isFinite(availableBlocksKb) || availableBlocksKb < 0) {
    throw new BoxDiskSetupError(`invalid block counts in df -k row: ${JSON.stringify(dataLine)}`)
  }
  const totalBytes = totalBlocksKb * 1024
  const freeBytes = availableBlocksKb * 1024
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  const usedPct = Number(((usedBytes / totalBytes) * 100).toFixed(1))
  return {
    filesystem: match[1].trim(),
    mountPoint,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPct,
    dfCapacityPct: capacityPct,
  }
}

export async function collectDiskSample({
  run = execFileP,
  mountCandidates = DEFAULT_DISK_MOUNT_CANDIDATES,
  now = () => new Date().toISOString(),
} = {}) {
  let lastError = null
  for (const candidate of mountCandidates) {
    try {
      const { stdout } = await run('df', ['-k', candidate], {
        timeout: 10_000,
        encoding: 'utf8',
      })
      const parsed = parseDfKilobyteTable(stdout, candidate)
      return {
        at: now(),
        ...parsed,
      }
    } catch (error) {
      lastError = error
    }
  }
  throw new BoxDiskSetupError(`df -k failed for ${mountCandidates.join(', ')}: ${lastError?.message || String(lastError)}`)
}

export function evaluateDiskSample(sample, {
  warnFreeBytes = DEFAULT_DISK_WARN_FREE_BYTES,
  criticalFreeBytes = DEFAULT_DISK_CRITICAL_FREE_BYTES,
  wasTripped = false,
} = {}) {
  if (!sample || !Number.isFinite(sample.freeBytes) || !Number.isFinite(sample.totalBytes)) {
    throw new BoxDiskSetupError('disk sample is missing numeric freeBytes/totalBytes')
  }
  const isCritical = sample.freeBytes < criticalFreeBytes
  const clearFreeBytes = warnFreeBytes + 1024 ** 3
  const isWarn = !isCritical && sample.freeBytes < (wasTripped ? clearFreeBytes : warnFreeBytes)
  const level = isCritical ? 'critical' : isWarn ? 'warn' : 'ok'
  return {
    at: sample.at || null,
    mountPoint: sample.mountPoint || '/System/Volumes/Data',
    freeBytes: sample.freeBytes,
    totalBytes: sample.totalBytes,
    usedBytes: sample.usedBytes ?? Math.max(0, sample.totalBytes - sample.freeBytes),
    usedPct: sample.usedPct ?? Number((((sample.totalBytes - sample.freeBytes) / sample.totalBytes) * 100).toFixed(1)),
    warnFreeBytes,
    criticalFreeBytes,
    clearFreeBytes,
    level,
    tripped: level !== 'ok',
  }
}

export async function collectTopDiskConsumers({
  run = execFileP,
  paths = [
    path.join(os.homedir(), '.tlda'),
    path.join(os.homedir(), 'worktrees'),
    '/private/tmp',
    path.join(os.homedir(), '.config', 'tlda'),
  ],
} = {}) {
  const results = []
  for (const target of paths) {
    try {
      const { stdout } = await run('du', ['-sk', target], {
        timeout: 20_000,
        encoding: 'utf8',
      })
      const match = String(stdout || '').trim().match(/^(\d+)\s+(.+)$/m)
      if (match) {
        results.push({
          path: target,
          bytes: Number(match[1]) * 1024,
        })
      }
    } catch (error) {
      // du exits 1 on partial permission-denied subdirectories (e.g. /private/tmp)
      // while still printing the final total line on stdout.
      const stdout = String(error?.stdout || '').trim()
      const lines = stdout.split('\n').filter(Boolean)
      const last = lines[lines.length - 1] || ''
      const match = last.match(/^(\d+)\s+(.+)$/)
      if (match) {
        results.push({
          path: target,
          bytes: Number(match[1]) * 1024,
        })
      }
    }
  }
  return results.sort((a, b) => b.bytes - a.bytes)
}

export function formatDiskNotice(verdict, {
  afterSample = null,
  cleanupSummary = null,
  topConsumers = [],
} = {}) {
  const effectiveFreeBytes = Number.isFinite(afterSample?.freeBytes) ? afterSample.freeBytes : verdict.freeBytes
  const effectiveUsedPct = Number.isFinite(afterSample?.usedPct) ? afterSample.usedPct : verdict.usedPct
  const thresholdBytes = verdict.level === 'critical' ? verdict.criticalFreeBytes : verdict.warnFreeBytes
  const parts = [
    `${verdict.level.toUpperCase()} disk headroom on ${verdict.mountPoint}: ${formatGiB(effectiveFreeBytes)} free of ${formatGiB(verdict.totalBytes)} (${effectiveUsedPct}% used; ${verdict.level} floor is ${formatGiB(thresholdBytes)} free; clears at ${formatGiB(verdict.clearFreeBytes)})`,
  ]
  if (Number.isFinite(afterSample?.freeBytes) && afterSample.freeBytes !== verdict.freeBytes) {
    parts.push(`before cleanup: ${formatGiB(verdict.freeBytes)} free`)
  }
  if (cleanupSummary) {
    parts.push(`on-demand cleanup: ${cleanupSummary}`)
  }
  if (Array.isArray(topConsumers) && topConsumers.length > 0) {
    const consumerText = topConsumers
      .slice(0, 4)
      .map(entry => `${entry.path}=${formatMiB(entry.bytes)}`)
      .join(', ')
    parts.push(`top consumers: ${consumerText}`)
  }
  return parts.join(' — ')
}
