const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const defaults = {
  autoStart: true,
  closeToTray: true,
  inputId: '',
  cableId: '',
  monitorId: '',
  monitor: false,
  ai: false,
  aiPreset: 'custom',
  aiStrength: 80,
  basic: false,
  basicPreset: 'rnnoise',
  speexDb: -30,
  gains: {},
  boardVolume: 100,
  sounds: [],
  voiceSamples: [],
  voiceprints: {},
  driverVersion: null,
  setupDone: false
}

let file = ''
let data = { ...defaults }
let timer = null

function load() {
  file = path.join(app.getPath('userData'), 'settings.json')
  try {
    data = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    data = { ...defaults }
  }
  return data
}

function flush() {
  clearTimeout(timer)
  timer = null
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function set(patch) {
  Object.assign(data, patch)
  clearTimeout(timer)
  timer = setTimeout(flush, 150)
  return data
}

module.exports = { load, get: () => data, set, flush, defaults }
