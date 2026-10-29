const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const winaudio = require('./winaudio')

const PACKAGE = {
  url: 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip',
  sha256: 'e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a',
  size: 132118,
  signer: 'SignPath Foundation'
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vesper-audio' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || PACKAGE.size
  let done = 0
  const hash = crypto.createHash('sha256')
  const body = Readable.fromWeb(res.body)
  body.on('data', chunk => {
    done += chunk.length
    hash.update(chunk)
    onProgress(Math.min(0.5, (done / total) * 0.5))
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
  try {
    return await winaudio.vddStatus()
  } catch (err) {
    return { ok: false, nodePresent: false, running: false, monitors: [], message: String((err && err.message) || err) }
  }
}

async function monitors() {
  return (await winaudio.displays()).monitors
}

async function install(emit) {
  const step = (percent, message) => emit({ phase: 'download', percent: Math.round(percent * 100), message })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-vdd-'))
  step(0, 'Downloading the virtual display driver')
  const zip = path.join(work, 'driver.zip')
  const digest = await download(PACKAGE.url, zip, p => step(p, 'Downloading the virtual display driver'))
  if (digest !== PACKAGE.sha256) throw new Error('the virtual display driver download does not match its known checksum')
  step(0.6, 'Unpacking')
  const dir = path.join(work, 'pkg')
  await extract(zip, dir)
  const folder = path.join(dir, 'VirtualDisplayDriver')
  step(0.7, 'Checking the driver signature')
  const verdict = await winaudio.driverVerify(path.join(folder, 'mttvdd.cat'))
  if (verdict.status !== 'Valid' || !String(verdict.subject).includes(PACKAGE.signer)) throw new Error('the virtual display driver is not signed by ' + PACKAGE.signer)
  step(0.8, 'Installing, approve the Windows prompt')
  const result = await winaudio.vddInstall(folder)
  if (!result.ok) throw new Error(result.message || 'the virtual display driver could not be installed')
  step(1, 'Done')
  return { ...(await status()), rebootRequired: Boolean(result.rebootRequired) }
}

async function uninstall() {
  const result = await winaudio.vddUninstall()
  if (!result.ok) throw new Error(result.message || 'the virtual display driver could not be removed')
  return status()
}

module.exports = { status, monitors, install, uninstall }
