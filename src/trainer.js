const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const store = require('./store')
const { wavBuffer } = require('./wav')

const REPO = 'AroseEditor/Vesper-Audio'
const TAG = 'trainer-v1'
const ASSET = 'VesperTrainer-win-x64.zip'
const PACK_VERSION = 'trainer-v1'
const MINUTES = { light: 30, heavy: 120 }
const headers = { 'User-Agent': 'vesper-audio', Accept: 'application/vnd.github+json' }

const userData = () => app.getPath('userData')
const packDir = () => process.env.VESPER_TRAINER_DIR || path.join(userData(), 'trainer', 'pack')
const voiceDir = () => path.join(userData(), 'voice')
const modelsDir = () => path.join(userData(), 'models')
const baseModel = () => path.join(modelsDir(), 'dfn3_ll.tar.gz')
const python = () => path.join(packDir(), 'python', 'python.exe')
const script = name => path.join(packDir(), 'training', name)

let child = null
let state = { phase: 'idle', percent: 0, message: '', step: 0, total: 0, etaSeconds: 0, result: null }
let emitter = () => {}

function set(next) {
  state = { ...state, ...next }
  emitter(state)
}

function installed() {
  if (process.env.VESPER_TRAINER_DIR) return true
  try {
    return JSON.parse(fs.readFileSync(path.join(packDir(), 'pack.json'), 'utf8')).version === PACK_VERSION
  } catch {
    return false
  }
}

function status() {
  return { ...state, installed: installed(), personal: store.get().personal }
}

async function download(url, dest, size, label) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vesper-audio' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || size || 0
  let done = 0
  const hash = crypto.createHash('sha256')
  const body = Readable.fromWeb(res.body)
  body.on('data', chunk => {
    done += chunk.length
    hash.update(chunk)
    if (total) set({ phase: 'download', percent: Math.round((done / total) * 100), message: label })
  })
  await pipeline(body, fs.createWriteStream(dest))
  return hash.digest('hex')
}

function extract(zip, dir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true })
    const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe')
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true, maxBuffer: 1 << 24 }, err => (err ? reject(err) : resolve()))
  })
}

async function ensurePack() {
  if (installed()) return
  set({ phase: 'download', percent: 0, message: 'Looking up the trainer package' })
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers })
  if (!res.ok) throw new Error(`trainer package lookup failed (${res.status})`)
  const release = await res.json()
  const zip = release.assets.find(a => a.name === ASSET)
  const sum = release.assets.find(a => a.name === ASSET + '.sha256')
  if (!zip || !sum) throw new Error('the trainer package is not published yet')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-trainer-'))
  try {
    const file = path.join(work, ASSET)
    const digest = await download(zip.browser_download_url, file, zip.size, 'Downloading the trainer package')
    const expected = (await (await fetch(sum.browser_download_url, { headers: { 'User-Agent': 'vesper-audio' } })).text()).trim().split(/\s+/)[0].toLowerCase()
    if (digest !== expected) throw new Error('trainer package checksum mismatch')
    set({ phase: 'download', percent: 100, message: 'Unpacking the trainer' })
    fs.rmSync(packDir(), { recursive: true, force: true })
    await extract(file, packDir())
    fs.writeFileSync(path.join(packDir(), 'pack.json'), JSON.stringify({ version: PACK_VERSION }))
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {})
  }
}

function prepareBase() {
  fs.mkdirSync(modelsDir(), { recursive: true })
  if (!fs.existsSync(baseModel())) fs.copyFileSync(path.join(__dirname, 'ui', 'vendor', 'dfn3_ll.tar.gz'), baseModel())
}

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    child = spawn(python(), ['-u', ...args], { cwd: path.join(packDir(), 'training'), windowsHide: true })
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } catch {}
    let buffer = ''
    let tail = ''
    const feed = chunk => {
      buffer += chunk.toString()
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line) onLine(line)
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', c => (tail = (tail + c.toString()).slice(-600)))
    child.on('error', reject)
    child.on('exit', code => {
      child = null
      if (code === 0) resolve()
      else if (state.phase === 'cancelled') reject(new Error('cancelled'))
      else if (code === 3221225781) reject(new Error('Windows is missing the Microsoft Visual C++ runtime. Install the latest Visual C++ Redistributable from Microsoft and try again.'))
      else reject(new Error(`trainer exited with code ${code}. ${tail.trim().split('\n').pop() || ''}`))
    })
  })
}

function jsonOf(args) {
  return new Promise((resolve, reject) => {
    execFile(python(), ['-u', ...args], { cwd: path.join(packDir(), 'training'), windowsHide: true, maxBuffer: 1 << 24, timeout: 900000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('could not read the validation result'))
      }
    })
  })
}

function threads() {
  return Math.max(2, Math.min(6, Math.floor(os.cpus().length / 3)))
}

function verdict(base, mine) {
  const reasons = []
  const keys = ['clean', 'noise10', 'noise0', 'quiet']
  for (const k of keys) {
    if (mine[k].cut_rate > base[k].cut_rate + 1) reasons.push(`it cuts your voice more than the base model in "${k}" (${mine[k].cut_rate}% vs ${base[k].cut_rate}%)`)
  }
  if (mine.others_only.suppression_db + 1 < base.others_only.suppression_db) reasons.push('it removes other voices less than the base model')
  return { ok: reasons.length === 0, reasons }
}

async function start(options, emit) {
  if (child) throw new Error('training is already running')
  emitter = emit
  const depth = options.depth === 'heavy' ? 'heavy' : 'light'
  try {
    set({ phase: 'download', percent: 0, message: '', step: 0, total: 0, etaSeconds: 0, result: null })
    await ensurePack()
    prepareBase()
    const train = path.join(voiceDir(), 'train')
    const val = path.join(voiceDir(), 'val')
    if (!fs.existsSync(train) || !fs.readdirSync(train).some(f => f.endsWith('.wav'))) throw new Error('record your voice first')
    const id = Date.now().toString(36)
    const out = path.join(modelsDir(), `personal-${id}.tar.gz`)
    const corpus = path.join(packDir(), 'corpus')
    set({ phase: 'train', percent: 0, message: 'Preparing' })
    let started = Date.now()
    await run(
      ['train.py', '--base', baseModel(), '--clean', train, '--noise', path.join(corpus, 'noise'), '--speech', path.join(corpus, 'speech'), '--out', out, ...(process.env.VESPER_TRAIN_STEPS ? ['--steps', process.env.VESPER_TRAIN_STEPS] : ['--minutes', String(MINUTES[depth])]), '--threads', String(threads()), '--batch', '12', '--clip', '1.5'],
      line => {
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          return
        }
        if (ev.event === 'plan') set({ total: ev.steps, message: 'Training your voice model' })
        if (ev.event === 'step' && ev.total) {
          const rate = (Date.now() - started) / ev.step
          set({ phase: 'train', step: ev.step, total: ev.total, percent: Math.round((ev.step / ev.total) * 100), etaSeconds: Math.round(((ev.total - ev.step) * rate) / 1000), message: 'Training your voice model' })
        }
      }
    )
    set({ phase: 'validate', percent: 100, message: 'Checking the result on your recordings' })
    let result = null
    if (fs.existsSync(val) && fs.readdirSync(val).some(f => f.endsWith('.wav'))) {
      const common = ['evaluate.py', '--clean', val, '--noise', path.join(corpus, 'noise'), '--speech', path.join(corpus, 'speech'), '--count', '16', '--threads', String(threads())]
      const base = await jsonOf([...common, '--model', baseModel()])
      const mine = await jsonOf([...common, '--model', out])
      result = { base, mine, ...verdict(base, mine) }
    } else {
      result = { ok: true, reasons: [], base: null, mine: null }
    }
    const personal = { id, depth, languages: options.languages || [], trainedAt: Date.now(), url: `vesper://models/personal-${id}.tar.gz`, file: path.basename(out), accepted: result.ok, metrics: result }
    store.set({ personal: result.ok ? personal : { ...(store.get().personal || {}), candidate: personal } })
    set({ phase: 'done', percent: 100, message: result.ok ? 'Your voice model is ready' : 'Training finished, but the result is not better than the base model', result })
  } catch (err) {
    set({ phase: state.phase === 'cancelled' ? 'cancelled' : 'error', message: state.phase === 'cancelled' ? 'Training cancelled' : String((err && err.message) || err) })
  }
  return state
}

function cancel() {
  if (!child) return
  set({ phase: 'cancelled' })
  execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
}

function useCandidate() {
  const current = store.get().personal
  if (current && current.candidate) store.set({ personal: { ...current.candidate, accepted: true } })
  return store.get().personal
}

function remove() {
  const current = store.get().personal
  for (const p of [current, current && current.candidate]) if (p && p.file) fs.rmSync(path.join(modelsDir(), p.file), { force: true })
  store.set({ personal: null })
  return null
}

function saveWav(meta, bytes) {
  const dir = path.join(voiceDir(), meta.split === 'val' ? 'val' : 'train')
  fs.mkdirSync(dir, { recursive: true })
  const pcm = Buffer.from(bytes)
  const name = String(meta.name).replace(/[^a-z0-9_-]/gi, '_') + '.wav'
  fs.writeFileSync(path.join(dir, name), wavBuffer(pcm))
  return listVoice()
}

function listVoice() {
  const out = []
  for (const split of ['train', 'val']) {
    const dir = path.join(voiceDir(), split)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.wav')) out.push({ split, name: f, seconds: Math.max(0, (fs.statSync(path.join(dir, f)).size - 44) / 96000) })
    }
  }
  return out
}

function wipeVoice() {
  fs.rmSync(voiceDir(), { recursive: true, force: true })
  return []
}

module.exports = { status, start, cancel, useCandidate, remove, saveWav, listVoice, wipeVoice }
