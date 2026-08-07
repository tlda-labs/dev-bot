import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFile = promisify(execFileCb)

export async function runLinkedRemoteProbe({ driver }) {
  const preconditions = await driver.establish()
  await driver.proveRemoteToTlda(preconditions)
  await driver.proveTldaToRemote(preconditions)

  const divergent = await driver.createDivergence(preconditions)
  const observed = await driver.observeDivergence(divergent)
  if (observed.acceptedRevision !== divergent.acceptedRevision) {
    throw new Error(`divergent edits changed accepted authority (${divergent.acceptedRevision} -> ${observed.acceptedRevision})`)
  }
  if (observed.remoteHead !== divergent.remoteHead) {
    throw new Error(`divergent edits overwrote the remote head (${divergent.remoteHead} -> ${observed.remoteHead})`)
  }
  if (!observed.conflictVisible) {
    throw new Error('divergent edits did not visibly surface a conflict')
  }

  await driver.proveRestartConvergence({ ...preconditions, ...divergent, ...observed })
  return { ok: true, preconditions, divergent, observed }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check, { timeoutMs = 60_000, intervalMs = 500, description }) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(`${description} did not converge${lastError ? `: ${lastError.message}` : ''}`)
}

async function git(cwd, ...args) {
  const result = await execFile('git', args, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 })
  return result.stdout.trim()
}

async function portIsOpen(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    const finish = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function encodedProjectPath(project, suffix = '') {
  return `/api/projects/${encodeURIComponent(project)}${suffix}`
}

export async function createGitRemoteProbeDriver({
  storeServer,
  fixtureRoot,
  project = 'dev-linked-remote-probe',
  remoteHost,
  remotePort = 19418,
  restart,
  requestTimeoutMs = 15_000,
} = {}) {
  if (!storeServer) throw new Error('linked remote probe requires storeServer')
  if (!fixtureRoot) throw new Error('linked remote probe requires fixtureRoot')
  if (!restart) throw new Error('linked remote probe requires a configured testing server restart hook')

  if (!remoteHost) {
    remoteHost = (await execFile('tailscale', ['ip', '-4'], { timeout: 5000 })).stdout.trim().split(/\s+/)[0]
  }
  if (!remoteHost) throw new Error('linked remote probe could not determine a tailnet address')

  fs.mkdirSync(fixtureRoot, { recursive: true })
  const bare = path.join(fixtureRoot, 'remote.git')
  const work = path.join(fixtureRoot, 'remote-work')
  if (!fs.existsSync(path.join(bare, 'HEAD'))) {
    await git(fixtureRoot, 'init', '--bare', '--initial-branch=main', bare)
  }
  if (!fs.existsSync(path.join(work, '.git'))) {
    await git(fixtureRoot, 'clone', bare, work)
    await git(work, 'config', 'user.name', 'tlda dev bot')
    await git(work, 'config', 'user.email', 'dev-bot@tlda.local')
  }

  let daemon = null
  if (!await portIsOpen(remoteHost, remotePort)) {
    daemon = spawn('git', [
      'daemon', '--reuseaddr', '--export-all', '--enable=receive-pack',
      `--base-path=${fixtureRoot}`, `--listen=${remoteHost}`, `--port=${remotePort}`,
      fixtureRoot,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    await waitUntil(() => portIsOpen(remoteHost, remotePort), {
      timeoutMs: 5000,
      description: 'disposable Git remote',
    })
  }

  const remoteUrl = `git://${remoteHost}:${remotePort}/remote.git`
  const mainFile = 'main.md'
  const api = async (suffix, options = {}, okStatuses = []) => {
    const response = await fetch(`${storeServer}${encodedProjectPath(project, suffix)}`, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    const text = await response.text()
    let body
    try { body = text ? JSON.parse(text) : {} } catch { body = text }
    if (!response.ok && !okStatuses.includes(response.status)) {
      throw new Error(`${options.method || 'GET'} ${suffix || '/'} returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    }
    return { status: response.status, body, headers: response.headers }
  }
  const source = async () => {
    const response = await fetch(`${storeServer}${encodedProjectPath(project, `/source/${mainFile}`)}`, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok) throw new Error(`source read returned HTTP ${response.status}`)
    return { content: await response.text(), revision: response.headers.get('x-tlda-source-revision') }
  }
  const authority = async () => (await api('/source-authority')).body
  const projectRecord = async () => (await api('')).body
  const commitRemote = async content => {
    await git(work, 'fetch', 'origin')
    const hasHead = await git(bare, 'rev-parse', '--verify', 'refs/heads/main').then(() => true, () => false)
    if (hasHead) await git(work, 'reset', '--hard', 'origin/main')
    fs.writeFileSync(path.join(work, mainFile), content)
    await git(work, 'add', mainFile)
    await git(work, 'commit', '-m', `dev probe ${randomUUID()}`)
    await git(work, 'push', 'origin', 'HEAD:main')
    return git(work, 'rev-parse', 'HEAD')
  }
  const remoteHead = async () => git(bare, 'rev-parse', 'refs/heads/main')
  const remoteCount = async () => Number(await git(bare, 'rev-list', '--count', 'refs/heads/main'))
  const remoteContent = async () => git(bare, 'show', `refs/heads/main:${mainFile}`)
  const sync = async () => api('/overleaf-sync', { method: 'POST', body: '{}' })
  const exactSourceRenderHistory = async expected => {
    await waitUntil(async () => (await source()).content === expected, { description: 'exact tlda source' })
    await waitUntil(async () => {
      const response = await fetch(`${storeServer}/docs/${encodeURIComponent(project)}/${mainFile.replace(/\.md$/i, '.html')}?t=${Date.now()}`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      return response.ok && (await response.text()).includes(expected.trim())
    }, { timeoutMs: 120_000, description: 'exact rendered document' })
    await waitUntil(async () => {
      const versions = (await api('/history/shadow?limit=10')).body?.versions || []
      if (!versions[0]?.hash) return false
      const response = await fetch(`${storeServer}${encodedProjectPath(project, `/history/shadow/source?version=${versions[0].hash}&file=${mainFile}`)}`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      return response.ok && await response.text() === expected
    }, { description: 'exact shadow history' })
  }
  const tldaEdit = async (content, expectedRevision) => api(`/source/${mainFile}`, {
    method: 'PUT',
    body: JSON.stringify({ content, sourceManifest: [mainFile], editedBy: 'fleet:dev', expectedRevision }),
  }, [400, 409, 412, 428, 500])

  return {
    async establish() {
      const initial = `# Linked remote probe\n\nBASE ${randomUUID()}\n`
      if (!await git(bare, 'rev-parse', '--verify', 'refs/heads/main').then(() => true, () => false)) {
        await commitRemote(initial)
      }
      const current = await api('', {}, [404])
      if (current.status === 404 || !current.body?.overleafRemote) {
        await api('/link', {
          method: 'POST',
          body: JSON.stringify({ source: remoteUrl, mainFile, format: 'markdown', pollSeconds: 15 }),
        })
      } else if (current.body?.overleafRemote !== remoteUrl) {
        throw new Error(`probe project is linked to ${current.body?.overleafRemote || 'no remote'}, expected ${remoteUrl}`)
      }
      const baseContent = `# Linked remote probe\n\nBASE ${randomUUID()}\n`
      await commitRemote(baseContent)
      await sync()
      await exactSourceRenderHistory(baseContent)
      return { baseRevision: (await authority()).currentRevision, baseContent }
    },

    async proveRemoteToTlda() {
      const content = `# Linked remote probe\n\nREMOTE ${randomUUID()}\n`
      await commitRemote(content)
      await sync()
      await exactSourceRenderHistory(content)
    },

    async proveTldaToRemote() {
      const before = await remoteCount()
      const accepted = await authority()
      const content = `# Linked remote probe\n\nTLDA ${randomUUID()}\n`
      const response = await tldaEdit(content, accepted.currentRevision)
      if (!response.body?.ok) throw new Error(`tlda edit was not accepted: ${JSON.stringify(response.body)}`)
      await waitUntil(async () => await remoteContent() === content.trim(), { description: 'exact remote content' })
      const after = await remoteCount()
      if (after !== before + 1) throw new Error(`tlda edit created ${after - before} remote commits instead of exactly one`)
    },

    async createDivergence() {
      const acceptedRevision = (await authority()).currentRevision
      const remoteBody = `# Linked remote probe\n\nREMOTE-DIVERGED ${randomUUID()}\n`
      const head = await commitRemote(remoteBody)
      const browserBody = `# Linked remote probe\n\nTLDA-DIVERGED ${randomUUID()}\n`
      const response = await tldaEdit(browserBody, acceptedRevision)
      return { acceptedRevision, remoteHead: head, remoteBody, browserBody, response }
    },

    async observeDivergence(state) {
      const currentAuthority = await authority()
      const head = await remoteHead()
      const record = await projectRecord()
      const conflictVisible = state.response.status === 409
        || state.response.body?.status === 'stale-base'
        || record.overleafSyncStatus === 'error'
        || (Array.isArray(record.overleafConflictFiles) && record.overleafConflictFiles.length > 0)
      return { acceptedRevision: currentAuthority.currentRevision, remoteHead: head, conflictVisible }
    },

    async proveRestartConvergence() {
      const content = `# Linked remote probe\n\nRESTART ${randomUUID()}\n`
      const beforeCount = await remoteCount()
      await commitRemote(content)
      const committedCount = await remoteCount()
      if (committedCount !== beforeCount + 1) throw new Error('restart precondition did not create exactly one remote commit')
      await restart()
      await waitUntil(async () => {
        const response = await fetch(`${storeServer}/api/health`, { signal: AbortSignal.timeout(requestTimeoutMs) })
        return response.ok
      }, { timeoutMs: 120_000, description: 'testing server restart' })
      await sync()
      await exactSourceRenderHistory(content)
      if (await remoteCount() !== committedCount) throw new Error('restart convergence created a duplicate or echo commit')
    },

    close() {
      if (daemon && !daemon.killed) daemon.kill('SIGTERM')
    },
  }
}
