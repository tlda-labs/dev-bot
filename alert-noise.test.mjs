import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoxMemoryWatch } from './box-memory.mjs'

process.env.TLDA_DEV_BOT_NO_START = '1'
const { checkBoxDisk, checkBoxMemory, runChecks, failureKey, failureNudgeMessageReport, composeFailureNudgeMessage } = await import('./dev-bot.mjs')
const GiB = 1024 ** 3
const diskSample = free => ({ freeBytes: free * GiB, totalBytes: 460 * GiB, mountPoint: '/data' })
const diskReport = (state, free, cleanup = {}) => runChecks({ checks: [['box-disk', () => checkBoxDisk({
  loadPerCore: () => 0.2,
  state, sampleDisk: async () => diskSample(free), runCleanup: async () => cleanup,
  sampleTopConsumers: async () => [{ path: '/cache', bytes: free * GiB }],
})]] })

test('disk alert survives floor flapping and clears only at 51 GiB', async () => {
  const state = { tripped: false }
  const reports = []
  for (const free of [50.5, 49.7, 50, 49.8, 50.9, 51, 50.5, 49.9]) reports.push(await diskReport(state, free))
  assert.deepEqual(reports.map(r => r.ok), [true, false, false, false, false, true, true, false])
  const openKeys = reports.slice(1, 5).map(failureKey)
  assert.equal(new Set(openKeys).size, 1, 'one standing finding through the flapping sequence')
  assert.match(reports[4].summary, /50.9 GiB/)
  assert.match(reports[4].summary, /clears at 51.0 GiB/)
})

test('disk cleanup and consumer detail cannot change the signature; severity still can', async () => {
  const state = { tripped: false }
  const first = await diskReport(state, 49.7, { skipped: true, reason: 'previous cleanup still in flight' })
  const later = await runChecks({ checks: [['box-disk', () => checkBoxDisk({
    loadPerCore: () => 0.2,
    state,
    sampleDisk: (() => { let n = 0; return async () => diskSample(n++ ? 50.2 : 49.8) })(),
    runCleanup: async () => ({ worktrees: { evicted: 1, totalBytes: GiB, retainedBytes: 0 } }),
    sampleTopConsumers: async () => [{ path: '/different-cache', bytes: 80 * GiB }],
  })]] })
  assert.notEqual(first.summary, later.summary)
  assert.equal(failureKey(first), failureKey(later))
  assert.equal(failureKey(later), failureKey(later.summary), 'heartbeat restoration uses the same key')
  assert.match(later.summary, /before cleanup: 49.8 GiB/)
  assert.match(later.summary, /worktrees evicted=1/)
  assert.match(later.summary, /different-cache=80.0 GiB/)
  const critical = await diskReport(state, 29)
  assert.notEqual(failureKey(first), failureKey(critical))
  assert.equal(failureNudgeMessageReport({ report: later, activeKey: failureKey(first) }).summary, later.summary)
  const message = composeFailureNudgeMessage({ report: later, unchanged: false, firstAt: 0 })
  assert.match(message, /before cleanup: 49.8 GiB/)
})

test('an unavailable disk measurement cannot clear a latched warning', async () => {
  const state = { tripped: false }
  await diskReport(state, 49)
  await assert.rejects(checkBoxDisk({ state, sampleDisk: async () => { throw new Error('df unavailable') } }), /df unavailable/)
  assert.equal((await diskReport(state, 50.5)).ok, false)
  assert.equal((await diskReport(state, 51)).ok, true)
})

function memorySample(minute, pressure, { swapouts = 1000, rss = 100, pid = 20, command = '/bin/process' } = {}) {
  return { ts: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), pressure, swapouts,
    pageSizeBytes: 16384, rows: [{ pid, ppid: 1, rssKb: rss * 1024, command }] }
}
const memoryReport = (watch, sample) => runChecks({ checks: [['box-memory', () => checkBoxMemory({ watch, sample, reapClimbers: false })]] })

test('memory process churn stays one finding while a pressure-level change interrupts', async () => {
  const watch = createBoxMemoryWatch()
  assert.equal((await memoryReport(watch, memorySample(0, 1))).ok, true)
  const first = await memoryReport(watch, memorySample(1, 2))
  const later = await memoryReport(watch, memorySample(2, 2, { rss: 150 }))
  const shuffled = await memoryReport(watch, memorySample(3, 2, { rss: 99, pid: 30, command: '/bin/another' }))
  assert.equal(failureKey(first), failureKey(later))
  assert.equal(failureKey(first), failureKey(shuffled))
  assert.equal(failureKey(shuffled), failureKey(shuffled.summary))
  assert.match(later.summary, /150MB pid 20/)
  assert.match(shuffled.summary, /99MB pid 30/)
  assert.match(shuffled.summary, /\/bin\/another/)
  const worse = await memoryReport(watch, memorySample(4, 4))
  assert.notEqual(failureKey(first), failureKey(worse), 'numeric normalization must not erase pressure severity')
  assert.equal((await memoryReport(watch, memorySample(5, 1))).ok, true)
})

test('memory swap and climber legs remain distinct state changes', async () => {
  const watch = createBoxMemoryWatch({ swapoutWindowMs: 60_000 })
  await memoryReport(watch, memorySample(0, 1))
  const pressure = await memoryReport(watch, memorySample(1, 2))
  const swapping = await memoryReport(watch, memorySample(2, 2, { swapouts: 13000 }))
  assert.notEqual(failureKey(pressure), failureKey(swapping))
  const stillSwapping = await memoryReport(watch, memorySample(3, 2, { swapouts: 31000 }))
  assert.equal(failureKey(swapping), failureKey(stillSwapping))
  const settledSwap = await memoryReport(watch, memorySample(4, 2, { swapouts: 31000 }))
  assert.equal(failureKey(pressure), failureKey(settledSwap))
  const command = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Chrome --type=renderer'
  await memoryReport(watch, memorySample(5, 2, { swapouts: 31000, rss: 100, command }))
  await memoryReport(watch, memorySample(6, 2, { swapouts: 31000, rss: 2000, command }))
  const climbing = await memoryReport(watch, memorySample(7, 2, { swapouts: 31000, rss: 4000, command }))
  assert.notEqual(failureKey(pressure), failureKey(climbing))
  const stillClimbing = await memoryReport(watch, memorySample(8, 2, { swapouts: 31000, rss: 6000, command }))
  assert.equal(failureKey(climbing), failureKey(stillClimbing))
})
