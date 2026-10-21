const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const winaudio = require('./winaudio')

const REPO = 'AroseEditor/Vesper-Audio'
const ASSET = 'VesperAudioCable-x64.zip'
const headers = { 'User-Agent': 'vesper-audio', Accept: 'application/vnd.github+json' }

async function findRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, { headers })
  if (!res.ok) throw new Error(`release lookup failed (${res.status})`)
  const releases = await res.json()
  for (const r of releases) {
    if (r.draft) continue
    const zip = r.assets.find(a => a.name === ASSET)
    const sum = r.assets.find(a => a.name === ASSET + '.sha256')
    if (zip && sum) return { tag: r.tag_name, zip: zip.browser_download_url, size: zip.size, sum: sum.browser_download_url }
  }
  throw new Error('no published release contains the driver package')
}

async function download(url, dest, size, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vesper-audio' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || size || 0
  let done = 0
  const hash = crypto.createHash('sha256')
  const body = Readable.fromWeb(res.body)
  body.on('data', chunk => {
    done += chunk.length
    hash.update(chunk)
    if (total) onProgress(Math.min(0.9, (done / total) * 0.9))
  })
  await pipeline(body, fs.createWriteStream(dest))
  return hash.digest('hex')
}

function extract(zip, dir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true })
    execFile('tar.exe', ['-xf', zip, '-C', dir], { windowsHide: true }, err => (err ? reject(err) : resolve()))
  })
}

async function status() {
  const s = await winaudio.driverStatus()
  return { ...s, version: require('./store').get().driverVersion }
}

async function install(emit) {
  const progress = (value, text) => emit({ value, text })
  progress(0.02, 'Looking up the latest driver release')
  const release = await findRelease()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-driver-'))
  try {
    progress(0.05, 'Downloading Vesper Audio Cable ' + release.tag)
    const zip = path.join(work, ASSET)
    const digest = await download(release.zip, zip, release.size, v => progress(v, 'Downloading Vesper Audio Cable ' + release.tag))
    const expected = (await (await fetch(release.sum, { headers: { 'User-Agent': 'vesper-audio' } })).text()).trim().split(/\s+/)[0].toLowerCase()
    if (digest !== expected) throw new Error('driver package checksum mismatch')
    progress(0.92, 'Unpacking driver')
    const dir = path.join(work, 'pkg')
    await extract(zip, dir)
    progress(0.95, 'Waiting for administrator approval')
    const result = await winaudio.driverInstall(dir)
    if (!result.ok) throw new Error(result.message || 'driver install failed')
    require('./store').set({ driverVersion: release.tag })
    progress(1, result.rebootRequired ? 'Installed. Restart Windows to finish' : 'Installed')
    return result
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {})
  }
}

async function uninstall() {
  const result = await winaudio.driverUninstall()
  if (result.ok) require('./store').set({ driverVersion: null })
  return result
}

module.exports = { status, install, uninstall }
