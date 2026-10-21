const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, shell, dialog, protocol, net } = require('electron')
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

const REPO_URL = 'https://github.com/AroseEditor/Vesper-Audio'
const MAX_SOUNDS = 40
const testMode = process.argv.includes('--test')

protocol.registerSchemesAsPrivileged([
  { scheme: 'vesper', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

if (testMode && process.env.VESPER_USER_DATA) app.setPath('userData', process.env.VESPER_USER_DATA)
if (!app.requestSingleInstanceLock() && !testMode) app.quit()
const early = store.load()
if (early.ai && early.aiPreset === 'heavy') app.commandLine.appendSwitch('force_high_performance_gpu')

let win = null
let tray = null
let quitting = false

const assets = path.join(__dirname, 'ui', 'assets')
const icon = nativeImage.createFromPath(path.join(assets, 'icon.png'))
const soundsDir = () => path.join(app.getPath('userData'), 'sounds')
const voiceDir = () => path.join(app.getPath('userData'), 'voice')
const MAX_VOICE_SAMPLES = 4

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('app:shown')
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
  ipcMain.handle('voice:save', (_, bytes, meta) => {
    fs.mkdirSync(voiceDir(), { recursive: true })
    const keep = meta.replace ? [] : store.get().voiceSamples.slice(-(MAX_VOICE_SAMPLES - 1))
    if (meta.replace) for (const old of store.get().voiceSamples) fs.rmSync(path.join(voiceDir(), old.id + '.pcm'), { force: true })
    const id = crypto.randomUUID()
    fs.writeFileSync(path.join(voiceDir(), id + '.pcm'), Buffer.from(bytes))
    const samples = [...keep, { id, language: meta.language, seconds: meta.seconds, created: Date.now() }]
    for (const old of store.get().voiceSamples) if (!samples.some(k => k.id === old.id)) fs.rmSync(path.join(voiceDir(), old.id + '.pcm'), { force: true })
    return store.set({ voiceSamples: samples, voiceprints: {} }).voiceSamples
  })
  ipcMain.handle('voice:load', () =>
    store.get().voiceSamples.map(s => ({ id: s.id, bytes: fs.readFileSync(path.join(voiceDir(), s.id + '.pcm')) }))
  )
  ipcMain.handle('voice:clear', () => {
    for (const old of store.get().voiceSamples) fs.rmSync(path.join(voiceDir(), old.id + '.pcm'), { force: true })
    return store.set({ voiceSamples: [], voiceprints: {} }).voiceSamples
  })
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
  ipcMain.handle('app:log', (_, line) => {
    if (testMode) console.log('[renderer]', line)
  })
}

app.on('second-instance', showWindow)
app.on('before-quit', () => {
  quitting = true
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
  applyLogin()
  createWindow()
  createTray()
})
