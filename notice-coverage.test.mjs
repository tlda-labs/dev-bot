import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const { composeFailureNudgeMessage, runChecks } = await import('./dev-bot.mjs')

test('failure notice reports this sweep, excluding skipped and incomplete checks from passed coverage', async () => {
  const report = await runChecks({ checks: [
    ['doc-load', async () => ({ bytes: 42 })],
    ['box-memory', async () => { throw new Error('pressure 2; sample retained') }],
    ['linked-remote-safety', async () => ({ skipped: true, reason: 'disabled' })],
    ['spawn-wake-seat', async () => ({ skipped: true, reason: 'cadence' })],
    ['notification-consumption', async () => ({ skipped: true, reason: 'previous probe still in flight' })],
    ['bot-heartbeats', async () => ({ blocked: true, reason: 'declared with no heartbeat instrument' })],
    ['doc-render', async () => ({ skipped: true, blocked: true, reason: 'render did not finish' })],
  ] })
  const before = structuredClone(report)
  const message = composeFailureNudgeMessage({ report, unchanged: false, fellBack: 'test route' })
  assert.ok(message.includes(report.summary), 'original failure details are preserved')
  assert.match(message, /_Delivery degraded: test route\._/)
  assert.match(message, /^Coverage in this sweep:$/m)
  assert.match(message, /^- Passed: doc-load$/m)
  assert.match(message, /^- Attempted and failed: box-memory$/m)
  assert.match(message, /^- Skipped: linked-remote-safety:disabled; spawn-wake-seat:cadence; notification-consumption:previous probe still in flight$/m)
  assert.match(message, /^- Blocked or incomplete: bot-heartbeats:declared with no heartbeat instrument; doc-render:render did not finish$/m)
  assert.ok(message.includes(`- Not run: ${report.missing.join('; ')}`))
  assert.ok(report.missing.includes('mcp-surface'), 'the omitted MCP check stays explicit')
  assert.doesNotMatch(message, /real MCP login|live notification consumption canaries/)
  assert.deepEqual(report, before, 'presentation must not change report or deduplication inputs')
})

test('an unchanged failure carries current coverage while keeping the compact failure body', async () => {
  const report = await runChecks({ checks: [
    ['mcp-surface', async () => { throw new Error('request refused\nprivate repeated detail') }],
    ['notification-consumption', async () => ({ family: 'codex' })],
  ] })
  const message = composeFailureNudgeMessage({
    report, unchanged: true, standingFor: 16, firstAt: Date.parse('2026-01-01T00:00:00Z'),
  })
  assert.match(message, /unchanged for 16 minutes/)
  assert.match(message, /Still failing: mcp-surface: request refused/)
  assert.doesNotMatch(message, /private repeated detail/)
  assert.match(message, /^- Passed: notification-consumption$/m)
  assert.match(message, /^- Attempted and failed: mcp-surface$/m)
})

test('emergency reports and summary-only reports do not invent coverage', () => {
  for (const report of [
    { ok: false, summary: 'dev-bot: sweep failed before a report', results: [] },
    { summary: 'dev-bot: no results supplied' },
  ]) {
    const message = composeFailureNudgeMessage({ report, unchanged: false })
    assert.ok(message.includes(report.summary))
    assert.ok(message.endsWith('Coverage in this sweep:\n- No check results were recorded.'))
    assert.doesNotMatch(message, /Passed:|Attempted and failed:|live notification consumption canaries/)
  }
})

test('a sweep with only skipped or blocked results claims no passed checks', async () => {
  const report = await runChecks({ checks: [
    ['linked-remote-safety', async () => ({ skipped: true, reason: 'disabled' })],
    ['bot-heartbeats', async () => ({ blocked: true })],
  ] })
  const message = composeFailureNudgeMessage({ report, unchanged: false })
  assert.match(message, /^- Passed: none$/m)
  assert.match(message, /^- Skipped: linked-remote-safety:disabled$/m)
  assert.match(message, /^- Blocked or incomplete: bot-heartbeats:blocked$/m)
  assert.doesNotMatch(message, /Attempted and failed:/)
})
