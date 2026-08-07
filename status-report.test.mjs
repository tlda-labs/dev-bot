import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

process.env.TLDA_DEV_BOT_NO_START = '1'
const { configSchema, publishStatus, renderStatusMarkdown } = await import('./dev-bot.mjs')

test('linked remote safety probe is explicit opt-in', () => {
  assert.equal(configSchema.fields.linkedRemoteEnabled.default, false)
  assert.equal(configSchema.fields.linkedRemoteEnabled.env, 'TLDA_DEV_BOT_LINKED_REMOTE_ENABLED')
  assert.equal(configSchema.fields.linkedRemoteUrl.default, '')
  assert.equal(configSchema.fields.linkedRemoteUrl.env, 'TLDA_DEV_BOT_LINKED_REMOTE_URL')
  assert.equal(configSchema.fields.linkedRemoteTokenFile.default, '')
  assert.equal(configSchema.fields.linkedRemoteTokenFile.env, 'TLDA_DEV_BOT_LINKED_REMOTE_TOKEN_FILE')
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
  assert.match(report, /^# Dev bot disk and worktree status \{\.volatile\}/)
})

test('status publication uses the info project source pipeline and exposes failure', async () => {
  let request
  const transport = {
    sendAndWait: async message => {
      request = message
      return { ok: true }
    },
  }
  assert.match(await publishStatus({ transport, samples: [] }), /^\[Dev bot disk and worktree status\]\(\/docs\/info\//)
  assert.equal(request.type, 'source-change')
  assert.equal(request.project, 'info')
  assert.equal(request.files[0].path, 'dev-bot-status.md')
  assert.match(request.files[0].content, /\{\.volatile\}/)

  await assert.rejects(
    publishStatus({ transport: { sendAndWait: async () => ({ ok: false, error: 'refused' }) }, samples: [] }),
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
