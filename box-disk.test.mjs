import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectDiskSample,
  DEFAULT_DISK_CRITICAL_FREE_BYTES,
  DEFAULT_DISK_WARN_FREE_BYTES,
  evaluateDiskSample,
  formatDiskNotice,
  parseDfKilobyteTable,
} from './box-disk.mjs'
import {
  createClaudeTmpCleanup,
  createConfigLogCleanup,
  createHarnessRolloutCleanup,
  createWorktreeCleanup,
  DEFAULT_CLAUDE_TMP_MIN_AGE_MS,
  DEFAULT_CONFIG_LOG_MAX_BYTES,
  DEFAULT_CONFIG_LOG_RETAIN_BYTES,
  DEFAULT_HEARTBEAT_FILE_MAX_BYTES,
  DEFAULT_HEARTBEAT_FILE_RETAIN_BYTES,
  DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES,
  extractRolloutSelfFleetIds,
} from './resource-cleanup.mjs'

process.env.TLDA_DEV_BOT_NO_START = '1'
const {
  allChecks,
  checkBoxDisk,
  checkResourceCleanup,
  nudgeTargets,
} = await import('./dev-bot.mjs')

const GIB_KB = 1024 * 1024

function dfRow({ totalGiB = 460, usedGiB = 400, availGiB = 60, capacityPct = 87, mount = '/System/Volumes/Data' } = {}) {
  const totalKb = Math.round(totalGiB * GIB_KB)
  const usedKb = Math.round(usedGiB * GIB_KB)
  const availKb = Math.round(availGiB * GIB_KB)
  return [
    'Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on',
    `/dev/disk3s5   ${totalKb} ${usedKb}  ${availKb}    ${capacityPct}% 3853411 114174880    3%   ${mount}`,
  ].join('\n')
}

test('parseDfKilobyteTable parses macOS APFS df -k output and evaluateDiskSample classifies thresholds', () => {
  const healthy = parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 390, availGiB: 70, capacityPct: 85 }))
  assert.equal(healthy.mountPoint, '/System/Volumes/Data')
  assert.equal(healthy.freeBytes, 70 * 1024 ** 3)
  assert.equal(healthy.totalBytes, 460 * 1024 ** 3)
  assert.equal(evaluateDiskSample(healthy).level, 'ok')
  assert.equal(evaluateDiskSample(healthy).tripped, false)

  const warn = parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 418, availGiB: 42, capacityPct: 91 }))
  const warnVerdict = evaluateDiskSample(warn)
  assert.equal(warnVerdict.level, 'warn')
  assert.equal(warnVerdict.tripped, true)
  assert.equal(warnVerdict.warnFreeBytes, DEFAULT_DISK_WARN_FREE_BYTES)

  const critical = parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 440, availGiB: 20, capacityPct: 96 }))
  const critVerdict = evaluateDiskSample(critical)
  assert.equal(critVerdict.level, 'critical')
  assert.equal(critVerdict.tripped, true)
  assert.equal(critVerdict.criticalFreeBytes, DEFAULT_DISK_CRITICAL_FREE_BYTES)
})

test('collectDiskSample falls back to / when /System/Volumes/Data is absent', async () => {
  const calls = []
  const sample = await collectDiskSample({
    run: async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args[1] === '/System/Volumes/Data') {
        throw new Error('df: /System/Volumes/Data: No such file or directory')
      }
      return { stdout: dfRow({ totalGiB: 460, usedGiB: 380, availGiB: 80, mount: '/' }) }
    },
    now: () => '2026-11-13T21:00:00.000Z',
  })
  assert.deepEqual(calls, [
    ['df', '-k', '/System/Volumes/Data'],
    ['df', '-k', '/'],
  ])
  assert.equal(sample.mountPoint, '/')
  assert.equal(sample.freeBytes, 80 * 1024 ** 3)
})

test('checkBoxDisk is registered in allChecks and passes silently when free disk is above 50 GiB', async () => {
  assert.ok(allChecks().some(([name]) => name === 'box-disk'))
  let cleanupCalled = false
  const result = await checkBoxDisk({
    sampleDisk: async () => parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 390, availGiB: 70 })),
    runCleanup: async () => { cleanupCalled = true },
  })
  assert.equal(cleanupCalled, false)
  assert.equal(result.level, 'ok')
  assert.equal(result.freeBytes, 70 * 1024 ** 3)
})

test('checkBoxDisk triggers on-demand cleanup and alerts with reclaimed summary and top consumers at warn (<50 GiB) and critical (<30 GiB)', async () => {
  const cleanupCalls = []
  let sampleIdx = 0
  const warnSamples = [
    parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 418, availGiB: 42 })),
    parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 412, availGiB: 48 })),
  ]
  await assert.rejects(
    checkBoxDisk({
      sampleDisk: async () => warnSamples[Math.min(sampleIdx++, warnSamples.length - 1)],
      runCleanup: async options => {
        cleanupCalls.push(options)
        return {
          worktrees: { totalBytes: 14 * 1024 ** 3, retainedBytes: 10 * 1024 ** 3, evicted: 3 },
          configLogs: { trimmedCount: 2, reclaimedBytes: 512 * 1024 ** 2 },
          claudeTmp: { removed: 120, removedBytes: 1.5 * 1024 ** 3 },
          harnessRollouts: { skippedFailClosed: false, removed: 40, removedBytes: 2 * 1024 ** 3 },
        }
      },
      sampleTopConsumers: async () => [
        { path: '/Users/skip/.tlda', bytes: 95 * 1024 ** 3 },
        { path: '/Users/skip/worktrees', bytes: 28 * 1024 ** 3 },
      ],
    }),
    error => {
      assert.match(error.message, /^WARN disk headroom on \/System\/Volumes\/Data: 48\.0 GiB free of 460\.0 GiB/)
      assert.match(error.message, /before cleanup: 42\.0 GiB free/)
      assert.match(error.message, /on-demand cleanup: worktrees evicted=3 \(4\.0 GiB\), configLogs trimmed=2 \(512\.0 MiB\), claudeTmp removed=120 \(1\.5 GiB\), harnessRollouts removed=40 \(2\.0 GiB\)/)
      assert.match(error.message, /top consumers: \/Users\/skip\/\.tlda=95\.0 GiB, \/Users\/skip\/worktrees=28\.0 GiB/)
      return true
    },
  )
  assert.deepEqual(cleanupCalls, [{ forceFullSweep: true, worktreeBudgetBytes: undefined }])

  // Critical (<30 GiB) passes worktreeBudgetBytes: 0 for emergency inactive node_modules eviction
  const critCalls = []
  await assert.rejects(
    checkBoxDisk({
      sampleDisk: async () => parseDfKilobyteTable(dfRow({ totalGiB: 460, usedGiB: 442, availGiB: 18 })),
      runCleanup: async options => {
        critCalls.push(options)
        return { worktrees: { totalBytes: 8 * 1024 ** 3, retainedBytes: 0, evicted: 6 } }
      },
      sampleTopConsumers: async () => [],
    }),
    /CRITICAL disk headroom on \/System\/Volumes\/Data: 18\.0 GiB free/,
  )
  assert.deepEqual(critCalls, [{ forceFullSweep: true, worktreeBudgetBytes: 0 }])
})

test('nudgeTargets queries on-call & !human & !bot and never targets humans, bots, or fleet:skip', async () => {
  const queries = []
  const resolved = await nudgeTargets({
    nudgeToOverride: '',
    nudgeLabel: 'on-call',
    fleetServer: 'http://fleet.test',
    requestJson: async (_server, urlPath) => {
      queries.push(decodeURIComponent(urlPath))
      return {
        agents: [
          { id: 'fleet:skip', human: true, labels: ['on-call', 'human'] },
          { id: 'fleet:human-peer', labels: ['on-call', 'human'] },
          { id: 'fleet:some-bot', labels: ['on-call', 'bot'] },
          { id: 'fleet:ops-agent', labels: ['on-call', 'awake'] },
        ],
      }
    },
  })
  assert.equal(queries[0], '/api/fleet-table?filter=awake & on-call & !human & !bot&limit=500')
  assert.deepEqual(resolved.targets, ['fleet:ops-agent'])

  // Even if nudgeToOverride is set to fleet:skip, it refuses to target Skip
  const blockedSkip = await nudgeTargets({
    nudgeToOverride: 'fleet:skip',
    nudgeLabel: 'on-call',
  })
  assert.deepEqual(blockedSkip.targets, [])
})

test('createWorktreeCleanup defaults to 10 GiB budget, supports 0 B emergency override, and spares 0-byte symlinks', async () => {
  assert.equal(DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES, 10 * 1024 ** 3)
  const evicted = []
  const cleanup = createWorktreeCleanup({
    repoRoot: '/repo',
    listWorktrees: async () => [
      { path: '/repo', head: 'h0' },
      { path: '/wt-symlink', head: 'h1' },
      { path: '/wt-idle-1', head: 'h2' },
      { path: '/wt-idle-2', head: 'h3' },
      { path: '/wt-active', head: 'h4' },
    ],
    listActiveCwds: async () => new Set(['/wt-active/sub']),
    readStat: async () => ({ mtimeMs: 100 }),
    measureNodeModules: async entries => entries.map(e => ({
      ...e,
      mtimeMs: e.path === '/wt-idle-1' ? 1 : 2,
      sizeBytes: e.path === '/wt-symlink' ? 0 : 6 * 1024 ** 3,
    })),
    removeNodeModules: async target => evicted.push(target),
    run: async () => ({ stdout: ' M dirty\n' }),
  })

  // Default 10 GiB budget: total is 18 GiB (3 x 6 GiB); evicts oldest 2 idle caches to reach 6 GiB <= 10 GiB
  const normal = await cleanup.sweep()
  assert.equal(normal.budgetBytes, 10 * 1024 ** 3)
  assert.deepEqual(evicted, ['/wt-idle-1/node_modules', '/wt-idle-2/node_modules'])

  // Emergency 0 B override: evicts all non-active >0B caches, still sparing /wt-symlink (0 B) and /wt-active
  evicted.length = 0
  const emergency = await cleanup.sweep({ budgetBytes: 0 })
  assert.equal(emergency.budgetBytes, 0)
  assert.deepEqual(evicted, ['/wt-idle-1/node_modules', '/wt-idle-2/node_modules'])
  assert.equal(evicted.includes('/wt-symlink/node_modules'), false)
  assert.equal(evicted.includes('/wt-active/node_modules'), false)
})

test('createConfigLogCleanup trims oversized .heartbeat and .log files on complete-line boundaries and preserves .heartbeat mtime', async () => {
  assert.equal(DEFAULT_HEARTBEAT_FILE_MAX_BYTES, 256 * 1024)
  assert.equal(DEFAULT_HEARTBEAT_FILE_RETAIN_BYTES, 128 * 1024)
  assert.equal(DEFAULT_CONFIG_LOG_MAX_BYTES, 25 * 1024 * 1024)
  assert.equal(DEFAULT_CONFIG_LOG_RETAIN_BYTES, 5 * 1024 * 1024)

  const dir = await mkdtemp(path.join(tmpdir(), 'config-log-cleanup-'))
  try {
    const hbFile = path.join(dir, 'todd.testing.heartbeat')
    const logFile = path.join(dir, 'fleet-daemon.log')
    const decisionsFile = path.join(dir, 'todd.testing-decisions.jsonl')
    const untouchedFile = path.join(dir, 'daemon-mints.sqlite')

    const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify({ seq: i, pad: 'x'.repeat(80) })).join('\n') + '\n'
    await writeFile(hbFile, lines)
    await writeFile(logFile, lines)
    await writeFile(decisionsFile, lines)
    await writeFile(untouchedFile, lines)

    // Backdate the heartbeat file to 30 minutes ago to prove trimming does not make a stopped bot look freshly beating
    const oldDate = new Date(Date.now() - 30 * 60_000)
    await utimes(hbFile, oldDate, oldDate)
    const beforeHbStat = await stat(hbFile)

    const cleanup = createConfigLogCleanup({
      configDir: dir,
      heartbeatMaxBytes: 8 * 1024,
      heartbeatRetainBytes: 4 * 1024,
      logMaxBytes: 12 * 1024,
      logRetainBytes: 4 * 1024,
    })

    const result = await cleanup.sweep()
    assert.equal(result.trimmedCount, 3)
    assert.ok(result.reclaimedBytes > 0)
    assert.deepEqual(result.errors, [])

    const afterHbStat = await stat(hbFile)
    assert.ok(afterHbStat.size <= 4 * 1024)
    // mtime preserved within 1s tolerance
    assert.ok(Math.abs(afterHbStat.mtimeMs - beforeHbStat.mtimeMs) < 1000)

    const hbParsed = (await readFile(hbFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(hbParsed[hbParsed.length - 1].seq, 399)

    const untouchedStat = await stat(untouchedFile)
    assert.equal(untouchedStat.size, Buffer.byteLength(lines))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createClaudeTmpCleanup removes expired files in /private/tmp/claude-* and spares young or open files', async () => {
  assert.equal(DEFAULT_CLAUDE_TMP_MIN_AGE_MS, 4 * 60 * 60_000)
  const removed = []
  const nowMs = 10_000_000_000
  const oldMs = nowMs - DEFAULT_CLAUDE_TMP_MIN_AGE_MS - 60_000
  const freshMs = nowMs - 60_000

  const tree = {
    '/private/tmp': ['claude-501', 'claude-top-old.html', 'unrelated-dir'],
    '/private/tmp/claude-501': ['tasks'],
    '/private/tmp/claude-501/tasks': ['old.output', 'open.output', 'fresh.output'],
  }
  const stats = {
    '/private/tmp/claude-501': { isDirectory: () => true, isFile: () => false },
    '/private/tmp/claude-501/tasks': { isDirectory: () => true, isFile: () => false },
    '/private/tmp/claude-501/tasks/old.output': { isDirectory: () => false, isFile: () => true, size: 1000, mtimeMs: oldMs },
    '/private/tmp/claude-501/tasks/open.output': { isDirectory: () => false, isFile: () => true, size: 2000, mtimeMs: oldMs },
    '/private/tmp/claude-501/tasks/fresh.output': { isDirectory: () => false, isFile: () => true, size: 3000, mtimeMs: freshMs },
    '/private/tmp/claude-top-old.html': { isDirectory: () => false, isFile: () => true, size: 500, mtimeMs: oldMs },
  }

  const cleanup = createClaudeTmpCleanup({
    tmpRoot: '/private/tmp',
    now: () => nowMs,
    listEntries: async dir => tree[dir] || [],
    readStat: async target => stats[target],
    listOpenFiles: async () => new Set(['/private/tmp/claude-501/tasks/open.output']),
    removeFile: async target => { removed.push(target) },
  })

  const result = await cleanup.sweep()
  assert.deepEqual(removed, [
    '/private/tmp/claude-501/tasks/old.output',
    '/private/tmp/claude-top-old.html',
  ])
  assert.equal(result.removed, 2)
  assert.equal(result.removedBytes, 1500)
  assert.equal(result.retained, 2)
  assert.equal(result.retainedBytes, 5000)
  assert.deepEqual(result.errors, [])
})

test('createHarnessRolloutCleanup fails closed when local DB or server lookup fails or returns empty', async () => {
  const removed = []
  const baseOptions = {
    configRoots: ['/configs'],
    removeFile: async target => { removed.push(target) },
  }

  const dbThrows = await createHarnessRolloutCleanup({
    ...baseOptions,
    readLocalRecords: async () => { throw new Error('sqlite busy') },
    lookupAgentsByIds: async () => [{ id: 'fleet:dead1', labels: ['dead'] }],
  }).sweep()
  assert.equal(dbThrows.skippedFailClosed, true)
  assert.match(dbThrows.reason, /sqlite busy/)

  const dbEmpty = await createHarnessRolloutCleanup({
    ...baseOptions,
    readLocalRecords: async () => [],
    lookupAgentsByIds: async () => [{ id: 'fleet:dead1', labels: ['dead'] }],
  }).sweep()
  assert.equal(dbEmpty.skippedFailClosed, true)

  const serverThrows = await createHarnessRolloutCleanup({
    ...baseOptions,
    readLocalRecords: async () => [{ fleetId: 'fleet:dead1', sessionIds: ['s1'], sessionPaths: [] }],
    lookupAgentsByIds: async () => { throw new Error('HTTP 502') },
  }).sweep()
  assert.equal(serverThrows.skippedFailClosed, true)
  assert.match(serverThrows.reason, /HTTP 502/)

  const serverEmpty = await createHarnessRolloutCleanup({
    ...baseOptions,
    readLocalRecords: async () => [{ fleetId: 'fleet:dead1', sessionIds: ['s1'], sessionPaths: [] }],
    lookupAgentsByIds: async () => [],
  }).sweep()
  assert.equal(serverEmpty.skippedFailClosed, true)
  assert.deepEqual(removed, [])
})

test('extractRolloutSelfFleetIds matches only authoritative self-identity markers and ignores task IDs, fleet:skip, and peer/PM chat mentions', () => {
  const kickoffAndLoginSnippet = [
    '{"type":"user","message":"--- [tlda-agent:fleet:df93956a] Check inbox(). Task [fleet:66e4-mui8ba3j] from fleet:daac9052 per fleet:skip ruling."}',
    '{"type":"tool_result","content":"Logged in fleet:df93956a.\\n{\\"fleet_id\\":\\"fleet:df93956a\\"}"}',
    '{"hook":"http://127.0.0.1:8765/api/agent-hook?agent=fleet%3Adf93956a"}',
  ].join('\n')
  assert.deepEqual(extractRolloutSelfFleetIds(kickoffAndLoginSnippet), ['fleet:df93956a'])
  assert.deepEqual(
    extractRolloutSelfFleetIds('Task fleet:66e4-mui8ba3j delegated by fleet:daac9052 for fleet:skip'),
    [],
  )
})

test('createHarnessRolloutCleanup prunes only rollouts whose owning agents are all confirmed dead and retains awake, hibernating, and unowned orphan rollouts', async () => {
  const nowMs = 20_000_000_000
  const twoHoursAgo = nowMs - 2 * 60 * 60_000
  const tenDaysAgo = nowMs - 10 * 24 * 60 * 60_000

  const awakeUuid = '11111111-1111-4111-8111-111111111111'
  const hibernatingUuid = '22222222-2222-4222-8222-222222222222'
  const deadUuid = '33333333-3333-4333-8333-333333333333'
  const headerOwnedDeadUuid = '44444444-4444-4444-8444-444444444444'
  const headerOwnedHibernatingUuid = '55555555-5555-4555-8555-555555555555'
  const unownedOrphanUuid = '66666666-6666-4666-8666-666666666666'

  const awakePath = `/configs/app/codex/sessions/2026/11/01/rollout-2026-11-01T00-00-00-${awakeUuid}.jsonl`
  const hibernatingPath = `/configs/app/claude/projects/-Users-skip-work-tlda/${hibernatingUuid}.jsonl`
  const deadPath = `/configs/app/codex/sessions/2026/11/01/rollout-2026-11-01T00-00-00-${deadUuid}.jsonl`
  const headerOwnedDeadPath = `/configs/app/claude/projects/-Users-skip-work-tlda/${headerOwnedDeadUuid}.jsonl`
  const headerOwnedHibernatingPath = `/configs/app/claude/projects/-Users-skip-work-tlda/${headerOwnedHibernatingUuid}.jsonl`
  const unownedOrphanPath = `/configs/app/claude/projects/-Users-skip-work-tlda/${unownedOrphanUuid}.jsonl`

  const tree = {
    '/configs': ['app'],
    '/configs/app/codex/sessions': ['2026'],
    '/configs/app/codex/sessions/2026': ['11'],
    '/configs/app/codex/sessions/2026/11': ['01'],
    '/configs/app/codex/sessions/2026/11/01': [
      path.basename(awakePath),
      path.basename(deadPath),
    ],
    '/configs/app/claude/projects': ['-Users-skip-work-tlda'],
    '/configs/app/claude/projects/-Users-skip-work-tlda': [
      path.basename(hibernatingPath),
      path.basename(headerOwnedDeadPath),
      path.basename(headerOwnedHibernatingPath),
      path.basename(unownedOrphanPath),
    ],
  }

  const fileStats = {
    [awakePath]: { size: 100, mtimeMs: tenDaysAgo },
    [hibernatingPath]: { size: 200, mtimeMs: tenDaysAgo },
    [deadPath]: { size: 300, mtimeMs: twoHoursAgo },
    [headerOwnedDeadPath]: { size: 400, mtimeMs: tenDaysAgo },
    [headerOwnedHibernatingPath]: { size: 500, mtimeMs: tenDaysAgo },
    [unownedOrphanPath]: { size: 600, mtimeMs: tenDaysAgo },
  }

  const headers = {
    // Confirmed-dead rollout that mentions fleet:skip, delegating PM fleet:awake-agent, and task ID fleet:66e4-mui8ba3j in prose MUST still be pruned!
    [deadPath]: '[tlda-agent:fleet:dead-agent] Task fleet:66e4-mui8ba3j delegated by fleet:awake-agent for fleet:skip. Logged in fleet:dead-agent.',
    // Unindexed rollout whose self-identity is confirmed dead on the server is pruned:
    [headerOwnedDeadPath]: '{"content":"Logged in fleet:dead-agent.\\n{\\"fleet_id\\":\\"fleet:dead-agent\\"}"}',
    // Unindexed rollout whose self-identity names a hibernating agent MUST be spared:
    [headerOwnedHibernatingPath]: '[tlda-agent:fleet:hibernating-agent]',
    // Unindexed >10d orphan rollout with NO confirmed-dead owner MUST be spared (fail-closed):
    [unownedOrphanPath]: 'plain transcript with no self-identity and task mention fleet:66e4-mui8ba3j',
  }

  const removed = []
  const cleanup = createHarnessRolloutCleanup({
    configRoots: ['/configs'],
    now: () => nowMs,
    readLocalRecords: async () => [
      { fleetId: 'fleet:awake-agent', sessionIds: [awakeUuid], sessionPaths: [awakePath] },
      { fleetId: 'fleet:hibernating-agent', sessionIds: [hibernatingUuid], sessionPaths: [hibernatingPath] },
      { fleetId: 'fleet:dead-agent', sessionIds: [deadUuid], sessionPaths: [deadPath] },
    ],
    lookupAgentsByIds: async () => [
      { id: 'fleet:awake-agent', labels: ['awake'] },
      { id: 'fleet:hibernating-agent', labels: ['hibernating'] },
      { id: 'fleet:dead-agent', labels: ['dead'] },
    ],
    listEntries: async dir => tree[dir] || [],
    readStat: async target => {
      if (fileStats[target]) {
        return { isDirectory: () => false, isFile: () => true, ...fileStats[target] }
      }
      return { isDirectory: () => true, isFile: () => false }
    },
    readHeaderSnippet: async target => headers[target] || '',
    listOpenFiles: async () => new Set(),
    removeFile: async target => { removed.push(target) },
  })

  const result = await cleanup.sweep()
  assert.equal(result.skippedFailClosed, false)
  assert.deepEqual(removed, [deadPath, headerOwnedDeadPath])
  assert.equal(result.removed, 2)
  assert.equal(result.removedDead, 2)
  assert.equal(result.retained, 4)
  assert.equal(removed.includes(awakePath), false)
  assert.equal(removed.includes(hibernatingPath), false)
  assert.equal(removed.includes(headerOwnedHibernatingPath), false)
  assert.equal(removed.includes(unownedOrphanPath), false)
})

test('checkResourceCleanup runs retention drivers when forceFullSweep is true', async () => {
  let configSwept = 0
  let claudeSwept = 0
  let rolloutSwept = 0
  let budgetPassed = null

  const summary = await checkResourceCleanup({
    forceFullSweep: true,
    worktreeBudgetBytes: 0,
    previewReaper: () => ({ reaped: [], failed: [] }),
    playwrightCleanup: { sweep: async () => [] },
    worktreeCleanupDriver: {
      sweep: async options => {
        budgetPassed = options?.budgetBytes
        return {
          totalBytes: 1000,
          retainedBytes: 0,
          overBudgetBytes: 0,
          removedWorktrees: [],
          evicted: [{ path: '/wt1' }],
          pinned: [],
          abandoned: [],
          unremovable: [],
        }
      },
    },
    configLogCleanupDriver: {
      sweep: async () => {
        configSwept += 1
        return { trimmedCount: 2, reclaimedBytes: 4096, errors: [] }
      },
    },
    claudeTmpCleanupDriver: {
      sweep: async () => {
        claudeSwept += 1
        return { removed: 5, removedBytes: 8192, retained: 1, retainedBytes: 100, errors: [] }
      },
    },
    harnessRolloutCleanupDriver: {
      sweep: async () => {
        rolloutSwept += 1
        return { skippedFailClosed: false, removed: 3, removedBytes: 16384, retained: 10, retainedBytes: 50000, errors: [] }
      },
    },
  })

  assert.equal(budgetPassed, 0)
  assert.equal(configSwept, 1)
  assert.equal(claudeSwept, 1)
  assert.equal(rolloutSwept, 1)
  assert.deepEqual(summary.configLogs, { trimmedCount: 2, reclaimedBytes: 4096 })
  assert.deepEqual(summary.claudeTmp, { removed: 5, removedBytes: 8192, retained: 1, retainedBytes: 100 })
  assert.deepEqual(summary.harnessRollouts, { skippedFailClosed: false, removed: 3, removedBytes: 16384, retained: 10, retainedBytes: 50000 })
})
