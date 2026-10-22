const { app, shell } = require('electron')

const REPO = 'AroseEditor/Vesper-Audio'
const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

let status = { state: 'idle', version: '', percent: 0, message: '', portable }
let send = () => {}
let updater = null
let releaseUrl = `https://github.com/${REPO}/releases/latest`

function set(next) {
  status = { ...status, ...next }
  send(status)
}

function newer(a, b) {
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  }
  return false
}

async function checkRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'vesper-audio', Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`update lookup failed (${res.status})`)
  const release = await res.json()
  releaseUrl = release.html_url || releaseUrl
  return String(release.tag_name || '').replace(/^v/, '')
}

async function check() {
  if (!app.isPackaged) return set({ state: 'idle', message: 'Updates are checked in installed builds only.' })
  if (['checking', 'downloading', 'ready'].includes(status.state)) return status
  set({ state: 'checking', message: '' })
  try {
    if (portable) {
      const latest = await checkRelease()
      if (newer(latest, app.getVersion())) set({ state: 'available', version: latest, message: '' })
      else set({ state: 'current', version: app.getVersion(), message: '' })
    } else {
      await updater.checkForUpdates()
    }
  } catch (err) {
    set({ state: 'error', message: String((err && err.message) || err).split('\n')[0] })
  }
  return status
}

function start(emit) {
  send = emit
  if (!app.isPackaged) return
  if (!portable) {
    updater = require('electron-updater').autoUpdater
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.logger = null
    updater.on('update-available', info => set({ state: 'downloading', version: info.version, percent: 0 }))
    updater.on('update-not-available', () => set({ state: 'current', version: app.getVersion() }))
    updater.on('download-progress', p => set({ state: 'downloading', percent: Math.round(p.percent) }))
    updater.on('update-downloaded', info => set({ state: 'ready', version: info.version, percent: 100 }))
    updater.on('error', err => set({ state: 'error', message: String((err && err.message) || err).split('\n')[0] }))
  }
  setTimeout(check, 20000).unref()
  setInterval(check, CHECK_EVERY_MS).unref()
}

function act() {
  if (status.state === 'ready' && updater) updater.quitAndInstall(false, true)
  else if (status.state === 'available') shell.openExternal(releaseUrl)
  else check()
}

module.exports = { start, check, act, get: () => status }
