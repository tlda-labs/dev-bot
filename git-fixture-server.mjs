#!/usr/bin/env node

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const port = Number(process.env.PORT || 8080)
const root = process.env.GIT_FIXTURE_ROOT || '/data'
const repo = path.join(root, 'remote.git')
const token = process.env.GIT_FIXTURE_TOKEN || ''

fs.mkdirSync(root, { recursive: true })
if (!fs.existsSync(path.join(repo, 'HEAD'))) {
  const init = spawnSync('git', ['init', '--bare', '--initial-branch=main', repo], { encoding: 'utf8' })
  if (init.status !== 0) throw new Error(init.stderr || 'git init failed')
}
spawnSync('git', ['config', '--file', path.join(repo, 'config'), 'http.receivepack', 'true'])

function authorized(request) {
  if (!token) return false
  const header = request.headers.authorization || ''
  if (!header.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  return decoded.slice(decoded.indexOf(':') + 1) === token
}

function writeCgiResponse(response, buffer) {
  const boundary = buffer.indexOf('\r\n\r\n')
  if (boundary < 0) {
    response.writeHead(502)
    response.end('invalid git backend response')
    return
  }
  const headers = buffer.subarray(0, boundary).toString('utf8').split('\r\n')
  let status = 200
  for (const line of headers) {
    const split = line.indexOf(':')
    if (split < 0) continue
    const name = line.slice(0, split)
    const value = line.slice(split + 1).trim()
    if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 200
    else response.setHeader(name, value)
  }
  response.writeHead(status)
  response.end(buffer.subarray(boundary + 4))
}

http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (!authorized(request)) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tlda disposable git"' })
    response.end('authentication required')
    return
  }
  const url = new URL(request.url, 'http://fixture.local')
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.searchParams.toString(),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] || '',
      CONTENT_LENGTH: request.headers['content-length'] || '',
      REMOTE_USER: 'git',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const chunks = []
  const errors = []
  child.stdout.on('data', chunk => chunks.push(chunk))
  child.stderr.on('data', chunk => errors.push(chunk))
  child.on('close', code => {
    if (code !== 0) {
      response.writeHead(500)
      response.end(Buffer.concat(errors).toString('utf8'))
      return
    }
    writeCgiResponse(response, Buffer.concat(chunks))
  })
  request.pipe(child.stdin)
}).listen(port, '0.0.0.0', () => {
  console.log(`[git-fixture] listening on ${port}`)
})
