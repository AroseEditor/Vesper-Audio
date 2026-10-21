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
const CABLE = {
  url: 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
  sha256: 'b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb',
  size: 1318877,
  catalog: 'vbaudio_cable64_win10.cat',
  setup: 'VBCABLE_Setup_x64.exe'
}
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
    const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe')
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true }, err => (err ? reject(err) : resolve()))
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

function brandIcon() {
  const dir = path.join(process.env.ProgramData || 'C:/ProgramData', 'Vesper Audio')
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, 'vesper.ico')
  fs.copyFileSync(path.join(__dirname, 'ui', 'assets', 'vesper.ico'), dest)
  return dest + ',0'
}

function brand() {
  return winaudio.brand(brandIcon())
}

async function installCable(emit) {
  const progress = (value, text) => emit({ value, text })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-cable-'))
  try {
    const label = 'Downloading VB-CABLE from vb-audio.com'
    progress(0.03, label)
    const zip = path.join(work, 'VBCABLE_Driver_Pack45.zip')
    const digest = await download(CABLE.url, zip, CABLE.size, v => progress(v, label))
    if (digest !== CABLE.sha256) throw new Error('VB-CABLE package checksum mismatch')
    progress(0.92, 'Unpacking')
    const dir = path.join(work, 'pkg')
    await extract(zip, dir)
    const check = await winaudio.driverVerify(path.join(dir, CABLE.catalog))
    if (!check.microsoft) throw new Error('VB-CABLE package is not signed by Microsoft')
    progress(0.96, 'Waiting for the VB-Audio installer')
    await winaudio.runSetup(path.join(dir, CABLE.setup))
    progress(1, 'Installer closed')
    return { ok: true }
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {})
  }
}

async function uninstall() {
  const result = await winaudio.driverUninstall()
  if (result.ok) require('./store').set({ driverVersion: null })
  return result
}

module.exports = { status, install, installCable, brand, uninstall }
