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
  aiPreset: 'personal',
  aiStrength: 100,
  basic: false,
  basicPreset: 'rnnoise',
  speexDb: -30,
  gateOn: false,
  gateDb: -45,
  normOn: false,
  quietDb: 4,
  loudDb: -4,
  cableOwned: false,
  gains: {},
  boardVolume: 100,
  sounds: [],
  personal: null,
  phoneName: '',
  displayQuality: 'low',
  displayMonitor: '',
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
    if (data.aiPreset !== 'clearcast') data.aiPreset = 'personal'
    for (const k of ['voiceSensitivity', 'voiceSamples', 'voiceprints']) delete data[k]
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
