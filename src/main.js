const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, shell, dialog, protocol, net, powerMonitor, powerSaveBlocker } = require('electron')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const fs = require('fs')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const store = require('./store')
const winaudio = require('./winaudio')
const driver = require('./driver')
const models = require('./models')
const updater = require('./updater')
const trainer = require('./trainer')
const core = require('./core')
const apk = require('./apk')
const { wavBuffer } = require('./wav')

const REPO_URL = 'https://github.com/AroseEditor/Vesper-Audio'
const MAX_SOUNDS = 40
const testMode = process.argv.includes('--test')

protocol.registerSchemesAsPrivileged([
  { scheme: 'vesper', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

if (testMode && process.env.VESPER_USER_DATA) app.setPath('userData', process.env.VESPER_USER_DATA)
if (!app.requestSingleInstanceLock() && !testMode) app.quit()
store.load()
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const raised = new Set()
function raisePriority() {
  for (const m of app.getAppMetrics()) {
    const audio = m.type === 'Tab' || (m.serviceName || '').toLowerCase().includes('audio')
    if (!audio || raised.has(m.pid)) continue
    try {
      os.setPriority(m.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL)
      raised.add(m.pid)
    } catch {}
  }
}

let win = null
let tray = null
let quitting = false

const assets = path.join(__dirname, 'ui', 'assets')
const icon = nativeImage.createFromPath(path.join(assets, 'icon.png'))
const soundsDir = () => path.join(app.getPath('userData'), 'sounds')

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('app:shown')
}

function announceVisibility(visible) {
  if (win && !win.isDestroyed()) win.webContents.send(visible ? 'app:shown' : 'app:hidden')
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#121212',
    title: 'Vesper Audio',
    icon,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#121212', symbolColor: '#d9d9d9', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.setMenu(null)
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') && !testMode) win.show()
  })
  for (const [event, visible] of [['show', true], ['restore', true], ['hide', false], ['minimize', false]]) win.on(event, () => announceVisibility(visible))
  win.webContents.on('did-finish-load', () => announceVisibility(win.isVisible() && !win.isMinimized()))
  win.on('close', e => {
    if (!quitting && store.get().closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })
}

function createTray() {
  tray = new Tray(icon.resize({ width: 32, height: 32 }))
  tray.setToolTip('Vesper Audio')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Vesper Audio', click: showWindow },
      { type: 'separator' },
      { label: 'Exit', click: quit }
    ])
  )
  tray.on('click', showWindow)
}

function quit() {
  quitting = true
  app.quit()
}

function applyLogin() {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: store.get().autoStart,
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: ['--hidden']
  })
}

function handleIpc() {
  ipcMain.handle('settings:get', () => store.get())
  ipcMain.handle('settings:set', (_, patch) => {
    const data = store.set(patch)
    if ('autoStart' in patch) applyLogin()
    return data
  })
  ipcMain.handle('devices:list', () => winaudio.list())
  ipcMain.handle('device:volume', (_, id, percent) => winaudio.setVolume(id, percent))
  ipcMain.handle('device:mute', (_, id, muted) => winaudio.setMute(id, muted))
  ipcMain.handle('device:listen', (_, id, on) => winaudio.setListen(id, on))
  ipcMain.handle('device:sysfx', (_, id, on) => winaudio.setSysFx(id, on))
  ipcMain.handle('system:gpus', () => winaudio.gpus())
  ipcMain.handle('driver:status', () => driver.status())
  ipcMain.handle('driver:install', (_, kind) => driver[kind === 'own' ? 'install' : 'installCable'](p => win && win.webContents.send('driver:progress', p)))
  ipcMain.handle('driver:brand', () => driver.brand())
  ipcMain.handle('update:status', () => updater.get())
  ipcMain.handle('update:act', () => updater.act())
  ipcMain.handle('driver:uninstall', () => driver.uninstall())
  ipcMain.handle('model:ensure', (_, name) => models.ensure(name, p => win && win.webContents.send('model:progress', p)))
  ipcMain.handle('sounds:add', async () => {
    const current = store.get().sounds
    const room = MAX_SOUNDS - current.length
    if (room <= 0) return current
    const picked =
      testMode && process.env.VESPER_TEST_SOUNDS
        ? { canceled: false, filePaths: process.env.VESPER_TEST_SOUNDS.split(';') }
        : await dialog.showOpenDialog(win, {
            title: 'Add sounds',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'MP3 audio', extensions: ['mp3'] }]
          })
    if (picked.canceled) return current
    fs.mkdirSync(soundsDir(), { recursive: true })
    const added = picked.filePaths.slice(0, room).map(file => {
      const id = crypto.randomUUID()
      fs.copyFileSync(file, path.join(soundsDir(), id + '.mp3'))
      return { id, name: path.basename(file, path.extname(file)), volume: 100 }
    })
    return store.set({ sounds: [...current, ...added] }).sounds
  })
  ipcMain.handle('sounds:remove', (_, id) => {
    fs.rmSync(path.join(soundsDir(), path.basename(id) + '.mp3'), { force: true })
    return store.set({ sounds: store.get().sounds.filter(s => s.id !== id) }).sounds
  })
  ipcMain.handle('trainer:status', () => trainer.status())
  ipcMain.handle('trainer:start', (_, options) => {
    trainer.start(options, s => win && !win.isDestroyed() && win.webContents.send('trainer:progress', s))
    return trainer.status()
  })
  ipcMain.handle('trainer:cancel', () => trainer.cancel())
  ipcMain.handle('trainer:use', () => trainer.useCandidate())
  ipcMain.handle('trainer:remove', () => trainer.remove())
  ipcMain.handle('voice:wav', (_, meta, bytes) => trainer.saveWav(meta, bytes))
  ipcMain.handle('voice:list', () => trainer.listVoice())
  ipcMain.handle('voice:wipe', () => trainer.wipeVoice())
  ipcMain.handle('diag:save', (_, name, bytes) => {
    const dir = path.join(app.getPath('documents'), 'Vesper Audio Diagnostics')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, String(name).replace(/[^a-z0-9._-]/gi, '_'))
    fs.writeFileSync(file, file.endsWith('.json') ? Buffer.from(bytes) : wavBuffer(Buffer.from(bytes)))
    return file
  })
  ipcMain.handle('diag:open', () => shell.openPath(path.join(app.getPath('documents'), 'Vesper Audio Diagnostics')))
  ipcMain.handle('app:relaunch', () => {
    store.flush()
    quitting = true
    app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: process.argv.slice(1) })
    app.exit(0)
  })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, testMode, uptime: os.uptime() }))
  ipcMain.handle('app:settings', () => shell.openExternal('ms-settings:recovery'))
  ipcMain.handle('system:restart', (_, cancel) => {
    const args = cancel ? ['/a'] : ['/r', '/t', '15', '/c', 'Vesper Audio is restarting Windows to finish driver setup']
    return new Promise(resolve => execFile('shutdown.exe', args, { windowsHide: true }, err => resolve(!err)))
  })
  ipcMain.handle('app:repo', () => shell.openExternal(REPO_URL))
  ipcMain.handle('app:quit', quit)
  ipcMain.handle('link:call', (_, method, params) => core.call(method, params))
  ipcMain.handle('link:available', () => core.available())
  ipcMain.handle('link:paired', () => core.hasPairedPhones())
  ipcMain.handle('apk:start', () => apk.start())
  ipcMain.handle('apk:stop', () => apk.stop())
  ipcMain.handle('app:link', (_, url) => (String(url).startsWith(REPO_URL) ? shell.openExternal(String(url)) : null))
  ipcMain.handle('link:retry', () => {
    core.retry()
    return core.ensure()
  })
  ipcMain.handle('app:log', (_, line) => {
    if (testMode) console.log('[renderer]', line)
  })
}

app.on('second-instance', showWindow)
app.on('before-quit', () => {
  quitting = true
  core.stop()
  apk.stop()
  store.flush()
})
app.on('window-all-closed', () => app.quit())

app.whenReady().then(() => {
  app.setAppUserModelId('com.ayushue5.vesperaudio')
  protocol.handle('vesper', req => {
    const url = new URL(req.url)
    const base = url.hostname === 'sounds' ? soundsDir() : models.dir()
    return net.fetch(pathToFileURL(path.join(base, path.basename(decodeURIComponent(url.pathname)))).toString())
  })
  session.defaultSession.setPermissionRequestHandler((_, permission, cb) => cb(permission === 'media'))
  session.defaultSession.setPermissionCheckHandler((_, permission) => permission === 'media')
  handleIpc()
  const toWindow = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload)
  core.on({
    event: (name, data) => {
      if (name === 'pcm') toWindow('link:pcm', { id: data.id, sid: data.sid, seq: data.seq, lost: data.lost, pcm: Buffer.from(data.b64, 'base64') })
      else toWindow('link:event', { event: name, data })
    },
    failed: message => toWindow('link:failed', message)
  })
  if (core.hasPairedPhones() || String(store.get().inputId || '').startsWith('phone:')) core.ensure().catch(() => {})
  applyLogin()
  createWindow()
  createTray()
  raisePriority()
  powerSaveBlocker.start('prevent-app-suspension')
  const wake = () => setTimeout(() => win && !win.isDestroyed() && win.webContents.send('app:wake'), 1500)
  powerMonitor.on('resume', wake)
  powerMonitor.on('unlock-screen', wake)
  if (!testMode) updater.start(s => win && !win.isDestroyed() && win.webContents.send('update:status', s))
  setInterval(raisePriority, 15000).unref()
})
