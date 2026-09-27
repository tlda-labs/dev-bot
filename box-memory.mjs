/**
 * box-memory — Mini memory-pressure watchdog sampler for the dev bot.
 *
 * Customer: ops-oncall, from a night of sampling the box by hand (2026-09-26).
 * Spec amendment: the chief (2026-09-27) — the climber leg.
 *
 * One sample per sweep carries four signals:
 *  1. swapout rate over a trailing window (counter differenced here, never level)
 *  2. top-N RSS by FULL command line, each pid with its delta since last read
 *  3. memory-pressure level plus the timestamp of its last transition
 *  4. the playwright triple in one `ps` read: MCP servers / browsers / ppid-1 orphans
 *
 * The watch opens an excursion (check fails, on-call nudged) on three legs:
 *  pressure  — the level moved to a numerically higher value (worsening);
 *  swap      — the trailing-window rate crossed above threshold from below;
 *  climber   — a chromium pid's growth RATE over the trailing K samples is
 *              at or above ~850MB/min (the measured 21:31 shape: 727MB->4267MB),
 *              and it is still growing on the latest sample. Rate, never level:
 *              36 steady browsers at 72MB mean are a healthy fleet, and one
 *              renderer at 4.3GB is the whole incident.
 * The excursion closes when every open leg closes. No leg acts on anything:
 * report the transition with evidence, never act on it.
 *
 * INSTRUMENT CONTRACTS (measures / cannot-see / zero-meaning). Each was
 * verified against the live box before it was allowed to feed the alert.
 *
 *  vm_stat Swapouts
 *    Measures: cumulative pages paged out since boot (Mach VM statistics).
 *    Cannot see: memory compressed but not yet paged out; which process paged;
 *      anything about the current instant — it is a counter, only the delta
 *      over a window means anything.
 *    Zero delta: no paging in the window — healthy — PROVIDED vm_stat ran
 *      cleanly and both the page-size header and the Swapouts line parsed.
 *      A zero from a failed or unparsed read is a setup error, never a rate.
 *
 *  sysctl kern.memorystatus_vm_pressure_level
 *    Measures: the kernel's own pressure verdict as an opaque integer.
 *      Observed: 1 while calm, 1->2 on the 01:00 paging puff, back to 1 after.
 *    Cannot see: what is causing the pressure; excursions shorter than the
 *      sweep interval; absolute meaning of values never observed.
 *    Unchanged: steady state. Only transitions fire, so an elevation that
 *      predates the watch is adopted as the settled level, silently.
 *
 *  ps top-N by full command line
 *    Measures: per-process RSS at the sample instant, ranked by full command.
 *    Cannot see: processes that exited before the sample; shared pages counted
 *      once per process; spikes between samples.
 *    Zero delta: pid stable since last read. Rank is NEVER by process name:
 *      ranking by name put a renderer climbing 727MB->4267MB below pandoc.
 *
 *  ps triple (servers / browsers / orphans, one read)
 *    Measures: one process-table snapshot classified in-process.
 *      servers  = lines whose argv runs node with @playwright/mcp/cli.js as the
 *                 script (NOT substring: agent --settings JSON and grep shells
 *                 merely mention the path);
 *      browsers = EVERY line whose executable (before the first ` --` flag) is
 *                 inside the Google Chrome for Testing bundle: mains, renderers,
 *                 helpers. Main-process-only undercounts (read 2 against 51
 *                 live procs): the leg tracks the population, which is what
 *                 grows with walks;
 *      orphans  = servers reparented to launchd (ppid 1).
 *    Cannot see: servers/browsers that exited before the sample; server health
 *      (a listed server is liveness, not health); the pooled cliDaemon, which
 *      is deliberately NOT in this population — it sits at ppid 1 daemonized
 *      by design with a live child browser, so counting it as an orphan would
 *      false-positive every sweep. Daemon/browser hygiene belongs to the dev
 *      reaper (resource-cleanup.mjs + `tlda-dev pw reap`), which already owns
 *      it; this watch only reports the population the reaper acts beside.
 *    Zero: none of that population observed — real only when the `ps` table
 *      itself is full (fewer than MIN_PS_LINES rows is a setup error, because
 *      an empty table means the instrument failed, not an empty box).
 *
 * Counting is in-process over one `ps -Ao pid,ppid,rss,command` snapshot.
 * There is deliberately no pgrep here: macOS pgrep has no -c flag, so
 * `pgrep -fc <pattern>` exits with a usage error that reads as a zero count.
 * There is deliberately no `ps | grep` here either: the grep process matches
 * its own pattern (measured: it inflated a 1-server table to 3), while an
 * in-process classifier cannot match itself.
 */

export const MIN_PS_LINES = 10
export const CHROME_APP_MARK = 'Google Chrome for Testing.app/'
export const MCP_SERVER_SCRIPT = '@playwright/mcp/cli.js'

export class BoxMemorySetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BoxMemorySetupError'
  }
}

function fail(what, detail) {
  throw new BoxMemorySetupError(`${what}: ${detail}`)
}

/**
 * Parse `vm_stat` output. Requires the page-size header AND the Swapouts line:
 * a rate built on a half-parsed read is the broken-instrument zero.
 */
export function parseVmStat(output) {
  const text = String(output || '')
  const pageSize = text.match(/page size of (\d+) bytes/)
  const swapouts = text.match(/^Swapouts:\s+([\d,]+)\.?/m)
  if (!pageSize) fail('vm_stat unreadable', 'no "page size of N bytes" header')
  if (!swapouts) fail('vm_stat unreadable', 'no "Swapouts:" line')
  const swapins = text.match(/^Swapins:\s+([\d,]+)\.?/m)
  return {
    pageSizeBytes: Number(pageSize[1]),
    swapouts: Number(swapouts[1].replaceAll(',', '')),
    swapins: swapins ? Number(swapins[1].replaceAll(',', '')) : null,
  }
}

/**
 * Parse `sysctl -n kern.memorystatus_vm_pressure_level` output. The level is
 * an opaque integer: any change is a transition, no value is special-cased.
 */
export function parsePressureLevel(output) {
  const text = String(output || '').trim()
  if (!/^\d+$/.test(text)) fail('pressure level unreadable', JSON.stringify(text.slice(0, 80)))
  return Number(text)
}

/**
 * Parse `ps -Ao pid,ppid,rss,command` output into rows. The header line is
 * skipped by shape (first two fields must be integers), not by position.
 */
export function parsePsTable(output, { minLines = MIN_PS_LINES } = {}) {
  const rows = []
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] })
  }
  if (rows.length < minLines) {
    fail('ps table unreadable', `only ${rows.length} data rows (minimum ${minLines}) — the instrument failed, the box is not empty`)
  }
  return rows
}

/** Index of the first ` --` flag token, i.e. where argv[0] ends. -1 if none. */
function firstFlagIndex(command) {
  return String(command || '').indexOf(' --')
}

/**
 * True when the line EXECUTES the Playwright MCP stdio server: argv[0] is node
 * and one of the argument tokens is the server script. Substring matching
 * over-counts: agent command lines embed the path in --settings JSON and shells
 * embed it in grep patterns, and neither is a server.
 */
export function isMcpServer(command) {
  const tokens = String(command || '').split(/\s+/)
  if (!/(^|\/)node$/.test(tokens[0] || '')) return false
  return tokens.slice(1).some(token => token === MCP_SERVER_SCRIPT || token.endsWith(`/${MCP_SERVER_SCRIPT}`))
}

/**
 * True when the line's executable — the part before the first ` --` flag — is
 * inside the Chrome-for-Testing app bundle. The before-flags rule is what
 * excludes MCP servers, which carry the browser path in --executable-path.
 */
export function isChromiumProcess(command) {
  const text = String(command || '')
  const markAt = text.indexOf(CHROME_APP_MARK)
  if (markAt < 0) return false
  const flagAt = firstFlagIndex(text)
  return flagAt < 0 || markAt < flagAt
}

/**
 * The triple, classified from ONE ps snapshot. Returns the classified rows
 * (pid/ppid/command) so callers can name names, not just counts.
 *
 * The browser leg counts the whole population, not main processes: the count
 * is what tracks walks, and main-only read 2 against 51 live procs.
 */
export function classifyTriple(rows) {
  const servers = []
  const browsers = []
  for (const row of rows) {
    if (isMcpServer(row.command)) servers.push({ pid: row.pid, ppid: row.ppid, command: row.command })
    else if (isChromiumProcess(row.command)) browsers.push({ pid: row.pid, ppid: row.ppid, command: row.command })
  }
  // Orphans are servers reparented to launchd. An MCP server is spawned by and
  // serves one agent process, so ppid 1 means the agent is gone and the server
  // leaked. The pooled cliDaemon also sits at ppid 1, but it is not in this
  // population at all (see the header contract): daemonized by design.
  const orphans = servers.filter(server => server.ppid === 1)
  return { servers, browsers, orphans }
}

/**
 * True for a chromium renderer process: a chromium executable carrying
 * --type=renderer. This is the ONLY population the reaper may act on: the
 * authorised action is reaping a climbing renderer, and a climbing main
 * browser must alert but never be reaped (killing it takes the whole pooled
 * browser and every tab with it).
 */
export function isRendererProcess(command) {
  return isChromiumProcess(command) && String(command || '').includes('--type=renderer')
}

export function topByRss(rows, count) {
  return [...rows]
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, Math.max(0, count))
    .map(row => ({ pid: row.pid, rssKb: row.rssKb, command: row.command }))
}

/**
 * Take one sample. Three cheap spawns: sysctl (pressure), vm_stat (counters),
 * ps (triple + top-N share the single table). `run` is injectable for tests.
 */
export function collectSample({ run, now = () => new Date().toISOString() } = {}) {
  if (typeof run !== 'function') fail('box-memory misconfigured', 'no process runner supplied')
  let pressureRaw
  let vmStatRaw
  let psRaw
  try {
    pressureRaw = run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])
  } catch (error) {
    fail('pressure read failed', error?.message || String(error))
  }
  try {
    vmStatRaw = run('vm_stat', [])
  } catch (error) {
    fail('vm_stat failed', error?.message || String(error))
  }
  try {
    psRaw = run('ps', ['-Ao', 'pid,ppid,rss,command'])
  } catch (error) {
    fail('ps snapshot failed', error?.message || String(error))
  }
  const pressure = parsePressureLevel(pressureRaw)
  const { pageSizeBytes, swapouts, swapins } = parseVmStat(vmStatRaw)
  const rows = parsePsTable(psRaw)
  return { ts: now(), pressure, pageSizeBytes, swapouts, swapins, rows }
}

/**
 * Stateful excursion watch. All trip state is process-local and resets on
 * restart, like the dev bot's other watches (cooldowns, empty-since maps).
 *
 *  swapoutWindowMs          trailing window for the swapout rate
 *  swapoutRateThresholdPerS rate at or above this is "paging"
 *  topN                     top-N entries carried per sample
 *  climbSamples             trailing readings per pid for the climber leg
 *  climbRateMbPerMin        growth rate over climbSamples that trips a climber
 */
export function createBoxMemoryWatch({
  swapoutWindowMs = 600_000,
  swapoutRateThresholdPerS = 100,
  topN = 5,
  climbSamples = 3,
  climbRateMbPerMin = 850,
} = {}) {
  let previous = null
  let previousRatePerS = null
  let settledLevel = null
  let swapHistory = []
  const rssHistory = new Map()
  let excursion = null

  function swapRate(nowMs) {
    const cutoff = nowMs - swapoutWindowMs
    swapHistory = swapHistory.filter(point => point.at >= cutoff)
    if (swapHistory.length < 2) return { ratePerS: null, windowS: null }
    const first = swapHistory[0]
    const last = swapHistory[swapHistory.length - 1]
    const spanS = (last.at - first.at) / 1000
    if (!(spanS > 0)) return { ratePerS: null, windowS: null }
    // The counter is cumulative since boot; a backwards step is a reboot or a
    // wrapped read, not negative paging. Clamp, do not report.
    const delta = Math.max(0, last.swapouts - first.swapouts)
    return { ratePerS: delta / spanS, windowS: spanS }
  }

  function climbers() {
    const tripped = []
    for (const [pid, readings] of rssHistory) {
      if (readings.length < climbSamples) continue
      const window = readings.slice(-climbSamples)
      const first = window[0]
      const last = window[window.length - 1]
      const prev = window[window.length - 2]
      const spanMin = (last.at - first.at) / 60_000
      // No rate exists over zero time. Samples arriving with identical
      // timestamps cannot trip, however large the growth reads.
      if (!(spanMin > 0)) continue
      const growthKb = last.rssKb - first.rssKb
      const latestDeltaKb = last.rssKb - prev.rssKb
      const rateMbPerMin = growthKb / 1024 / spanMin
      // Net growth over the window plus still-growing-now. Strict monotonicity
      // is NOT required: one GC dip in a +3GB climb is still a climb, and a
      // sawtooth swinging gigabytes is pathological enough to name.
      if (rateMbPerMin >= climbRateMbPerMin && latestDeltaKb > 0) {
        tripped.push({ pid, rssKb: last.rssKb, growthKb, rateMbPerMin, spanMin, latestDeltaKb, command: last.command })
      }
    }
    tripped.sort((a, b) => b.rateMbPerMin - a.rateMbPerMin)
    return tripped
  }

  function observe(sample) {
    const nowMs = Date.parse(sample.ts)
    if (!Number.isFinite(nowMs)) fail('box-memory misconfigured', `sample ts ${JSON.stringify(sample.ts)} is not a timestamp`)
    const triple = classifyTriple(sample.rows)
    const top = topByRss(sample.rows, topN).map(entry => {
      const last = previous?.byPid.get(entry.pid)
      return {
        pid: entry.pid,
        rssKb: entry.rssKb,
        deltaKb: last ? entry.rssKb - last.rssKb : null,
        command: entry.command,
      }
    })

    if (settledLevel === null) settledLevel = sample.pressure
    swapHistory.push({ at: nowMs, swapouts: sample.swapouts })
    const { ratePerS, windowS } = swapRate(nowMs)

    // Per-pid RSS rings for the climber leg. A pid missing from this sample
    // loses its streak: growth must be consecutive to trip.
    const seen = new Set()
    for (const row of sample.rows) {
      if (!isChromiumProcess(row.command)) continue
      seen.add(row.pid)
      const ring = rssHistory.get(row.pid) || []
      ring.push({ at: nowMs, rssKb: row.rssKb, command: row.command })
      rssHistory.set(row.pid, ring.slice(-climbSamples))
    }
    for (const pid of [...rssHistory.keys()]) {
      if (!seen.has(pid)) rssHistory.delete(pid)
    }

    const events = []
    const transitions = excursion ? [...excursion.transitions] : []
    const changed = previous !== null && sample.pressure !== previous.sample.pressure

    // Pressure leg: worsening opens, return-to-settled closes. An improving
    // transition with no excursion open is a calmer box than the watch has
    // seen (e.g. restart into pressure 2, now back at 1): adopt it as the new
    // settled level silently rather than alerting on a recovery nobody raised.
    let pressureLeg = excursion?.legs.pressure || null
    if (changed) {
      const transition = { from: previous.sample.pressure, to: sample.pressure, at: sample.ts }
      transitions.push(transition)
      events.push(`pressure ${transition.from}->${transition.to}`)
      if (sample.pressure > previous.sample.pressure) {
        pressureLeg = { ...transition }
      } else if (pressureLeg && sample.pressure <= settledLevel) {
        pressureLeg = null
      } else if (!excursion) {
        settledLevel = sample.pressure
      }
    }

    // Swap leg: resumption edge opens, below-threshold closes. A null previous
    // rate (second sample ever, or first windowed rate) counts as "from below",
    // so restarting into active paging fires on the second sample.
    let swapLeg = excursion?.legs.swap || null
    if (ratePerS !== null) {
      const resumed = ratePerS >= swapoutRateThresholdPerS && (previousRatePerS === null || previousRatePerS < swapoutRateThresholdPerS)
      if (resumed) {
        swapLeg = { ratePerS, windowS, thresholdPerS: swapoutRateThresholdPerS, at: sample.ts }
        events.push('swapout-rate resumed')
      } else if (swapLeg && ratePerS < swapoutRateThresholdPerS) {
        swapLeg = null
      } else if (swapLeg) {
        swapLeg = { ...swapLeg, ratePerS, windowS }
      }
    }

    // Climber leg: any chromium pid tripping holds it open; none tripping
    // closes it. Browsers are the subject, not agents: agent RSS growth is
    // carried in top-N with deltas but never trips.
    const tripped = climbers()
    let climberLeg = excursion?.legs.climber || null
    if (tripped.length) {
      if (!climberLeg) events.push(`climber pid ${tripped[0].pid}`)
      climberLeg = { pids: tripped.map(entry => entry.pid) }
    } else {
      climberLeg = null
    }

    const legs = { pressure: pressureLeg, swap: swapLeg, climber: climberLeg }
    const open = Boolean(pressureLeg || swapLeg || climberLeg)
    if (open && !excursion) {
      excursion = { openedAt: sample.ts, legs, transitions }
      events.push('excursion opened')
    } else if (open) {
      excursion = { ...excursion, legs, transitions }
    } else if (excursion) {
      events.push('excursion closed')
      excursion = null
      settledLevel = sample.pressure
    }

    const assessment = {
      sample,
      triple: {
        servers: triple.servers.length,
        browsers: triple.browsers.length,
        orphans: triple.orphans.length,
        serverPids: triple.servers.map(entry => entry.pid),
        browserPids: triple.browsers.map(entry => entry.pid),
        orphanPids: triple.orphans.map(entry => entry.pid),
      },
      top,
      largest: top[0] || null,
      pressure: { level: sample.pressure, settledLevel, changed },
      swap: { ratePerS, windowS, thresholdPerS: swapoutRateThresholdPerS },
      climbers: tripped,
      excursion,
      events,
    }
    previousRatePerS = ratePerS
    previous = { sample, byPid: new Map(sample.rows.map(row => [row.pid, row])) }
    return assessment
  }

  return { observe }
}

function formatMb(kb) {
  return `${Math.round(kb / 1024)}MB`
}

function formatDelta(kb) {
  if (kb === null || kb === undefined) return 'n/a'
  const sign = kb > 0 ? '+' : ''
  return `${sign}${Math.round(kb / 1024)}MB`
}

function truncateCommand(command, length) {
  const text = String(command || '')
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/**
 * Render the excursion as the check's failure text. Nudge-key stability (see
 * keyForFailureSubject in dev-bot.mjs: digits and backticked spans collapse,
 * only `- ` lines enter the key):
 *  - the bold headline names the open legs, so legs joining or leaving
 *    re-notify while a standing excursion stays one finding;
 *  - `- ` lines carry key-stable facts only (identities normalize away);
 *  - volatile per-sweep detail (top-N table, full commands) rides on plain
 *    continuation lines, which never enter the key — a shuffling top-5 must
 *    not re-notify every sweep.
 */
export function formatExcursionNotice(assessment) {
  const { excursion, sample, triple, top, largest, swap } = assessment
  const legWords = []
  if (excursion.legs.pressure) legWords.push(`pressure ${excursion.legs.pressure.from}->${excursion.legs.pressure.to}`)
  if (excursion.legs.swap) legWords.push('swapout-rate')
  if (excursion.legs.climber) legWords.push(excursion.legs.climber.pids.length === 1 ? `climber pid ${excursion.legs.climber.pids[0]}` : `climbers ${excursion.legs.climber.pids.join(', ')}`)
  const lines = [`**box-memory: ${legWords.join(' + ')}** (still firing; opened ${excursion.openedAt})`]
  for (const leg of ['pressure', 'swap', 'climber']) {
    const entry = excursion.legs[leg]
    if (!entry) continue
    if (leg === 'pressure') {
      lines.push(`- pressure ${entry.from}->${entry.to} at ${entry.at} (settled ${assessment.pressure.settledLevel})`)
    } else if (leg === 'swap') {
      const rate = entry.ratePerS
      lines.push(`- swapout rate ${rate === null ? 'n/a' : `${Math.round(rate)} pages/s`} over trailing ${entry.windowS === null ? 'n/a' : `${Math.round(entry.windowS)}s`} (threshold ${entry.thresholdPerS}/s)`)
    } else {
      for (const pid of entry.pids) {
        const detail = assessment.climbers.find(entry => entry.pid === pid)
        if (detail) {
          lines.push(`- climber pid ${pid}: +${formatMb(detail.growthKb)} over ${Math.round(detail.spanMin * 60)}s (${Math.round(detail.rateMbPerMin)}MB/min), latest ${formatDelta(detail.latestDeltaKb)}`)
          lines.push(`  ${truncateCommand(detail.command, 300)}`)
        } else {
          lines.push(`- climber pid ${pid}: tripping (detail aged out of the trailing window)`)
        }
      }
    }
  }
  lines.push(`- triple: ${triple.servers} servers / ${triple.browsers} browsers / ${triple.orphans} orphans`)
  if (triple.orphanPids.length) lines.push(`  orphan pids: ${triple.orphanPids.join(', ')}`)
  if (largest) {
    lines.push(`- largest: ${formatMb(largest.rssKb)} pid ${largest.pid} (${formatDelta(largest.deltaKb)} since last read)`)
    lines.push(`  ${truncateCommand(largest.command, 300)}`)
  }
  lines.push(`- sample ${sample.ts}; pressure ${sample.pressure} (settled ${assessment.pressure.settledLevel}); swapout rate ${swap.ratePerS === null ? 'n/a' : `${Math.round(swap.ratePerS)} pages/s`} over trailing ${swap.windowS === null ? 'n/a' : `${Math.round(swap.windowS)}s`}`)
  for (const entry of top) {
    lines.push(`  ${formatMb(entry.rssKb)} pid${entry.pid} ${formatDelta(entry.deltaKb)} — ${truncateCommand(entry.command, 120)}`)
  }
  return lines.join('\n')
}
