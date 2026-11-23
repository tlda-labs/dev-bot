import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import vm from 'node:vm'
import { createPlaywrightPoolCleanup, PW_RUNTIME_DIR, readPlaywrightLockOwner } from './resource-cleanup.mjs'

const execute = promisify(execFile)
const relativeLockScript = new URL('../../tlda/bin/pw-lock.sh', import.meta.url).pathname
const lockScript = existsSync(relativeLockScript)
  ? relativeLockScript
  : path.join(os.homedir(), 'work', 'tlda', 'bin', 'pw-lock.sh')

const busy = new Error('Command failed: tlda-dev pw sweep')
busy.stderr = `lock busy on session "shared-2" — test-owner (174s ago, pid ${process.pid} alive) holding; sweep skipped\n`

function cleaner(options = {}) {
  let clock = 1_000
  const calls = []
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'shared', capacity: 2, unhealthyIdleMs: 10,
    playwrightCli: 'playwright-cli', tldaDev: 'tlda-dev',
    now: () => clock,
    readLastTouch: async () => ({ known: true, at: null }),
    readLockOwner: async () => ({ known: true, live: false }),
    run: async (command, args, config) => {
      calls.push({ command, args, session: config?.env?.TLDA_PW_SESSION })
      if (command === 'playwright-cli') return { stdout: '- shared-2:\n  - status: open\n' }
      if (args[1] === 'sweep') throw busy
      return { stdout: '' }
    },
    ...options,
  })
  return { cleanup, calls, advance: ms => { clock += ms } }
}

test('busy session with a proved live lock remains active beyond the unhealthy threshold', async () => {
  let live = true
  const control = cleaner({ readLockOwner: async () => ({ known: true, live }) })
  assert.equal((await control.cleanup.sweep())[1].state, 'claimed')
  control.advance(600_000)
  assert.equal((await control.cleanup.sweep())[1].state, 'claimed')
  assert.equal(control.calls.some(call => call.args[1] === 'reap'), false)
  live = false
  // Live work must not leave an unhealthy clock running behind it.
  assert.equal((await control.cleanup.sweep())[1].idleMs, 0)
  control.advance(11)
  assert.deepEqual((await control.cleanup.sweep())[1], { session: 'shared-2', state: 'reaped', reason: 'persistently-unhealthy', idleMs: 11 })
  assert.equal(control.calls.filter(call => call.args[1] === 'reap').length, 1)
})

test('holder appearing during the last-touch read blocks the final unhealthy reap dispatch', async () => {
  let live = false
  const control = cleaner({
    readLockOwner: async () => ({ known: true, live }),
    readLastTouch: async () => { live = true; return { known: true, at: null } },
  })
  assert.equal((await control.cleanup.sweep())[1].state, 'error')
  control.advance(11)
  assert.equal((await control.cleanup.sweep())[1].state, 'claimed')
  assert.equal(control.calls.some(call => call.args[1] === 'reap'), false)
})

test('stale or absent owner still permits the existing unhealthy reap despite stale busy text', async () => {
  const control = cleaner()
  assert.equal((await control.cleanup.sweep())[1].state, 'error')
  control.advance(11)
  assert.equal((await control.cleanup.sweep())[1].state, 'reaped')
  assert.deepEqual(control.calls.filter(call => call.args[1] === 'reap').map(call => call.session), ['shared-2'])
})

test('unreadable final lock ownership preserves the browser', async () => {
  let unknown = false
  const control = cleaner({
    readLockOwner: async () => ({ known: !unknown, live: false }),
    readLastTouch: async () => { unknown = true; return { known: true, at: null } },
  })
  assert.equal((await control.cleanup.sweep())[1].state, 'error')
  control.advance(11)
  assert.match((await control.cleanup.sweep())[1].error, /ownership is unreadable/)
  assert.equal(control.calls.some(call => call.args[1] === 'reap'), false)
})

test('lock reader uses the canonical runtime path and proves PID liveness without signalling it', async () => {
  const files = []
  const read = async file => { files.push(file); return `fleet:owner\t1\t${process.pid}\n` }
  assert.deepEqual(await readPlaywrightLockOwner('shared-2', 'shared', read), { known: true, live: true, holder: 'fleet:owner', pid: process.pid })
  await readPlaywrightLockOwner('shared', 'shared', read)
  assert.deepEqual(files, [path.join(PW_RUNTIME_DIR, '.pw.shared-2.lock'), path.join(PW_RUNTIME_DIR, '.pw.lock')])
})

test('lock reader distinguishes absent, stale PID-zero and unreadable authority', async () => {
  assert.deepEqual(await readPlaywrightLockOwner('shared-2', 'shared', async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) }), { known: true, live: false })
  assert.deepEqual(await readPlaywrightLockOwner('shared-2', 'shared', async () => 'owner\t1\t0\n'), { known: true, live: false })
  assert.deepEqual(await readPlaywrightLockOwner('shared-2', 'shared', async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }) }), { known: false, live: false })
})

test('reader agrees with the real lock script for PID-zero expiry, configured stale interval, dead and live PIDs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cleanup-lock-contract-'))
  const file = path.join(dir, '.pw.lock')
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid
  const seconds = Math.floor(Date.now() / 1000)
  try {
    for (const [record, staleSeconds, active] of [
      [`owner\t${seconds}\t0\n`, 90, true],
      ['owner\t1\t0\n', 90, false],
      [`owner\t${seconds - 50}\n`, 120, true],
      [`owner\t${seconds - 50}\t0\n`, 30, false],
      [`owner\t${seconds}\t${deadPid}\n`, 90, false],
      [`owner\t1\t${process.pid}\n`, 90, true],
    ]) {
      await writeFile(file, record)
      const { stdout } = await execute('bash', [lockScript, 'status'], {
        env: { ...process.env, TLDA_PW_LOCK: file, TLDA_PW_LOCK_STALE: String(staleSeconds) },
      })
      const owner = await readPlaywrightLockOwner('test', 'test', () => readFile(file, 'utf8'), { staleSeconds })
      assert.equal(stdout.trim() !== 'unlocked', active, record)
      assert.equal(owner.live, active, record)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function actualLockControl(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cleanup-lock-dispatch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, '.pw.lock')
  let clock = 1000
  let reaps = 0
  let releases = 0
  let raced = false
  const state = { file, dir, get reaps() { return reaps }, get releases() { return releases } }
  const cleanup = createPlaywrightPoolCleanup({
    baseSession: 'test', capacity: 1, unhealthyIdleMs: 10, emptyIdleMs: 10,
    now: () => clock,
    lockPath: () => file,
    readLockOwner: () => readPlaywrightLockOwner('test', 'test', () => readFile(file, 'utf8')),
    readLastTouch: async () => ({ known: true, at: null }),
    playwrightCli: 'intercepted-playwright-cli', tldaDev: 'intercepted-tlda-dev',
    run: async (command, args, config) => {
      if (command === 'bash') {
        if (args[1] === 'acquire' && options.arriveBeforeAcquire && !raced) {
          raced = true
          await execute('bash', [lockScript, 'acquire', 'arriving-owner', '--pid', String(process.pid)], { env: config.env })
        }
        if (args[1] === 'release') {
          releases++
          if (options.releaseFails) throw new Error('intercepted release failure')
        }
        if (args[1] === 'acquire' && options.acquisitionFails) {
          const parent = path.join(dir, 'not-a-directory')
          await writeFile(parent, 'occupied')
          return execute(command, args, { ...config, env: { ...config.env, TLDA_PW_LOCK: path.join(parent, 'lock') } })
        }
        const result = await execute(command, args, config)
        if (args[1] === 'acquire' && options.acquisitionOutcomeFails) {
          throw Object.assign(new Error('acquisition completion was not observed'), { code: options.acquireErrorCode ?? null })
        }
        return result
      }
      if (command === 'intercepted-playwright-cli') return { stdout: '- test:\n  - status: open\n' }
      if (args[1] === 'sweep') {
        if (options.empty) return { stdout: '' }
        throw busy
      }
      assert.equal(args[1], 'reap')
      reaps++
      const held = await readFile(file, 'utf8')
      assert.match(held, /^dev-pool-cleanup:/)
      assert.equal(Number(held.trim().split('\t')[2]), process.pid)
      // A second real acquire must fail throughout destructive dispatch.
      await assert.rejects(execute('bash', [lockScript, 'acquire', 'contender', '--pid', String(process.pid)], { env: config.env }), error => error.code === 1)
      if (options.replaceAfterReap) await writeFile(file, `subsequent-owner\t1\t${process.pid}\n`)
      if (options.reapFails) throw new Error('intercepted destructive command failed')
      return { stdout: '' }
    },
  })
  state.sweep = () => cleanup.sweep()
  state.advance = () => { clock += 11 }
  return state
}

test('fresh PID-zero holder blocks actual cleaner dispatch and stale holder remains cleanable', async t => {
  const control = await actualLockControl(t)
  await writeFile(control.file, `owner\t${Math.floor(Date.now() / 1000)}\t0\n`)
  assert.equal((await control.sweep())[0].state, 'claimed')
  control.advance()
  assert.equal((await control.sweep())[0].state, 'claimed')
  assert.equal(control.reaps, 0)
  await writeFile(control.file, 'owner\t1\t0\n')
  assert.equal((await control.sweep())[0].state, 'error')
  control.advance()
  assert.equal((await control.sweep())[0].state, 'reaped')
  assert.equal(control.reaps, 1)
  await assert.rejects(readFile(control.file), { code: 'ENOENT' })
})

test('holder acquiring after the final read blocks automated reap without being released', async t => {
  const control = await actualLockControl(t, { arriveBeforeAcquire: true })
  await control.sweep()
  control.advance()
  const [result] = await control.sweep()
  assert.equal(result.state, 'error')
  assert.match(result.error, /LOCKED by arriving-owner/)
  assert.equal(control.reaps, 0)
  assert.equal(control.releases, 1)
  assert.match(await readFile(control.file, 'utf8'), /^arriving-owner\t/)
})

test('empty-session cleanup also holds the existing lock during destructive dispatch', async t => {
  const control = await actualLockControl(t, { empty: true })
  await control.sweep()
  control.advance()
  assert.equal((await control.sweep())[0].state, 'reaped')
  assert.equal(control.reaps, 1)
  assert.equal(control.releases, 1)
})

test('failed acquisition preserves the session without dispatch and safely attempts own release', async t => {
  const control = await actualLockControl(t, { acquisitionFails: true })
  await control.sweep()
  control.advance()
  assert.match((await control.sweep())[0].error, /could not acquire cleanup lock/)
  assert.equal(control.reaps, 0)
  assert.equal(control.releases, 1)
})

test('unsuccessful acquire completion releases an already-written own claim regardless of error code', async t => {
  for (const acquireErrorCode of [null, 1, 3]) {
    const control = await actualLockControl(t, { acquisitionOutcomeFails: true, acquireErrorCode })
    await control.sweep()
    control.advance()
    const [result] = await control.sweep()
    assert.match(result.error, /acquisition completion was not observed/)
    assert.equal(control.reaps, 0)
    assert.equal(control.releases, 1)
    await assert.rejects(readFile(control.file), { code: 'ENOENT' })
    // Positive control: the failed attempt must not leave the pool reserved.
    const { stdout } = await execute('bash', [lockScript, 'acquire', 'later-owner', '--pid', String(process.pid)], {
      env: { ...process.env, TLDA_PW_LOCK: control.file },
    })
    assert.match(stdout, /acquired by later-owner/)
  }
})

test('unsuccessful acquire completion retains its error together with an own-release failure', async t => {
  const control = await actualLockControl(t, { acquisitionOutcomeFails: true, releaseFails: true })
  await control.sweep()
  control.advance()
  const [result] = await control.sweep()
  assert.match(result.error, /acquisition completion was not observed/)
  assert.match(result.error, /cleanup lock release failed: intercepted release failure/)
  assert.equal(control.reaps, 0)
  assert.equal(control.releases, 1)
})

test('actual caller reports acquire and release failures through the existing error-state contract', async t => {
  const entry = await readFile(new URL('./dev-bot.mjs', import.meta.url), 'utf8')
  const start = entry.indexOf('export async function checkResourceCleanup(')
  const end = entry.indexOf('export const DISABLED_CHECKS', start)
  assert.ok(start >= 0 && end > start)
  // Evaluate the real existing caller without importing or starting the bot.
  const check = vm.runInNewContext(entry.slice(start, end).replace(/^export /, '') + '\ncheckResourceCleanup', {
    resourceCleanupRun: null, lastWorktreeCleanupAt: 0, WORKTREE_CLEANUP_INTERVAL_MS: 60000,
  })
  const invoke = sweep => check({
    previewReaper: () => ({ reaped: [], failed: [] }),
    playwrightCleanup: { sweep }, worktreeCleanupDriver: {}, now: () => 0,
  })
  for (const empty of [false, true]) {
    const control = await actualLockControl(t, { empty, acquisitionOutcomeFails: true, acquireErrorCode: 1, releaseFails: true })
    await control.sweep()
    control.advance()
    let rows
    await assert.rejects(invoke(async () => { rows = await control.sweep(); return rows }), error => {
      assert.match(error.message, /acquisition completion was not observed/)
      assert.match(error.message, /cleanup lock release failed: intercepted release failure/)
      return true
    })
    assert.equal(control.reaps, 0)
    assert.equal(control.releases, 1)
    assert.equal(rows[0].state, 'error', empty ? 'empty path' : 'unhealthy path')
    // Positive control of the unchanged caller's existing error-state contract.
    await assert.rejects(invoke(async () => rows.map(row => ({ ...row, state: 'error' }))), error => {
      assert.match(error.message, /acquisition completion was not observed/)
      assert.match(error.message, /intercepted release failure/)
      return true
    })
    // Counterfactual: the rejected claimed+error mapping silently loses the error.
    const lostError = await invoke(async () => rows.map(row => ({ ...row, state: 'claimed' })))
    assert.equal(Object.hasOwn(lostError.playwright[0], 'error'), false)
  }
  const healthyClaim = await invoke(async () => [{ session: 'test', state: 'claimed' }])
  assert.equal(healthyClaim.playwright[0].state, 'claimed')
})

test('failed destructive dispatch releases the cleaner claim', async t => {
  const control = await actualLockControl(t, { reapFails: true })
  await control.sweep()
  control.advance()
  assert.match((await control.sweep())[0].error, /intercepted destructive command failed/)
  assert.equal(control.releases, 1)
  await assert.rejects(readFile(control.file), { code: 'ENOENT' })
})

test('cleaner release never removes a subsequent owner claim', async t => {
  const control = await actualLockControl(t, { replaceAfterReap: true })
  await control.sweep()
  control.advance()
  assert.match((await control.sweep())[0].error, /cleanup lock release failed/)
  assert.equal(control.releases, 1)
  assert.match(await readFile(control.file, 'utf8'), /^subsequent-owner\t/)
})
