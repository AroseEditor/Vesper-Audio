const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const METHODS = new Set(['core.ping', 'link.start', 'link.stop', 'link.status', 'link.pairUri', 'link.phones', 'link.confirm', 'link.forget', 'link.session.start', 'link.session.stop'])
const CALL_TIMEOUT_MS = 10000
const CRASH_WINDOW_MS = 60000
const MAX_CRASHES = 3

function exePath() {
  if (process.env.VESPER_CORE) return process.env.VESPER_CORE
  if (app.isPackaged) return path.join(process.resourcesPath, 'vesper-core.exe')
  const root = path.join(__dirname, '..', 'core', 'target')
  for (const dir of ['release', 'debug']) {
    const file = path.join(root, dir, 'vesper-core.exe')
    if (fs.existsSync(file)) return file
  }
  return path.join(root, 'release', 'vesper-core.exe')
}

function available() {
  return fs.existsSync(exePath())
}

let child = null
let buffer = ''
let nextId = 1
let pending = new Map()
let crashes = []
let wantLink = false
let failed = false
let handlers = { event: () => {}, failed: () => {} }
let restartTimer = null

function dataDir() {
  return app.getPath('userData')
}

function onLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.event) return handlers.event(message.event, message.data)
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id)
  clearTimeout(call.timer)
  if (message.error) call.reject(new Error(String(message.error)))
  else call.resolve(message.result)
}

function failAll(reason) {
  for (const call of pending.values()) {
    clearTimeout(call.timer)
    call.reject(new Error(reason))
  }
  pending = new Map()
}

function spawnChild() {
  if (child || failed) return
  if (!available()) {
    failed = true
    handlers.failed('The Vesper Audio link component is missing.')
    return
  }
  child = spawn(exePath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line) onLine(line)
    }
  })
  child.stderr.on('data', () => {})
  child.stdin.on('error', () => {})
  child.on('error', () => {})
  child.on('exit', () => {
    child = null
    failAll('The link component stopped.')
    if (!wantLink) return
    const now = Date.now()
    crashes = crashes.filter(t => now - t < CRASH_WINDOW_MS)
    crashes.push(now)
    if (crashes.length >= MAX_CRASHES) {
      failed = true
      handlers.failed('The link component keeps stopping, so phone features are off for this session.')
      return
    }
    restartTimer = setTimeout(() => {
      restartTimer = null
      begin().catch(() => {})
    }, 500 * crashes.length)
  })
}

function raw(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!child || !child.stdin.writable) return reject(new Error('The link component is not running.'))
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The link component did not answer.'))
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

async function begin() {
  spawnChild()
  if (!child) throw new Error('The link component could not start.')
  return raw('link.start', { dataDir: dataDir(), name: os.hostname() })
}

async function ensure() {
  if (failed) throw new Error('Phone features are off because the link component failed.')
  wantLink = true
  if (!child) return begin()
  return raw('link.status')
}

async function call(method, params) {
  if (!METHODS.has(method)) throw new Error('blocked method ' + method)
  if (method === 'link.stop') {
    wantLink = false
    if (!child) return null
    return raw(method, params)
  }
  await ensure()
  return raw(method, params)
}

function hasPairedPhones() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dataDir(), 'link', 'paired.json'), 'utf8'))
    return Array.isArray(list) && list.length > 0
  } catch {
    return false
  }
}

function retry() {
  failed = false
  crashes = []
}

function stop() {
  wantLink = false
  clearTimeout(restartTimer)
  if (child) {
    try {
      child.stdin.end()
    } catch {}
    const proc = child
    setTimeout(() => {
      try {
        proc.kill()
      } catch {}
    }, 800).unref()
  }
}

function on(handlerMap) {
  handlers = { ...handlers, ...handlerMap }
}

function programs() {
  const dir = path.dirname(exePath())
  return [exePath(), path.join(dir, 'vesper-display.exe')].filter(file => fs.existsSync(file))
}

module.exports = { call, ensure, available, hasPairedPhones, retry, stop, on, exePath, programs }
