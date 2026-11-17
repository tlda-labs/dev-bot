import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const {
  checkResourceCleanup,
  commands,
  configSchema,
  parseMiniLoadCsv,
  publishMiniLoadReport,
  renderMiniLoadCsv,
  renderMiniLoadQmd,
  renderStatusMarkdown,
} = await import('./dev-bot.mjs')

test('linked remote safety probe is explicit opt-in', () => {
  assert.equal(configSchema.fields.linkedRemoteEnabled.default, false)
  assert.equal(configSchema.fields.linkedRemoteEnabled.env, 'TLDA_DEV_BOT_LINKED_REMOTE_ENABLED')
  assert.equal(configSchema.fields.linkedRemoteUrl.default, '')
  assert.equal(configSchema.fields.linkedRemoteUrl.env, 'TLDA_DEV_BOT_LINKED_REMOTE_URL')
  assert.equal(configSchema.fields.linkedRemoteTokenFile.default, '')
  assert.equal(configSchema.fields.linkedRemoteTokenFile.env, 'TLDA_DEV_BOT_LINKED_REMOTE_TOKEN_FILE')
})

test('Mini load periodic publisher is explicit opt-in', () => {
  assert.equal(configSchema.fields.loadReportEnabled.default, false)
  assert.equal(configSchema.fields.loadReportEnabled.env, 'TLDA_DEV_BOT_LOAD_REPORT_ENABLED')
})

test('status Markdown is semantic, labeled, timestamped, provenance-bearing, and interactive', () => {
  const report = renderStatusMarkdown([{
    ts: '2026-07-30T05:00:00.000Z',
    totalBytes: 4096,
    retainedBytes: 2048,
    overBudgetBytes: 0,
    removedWorktrees: 1,
    evictedCaches: 2,
    pinnedWorktrees: 3,
    abandonedWorktrees: 0,
  }])
  assert.match(report, /The latest sweep retained 2\.0 KiB/)
  assert.match(report, /\| Timestamp \| Total caches \|/)
  assert.match(report, /Provenance:/)
  assert.match(report, /2026-07-30T05:00:00\.000Z/)
  assert.match(report, /<svg[\s\S]*<title>/)
  assert.match(report, /^# Dev bot disk and worktree status\n/)
})

test('status replies inline with the latest completed cleanup and exposes reply failure', async () => {
  const cleanup = await checkResourceCleanup({
    previewReaper: () => ({ reaped: [], failed: [] }),
    playwrightCleanup: { sweep: async () => [] },
    worktreeCleanupDriver: { sweep: async () => ({
      totalBytes: 4096, retainedBytes: 2048, overBudgetBytes: 0,
      removedWorktrees: [{}], evicted: [{}, {}], pinned: [], abandoned: [], unremovable: [],
    }) },
    forceFullSweep: true,
  })
  assert.equal(cleanup.worktrees.retainedBytes, 2048)
  const status = commands.find(command => command.name === 'status')
  const replies = []
  await status.handler({ reply: async message => replies.push(message) })
  assert.equal(replies.length, 1)
  assert.match(replies[0], /^# Dev bot disk and worktree status\n/)
  assert.match(replies[0], /The latest sweep retained 2\.0 KiB/)
  assert.match(replies[0], /1 merged clean worktree\(s\) and 2 cache\(s\)/)
  assert.match(replies[0], /\| Timestamp \| Total caches \|/)
  assert.match(replies[0], /Generated: \d{4}-/)
  assert.match(replies[0], /Provenance:/)
  assert.doesNotMatch(replies[0], /\/docs\/info\/|\{\.volatile\}/)
  assert.equal(configSchema.fields.statusFile, undefined)

  await assert.rejects(
    status.handler({ reply: async () => { throw new Error('refused') } }),
    /refused/,
  )
})

test('Mini load CSV is real-row shaped, escaped, and parseable', () => {
  const csv = renderMiniLoadCsv([{
    ts: '2026-08-10T03:00:00.000Z',
    machine: 'mini',
    cores: 10,
    load1: 2.4,
    load5: 2.8,
    load15: 3.1,
    cpuBusyPercent: 18.5,
    memoryUsedBytes: 8589934592,
    memoryTotalBytes: 25769803776,
    memoryUsedPercent: 33.3,
    eventLoopLagMs: 4.2,
    awakeAgents: 12,
    botAgents: 3,
    humanAgents: 1,
    tmuxTotal: 14,
    tmuxFleet: 9,
    tmuxPlaywright: 2,
  }])
  assert.match(csv, /^ts,machine,cores,load1,load5,load15,cpuBusyPercent,memoryUsedBytes,memoryTotalBytes,memoryUsedPercent,eventLoopLagMs,awakeAgents,botAgents,humanAgents,tmuxTotal,tmuxFleet,tmuxPlaywright\n/)
  assert.equal(parseMiniLoadCsv(csv).at(-1).machine, 'mini')
  assert.equal(parseMiniLoadCsv(csv).at(-1).load1, '2.4')
})

test('Mini load QMD reads the CSV with OJS and presents reassurance from real rows', () => {
  const qmd = renderMiniLoadQmd({ dataFile: 'mini-load.csv', retainedSamples: 120 })
  assert.match(qmd, /^---\ntitle: Mini load report/)
  assert.match(qmd, /FileAttachment\("mini-load\.csv"\)\.csv\(\{typed: true\}\)/)
  assert.match(qmd, /The Mini is running comfortably in this window/)
  assert.match(qmd, /Newest 120 rows/)
  assert.match(qmd, /Plot\.plot/)
  assert.doesNotMatch(qmd, /fetch\(|Generators\.observe|<svg/)
})

test('Mini load publication creates the qmd project, appends CSV rows, bounds them, and exposes failure', async () => {
  const report = {
    generatedAt: '2026-08-10T03:00:30.000Z',
    machine: 'mini',
    cores: 10,
    fleet: { awakeAgents: 12, botAgents: 3, humanAgents: 1 },
    tmux: { total: 14, fleet: 9, playwright: 2 },
    samples: [{
      ts: '2026-08-10T03:00:00.000Z',
      load1: 2.4,
      load5: 2.8,
      load15: 3.1,
      cpuBusyPercent: 18.5,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 24 * 1024 ** 3,
      memoryUsedPercent: 33.3,
      eventLoopLagMs: 4.2,
    }],
  }
  const calls = []
  const pushed = []
  const existingCsv = renderMiniLoadCsv(Array.from({ length: 120 }, (_, index) => ({
    ts: `2026-08-10T02:${String(index).padStart(2, '0')}:00.000Z`,
    machine: 'mini',
    cores: 10,
    load1: index,
  })))
  const requestJson = async (_base, urlPath, options = {}) => {
    calls.push({ urlPath, options })
    if (urlPath === '/api/projects/mini-load' && options.method !== 'POST') return { status: 404, body: {} }
    if (urlPath === '/api/projects') return { status: 200, body: { ok: true } }
    if (urlPath.endsWith('/source-authority')) return { status: 200, body: { currentRevision: 'rev-1' } }
    if (urlPath.endsWith('/push')) {
      pushed.push(options.body)
      return { status: 200, body: { ok: true, authority: { currentRevision: 'rev-2' } } }
    }
    throw new Error(`unexpected ${urlPath}`)
  }
  const requestText = async () => existingCsv

  assert.match(await publishMiniLoadReport({ report, requestJson, requestText, bootstrap: true }), /^\[Mini load report\]\(\/docs\/mini-load\/index\.html\)$/)
  assert.deepEqual(calls.find(call => call.urlPath === '/api/projects').options.body, {
    name: 'mini-load',
    title: 'Mini load report',
    mainFile: 'index.qmd',
    format: 'qmd',
  })
  assert.deepEqual(pushed[0].sourceManifest, ['index.qmd', 'mini-load.csv'])
  assert.deepEqual(pushed[0].files.map(file => file.path), ['index.qmd', 'mini-load.csv'])
  assert.match(pushed[0].files.find(file => file.path === 'index.qmd').content, /FileAttachment\("mini-load\.csv"\)\.csv/)
  const rows = parseMiniLoadCsv(pushed[0].files.find(file => file.path === 'mini-load.csv').content)
  assert.equal(rows.length, 120)
  assert.equal(rows[0].ts, '2026-08-10T02:01:00.000Z')
  assert.equal(rows.at(-1).ts, '2026-08-10T03:00:00.000Z')
  assert.equal(rows.at(-1).awakeAgents, '12')

  await assert.rejects(
    publishMiniLoadReport({
      report,
      requestText: async () => '',
      requestJson: async (_base, urlPath, options = {}) => {
        if (urlPath === '/api/projects/mini-load' && options.method !== 'POST') return { status: 200, body: { format: 'qmd', mainFile: 'index.qmd' } }
        if (urlPath.endsWith('/source-authority')) return { status: 200, body: { currentRevision: null } }
        if (urlPath.endsWith('/push')) return { status: 200, body: { ok: false, error: 'refused' } }
        throw new Error(`unexpected ${urlPath}`)
      },
    }),
    /refused/,
  )
})

test('generated README command and configuration sections have no drift', () => {
  const result = spawnSync(process.execPath, ['generate-docs.mjs', '--check'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, TLDA_DEV_BOT_NO_START: '1' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})
