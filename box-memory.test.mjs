import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BoxMemorySetupError,
  MIN_PS_LINES,
  classifyTriple,
  collectSample,
  createBoxMemoryWatch,
  formatExcursionNotice,
  isChromiumProcess,
  isMcpServer,
  isRendererProcess,
  parsePressureLevel,
  parsePsTable,
  parseVmStat,
  topByRss,
} from './box-memory.mjs'

// ---------------------------------------------------------------------------
// Fixtures: shapes copied from the live box, 2026-09-27.
// ---------------------------------------------------------------------------

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5992.
Pages active:                                 224525.
Swapins:                                   533876789.
Swapouts:                                  568472210.
`

const RENDERER_CMD = '/Users/skip/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/151.0.7922.10/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/Users/skip/Library/Caches/ms-playwright/daemon/e9044018ee20ff1b/ud-shared-chrome-for-testing --renderer-client-id=8'
const MAIN_BROWSER_CMD = '/Users/skip/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --user-data-dir=/Users/skip/Library/Caches/ms-playwright/daemon/e9044018ee20ff1b/ud-shared-chrome-for-testing'
const MCP_SERVER_CMD = '/opt/homebrew/Cellar/node/26.3.1/bin/node /Users/skip/work/deploy/testing-releases/4edd858c38615506019fb6524cc6555fbecfea73/node_modules/@playwright/mcp/cli.js --browser chromium --isolated --no-sandbox --executable-path /Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const MCP_SERVER_PLAIN = '/opt/homebrew/Cellar/node/26.3.1/bin/node /Users/skip/work/deploy/testing-releases/a318340c4d6cea2addaf4a1b81a3f69ce25641bf/node_modules/@playwright/mcp/cli.js'
const AGENT_MENTIONER = 'claude --settings {"hooks":{}} --mcp-config {"mcpServers":{"tlda":{"args":["/Users/skip/work/deploy/testing-releases/a318340c4d6cea2addaf4a1b81a3f69ce25641bf/node_modules/@playwright/mcp/cli.js"]}}}'
const DAEMON_CMD = '/opt/homebrew/Cellar/node/26.3.1/bin/node /Users/skip/work/tlda/node_modules/.pnpm/playwright-core@1.62.0-alpha-1783623505000/node_modules/playwright-core/lib/entry/cliDaemon.js shared --headed --browser=chromium'

function psLine(pid, ppid, rssKb, command) {
  return `${String(pid).padStart(5)}${String(ppid).padStart(6)}${String(rssKb).padStart(9)} ${command}`
}

function psTable(rows) {
  const filler = []
  for (let i = 0; i < MIN_PS_LINES; i++) {
    filler.push(psLine(100 + i, 1, 1024, `/usr/libexec/filler-${i}`))
  }
  return ['  PID  PPID      RSS COMMAND', ...filler, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// vm_stat
// ---------------------------------------------------------------------------

test('parseVmStat reads page size and counters', () => {
  const parsed = parseVmStat(VM_STAT)
  assert.equal(parsed.pageSizeBytes, 16384)
  assert.equal(parsed.swapouts, 568472210)
  assert.equal(parsed.swapins, 533876789)
})

test('parseVmStat refuses a half-parsed read instead of reporting zero', () => {
  assert.throws(() => parseVmStat('Swapouts: 12.\n'), BoxMemorySetupError)
  assert.throws(() => parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n'), BoxMemorySetupError)
  assert.throws(() => parseVmStat(''), BoxMemorySetupError)
})

// ---------------------------------------------------------------------------
// pressure
// ---------------------------------------------------------------------------

test('parsePressureLevel reads the opaque integer', () => {
  assert.equal(parsePressureLevel('1\n'), 1)
  assert.equal(parsePressureLevel('2'), 2)
})

test('parsePressureLevel refuses non-integers rather than guessing', () => {
  assert.throws(() => parsePressureLevel('normal\n'), BoxMemorySetupError)
  assert.throws(() => parsePressureLevel(''), BoxMemorySetupError)
})

// ---------------------------------------------------------------------------
// ps table
// ---------------------------------------------------------------------------

test('parsePsTable skips the header by shape and reads rows', () => {
  const rows = parsePsTable(psTable([psLine(37007, 26270, 375808, RENDERER_CMD)]))
  const hit = rows.find(row => row.pid === 37007)
  assert.equal(hit.ppid, 26270)
  assert.equal(hit.rssKb, 375808)
  assert.equal(hit.command, RENDERER_CMD)
})

test('parsePsTable treats a near-empty table as a broken instrument', () => {
  assert.throws(() => parsePsTable('  PID  PPID      RSS COMMAND\n'), BoxMemorySetupError)
  assert.throws(() => parsePsTable(''), BoxMemorySetupError)
})

// ---------------------------------------------------------------------------
// triple classification
// ---------------------------------------------------------------------------

test('MCP server matches argv, not substring: mentioners are not servers', () => {
  assert.equal(isMcpServer(MCP_SERVER_CMD), true)
  assert.equal(isMcpServer(MCP_SERVER_PLAIN), true)
  assert.equal(isMcpServer(AGENT_MENTIONER), false)
  assert.equal(isMcpServer('grep @playwright/mcp/cli.js'), false)
  assert.equal(isMcpServer(DAEMON_CMD), false)
})

test('chromium population covers mains, renderers and helpers, not mentioners', () => {
  assert.equal(isChromiumProcess(MAIN_BROWSER_CMD), true)
  assert.equal(isChromiumProcess(RENDERER_CMD), true)
  assert.equal(isChromiumProcess(MCP_SERVER_CMD), false)
  assert.equal(isChromiumProcess(AGENT_MENTIONER), false)
})

test('chromium process covers renderers and main, not MCP servers', () => {
  assert.equal(isChromiumProcess(RENDERER_CMD), true)
  assert.equal(isChromiumProcess(MAIN_BROWSER_CMD), true)
  assert.equal(isChromiumProcess(MCP_SERVER_CMD), false)
  assert.equal(isChromiumProcess(AGENT_MENTIONER), false)
})

test('renderer identification is renderer-only', () => {
  assert.equal(isRendererProcess(RENDERER_CMD), true)
  assert.equal(isRendererProcess(MAIN_BROWSER_CMD), false)
  assert.equal(isRendererProcess(MCP_SERVER_CMD), false)
})

test('classifyTriple counts servers/browsers/orphans; cliDaemon is in none', () => {
  const rows = [
    { pid: 98422, ppid: 98262, rssKb: 50000, command: MCP_SERVER_PLAIN },
    { pid: 80543, ppid: 1, rssKb: 50000, command: MCP_SERVER_PLAIN },
    { pid: 98262, ppid: 1016, rssKb: 250000, command: AGENT_MENTIONER },
    { pid: 26270, ppid: 25716, rssKb: 100000, command: MAIN_BROWSER_CMD },
    { pid: 37007, ppid: 26270, rssKb: 200000, command: RENDERER_CMD },
    { pid: 25716, ppid: 1, rssKb: 80000, command: DAEMON_CMD },
  ]
  const triple = classifyTriple(rows)
  assert.deepEqual(triple.servers.map(entry => entry.pid).sort(), [80543, 98422])
  // The browser leg is the whole population: mains AND renderers.
  assert.deepEqual(triple.browsers.map(entry => entry.pid).sort(), [26270, 37007])
  assert.deepEqual(triple.orphans.map(entry => entry.pid), [80543])
})

// ---------------------------------------------------------------------------
// top-N
// ---------------------------------------------------------------------------

test('topByRss ranks by RSS on the full row, never by name', () => {
  const rows = [
    { pid: 1, ppid: 0, rssKb: 459 * 1024, command: '/usr/bin/pandoc args' },
    { pid: 2, ppid: 0, rssKb: 4267 * 1024, command: RENDERER_CMD },
    { pid: 3, ppid: 0, rssKb: 100, command: '/bin/small' },
  ]
  const top = topByRss(rows, 2)
  assert.deepEqual(top.map(entry => entry.pid), [2, 1])
  assert.equal(top[0].command, RENDERER_CMD)
})

// ---------------------------------------------------------------------------
// excursion machine
// ---------------------------------------------------------------------------

function sampleAt(ts, { pressure = 1, swapouts = 1000, rows = [] } = {}) {
  const filler = []
  for (let i = 0; i < MIN_PS_LINES; i++) {
    filler.push({ pid: 100 + i, ppid: 1, rssKb: 1024, command: `/usr/libexec/filler-${i}` })
  }
  return { ts, pressure, pageSizeBytes: 16384, swapouts, swapins: 900, rows: [...filler, ...rows] }
}

const T0 = Date.parse('2026-09-27T05:00:00.000Z')
const iso = ms => new Date(ms).toISOString()

test('a calm box never opens an excursion', () => {
  const watch = createBoxMemoryWatch()
  let assessment
  for (let i = 0; i < 5; i++) {
    assessment = watch.observe(sampleAt(iso(T0 + i * 60_000), { pressure: 1, swapouts: 1000 }))
  }
  assert.equal(assessment.excursion, null)
  assert.equal(assessment.swap.ratePerS, 0)
})

test('pressure 1->2 opens; 2->1 closes', () => {
  const watch = createBoxMemoryWatch()
  watch.observe(sampleAt(iso(T0), { pressure: 1 }))
  const firing = watch.observe(sampleAt(iso(T0 + 60_000), { pressure: 2 }))
  assert.ok(firing.excursion)
  assert.ok(firing.excursion.legs.pressure)
  assert.deepEqual(firing.excursion.transitions, [{ from: 1, to: 2, at: iso(T0 + 60_000) }])
  const cleared = watch.observe(sampleAt(iso(T0 + 120_000), { pressure: 1 }))
  assert.equal(cleared.excursion, null)
  assert.ok(cleared.events.includes('excursion closed'))
})

test('restarting into pressure 2 adopts it as settled; the recovery is silent', () => {
  const watch = createBoxMemoryWatch()
  watch.observe(sampleAt(iso(T0), { pressure: 2 }))
  const assessment = watch.observe(sampleAt(iso(T0 + 60_000), { pressure: 1 }))
  assert.equal(assessment.excursion, null)
  assert.equal(assessment.pressure.settledLevel, 1)
})

test('swapout resumption opens on the edge; below-threshold closes', () => {
  const watch = createBoxMemoryWatch({ swapoutWindowMs: 600_000, swapoutRateThresholdPerS: 100 })
  watch.observe(sampleAt(iso(T0), { swapouts: 1000 }))
  // +142K pages over 600s ~= 237/s: the 01:00 puff shape.
  const firing = watch.observe(sampleAt(iso(T0 + 600_000), { swapouts: 143000 }))
  assert.ok(firing.excursion)
  assert.ok(firing.excursion.legs.swap)
  assert.ok(firing.swap.ratePerS > 100)
  const cleared = watch.observe(sampleAt(iso(T0 + 1_200_000), { swapouts: 143000 }))
  assert.equal(cleared.excursion, null)
})

test('a renderer climbing 727MB->4267MB trips the climber leg', () => {
  const watch = createBoxMemoryWatch({ climbSamples: 3, climbRateMbPerMin: 850 })
  const rss = [727, 2000, 4267].map(mb => mb * 1024)
  let assessment
  rss.forEach((rssKb, i) => {
    assessment = watch.observe(sampleAt(iso(T0 + i * 60_000), {
      rows: [{ pid: 37007, ppid: 26270, rssKb, command: RENDERER_CMD }],
    }))
  })
  assert.ok(assessment.excursion)
  assert.ok(assessment.excursion.legs.climber)
  assert.deepEqual(assessment.excursion.legs.climber.pids, [37007])
  assert.equal(assessment.climbers[0].pid, 37007)
  assert.ok(assessment.climbers[0].rateMbPerMin >= 850)
})

test('shuffling steady browsers do not trip: no level, no count, no total', () => {
  const watch = createBoxMemoryWatch({ climbSamples: 3, climbRateMbPerMin: 850 })
  // 36 chromium procs at ~72MB mean, order shuffling, none growing: 01:25 shape.
  let assessment
  for (let i = 0; i < 4; i++) {
    const rows = []
    for (let p = 0; p < 36; p++) {
      const wobble = ((i * 37 + p * 11) % 21) - 10
      rows.push({ pid: 30000 + p, ppid: 26270, rssKb: (72 + wobble) * 1024, command: RENDERER_CMD })
    }
    assessment = watch.observe(sampleAt(iso(T0 + i * 60_000), { rows }))
  }
  assert.equal(assessment.excursion, null)
})

test('agent RSS growth never trips the climber leg: browsers are the subject', () => {
  const watch = createBoxMemoryWatch({ climbSamples: 3, climbRateMbPerMin: 1 })
  let assessment
  ;[100, 2000, 5000].forEach((mb, i) => {
    assessment = watch.observe(sampleAt(iso(T0 + i * 60_000), {
      rows: [{ pid: 9999, ppid: 1, rssKb: mb * 1024, command: '/opt/homebrew/bin/claude --model opus some-agent-work' }],
    }))
  })
  assert.equal(assessment.excursion, null)
  // ...but the growth is still carried in top-N with deltas.
  assert.ok(assessment.top[0].deltaKb > 0)
})

test('a pid missing a sample loses its streak', () => {
  const watch = createBoxMemoryWatch({ climbSamples: 3, climbRateMbPerMin: 1 })
  watch.observe(sampleAt(iso(T0), { rows: [{ pid: 37007, ppid: 26270, rssKb: 100 * 1024, command: RENDERER_CMD }] }))
  watch.observe(sampleAt(iso(T0 + 60_000), { rows: [] }))
  const assessment = watch.observe(sampleAt(iso(T0 + 120_000), { rows: [{ pid: 37007, ppid: 26270, rssKb: 5000 * 1024, command: RENDERER_CMD }] }))
  assert.equal(assessment.climbers.length, 0)
})

test('identical timestamps cannot trip: no rate over zero time', () => {
  const watch = createBoxMemoryWatch({ climbSamples: 3, climbRateMbPerMin: 1 })
  let assessment
  ;[100, 2000, 5000].forEach(mb => {
    assessment = watch.observe(sampleAt(iso(T0), {
      rows: [{ pid: 37007, ppid: 26270, rssKb: mb * 1024, command: RENDERER_CMD }],
    }))
  })
  assert.equal(assessment.climbers.length, 0)
})

test('top-N carries per-pid deltas since the previous read', () => {
  const watch = createBoxMemoryWatch({ topN: 2 })
  watch.observe(sampleAt(iso(T0), {
    rows: [
      { pid: 37007, ppid: 26270, rssKb: 700 * 1024, command: RENDERER_CMD },
      { pid: 9000, ppid: 1, rssKb: 100 * 1024, command: '/usr/bin/quite-small' },
    ],
  }))
  const assessment = watch.observe(sampleAt(iso(T0 + 60_000), {
    rows: [
      { pid: 37007, ppid: 26270, rssKb: 800 * 1024, command: RENDERER_CMD },
      { pid: 9000, ppid: 1, rssKb: 90 * 1024, command: '/usr/bin/quite-small' },
    ],
  }))
  assert.equal(assessment.top[0].pid, 37007)
  assert.equal(assessment.top[0].deltaKb, 100 * 1024)
  assert.equal(assessment.top[1].deltaKb, -10 * 1024)
  assert.equal(assessment.largest.pid, 37007)
})

// ---------------------------------------------------------------------------
// notice rendering
// ---------------------------------------------------------------------------

test('the notice carries transition, rate+window, largest by command, firing state', () => {
  const watch = createBoxMemoryWatch({ swapoutRateThresholdPerS: 100 })
  watch.observe(sampleAt(iso(T0), { pressure: 1, swapouts: 1000 }))
  const assessment = watch.observe(sampleAt(iso(T0 + 60_000), {
    pressure: 2,
    swapouts: 1000,
    rows: [{ pid: 37007, ppid: 26270, rssKb: 800 * 1024, command: RENDERER_CMD }],
  }))
  const notice = formatExcursionNotice(assessment)
  assert.match(notice, /\*\*box-memory: pressure 1->2\*\* \(still firing; opened /)
  assert.match(notice, /- pressure 1->2 at 2026-09-27T05:01:00\.000Z/)
  assert.match(notice, /- triple: 0 servers \/ 1 browsers \/ 0 orphans/)
  assert.match(notice, /- largest: 800MB pid 37007/)
  assert.match(notice, /Google Chrome for Testing Helper \(Renderer\)/)
})

// ---------------------------------------------------------------------------
// collectSample plumbing
// ---------------------------------------------------------------------------

test('collectSample runs sysctl, vm_stat and one ps read', () => {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'sysctl') return '1\n'
    if (cmd === 'vm_stat') return VM_STAT
    if (cmd === 'ps') return psTable([psLine(26270, 25716, 100000, MAIN_BROWSER_CMD)])
    throw new Error(`unexpected ${cmd}`)
  }
  const sample = collectSample({ run, now: () => iso(T0) })
  assert.equal(sample.pressure, 1)
  assert.equal(sample.swapouts, 568472210)
  assert.ok(sample.rows.some(row => row.pid === 26270))
  assert.deepEqual(calls, [
    'sysctl -n kern.memorystatus_vm_pressure_level',
    'vm_stat',
    'ps -Ao pid,ppid,rss,command',
  ])
})

test('collectSample turns spawn failures into setup errors, never zeros', () => {
  const boom = () => { throw new Error('spawn ENOENT') }
  assert.throws(() => collectSample({ run: boom }), BoxMemorySetupError)
})
