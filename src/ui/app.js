import { hydrate, icon } from './icons.js'
import { Engine } from './engine.js'
import { Enroller, loadSpeaker } from './voice.js'

const api = window.vesper
const $ = id => document.getElementById(id)
const engine = new Engine()

const PARAGRAPH =
  'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow.'
const SPEECH_TARGET = 30
const LAUGH_TARGET = 4

const state = {
  settings: null,
  devices: [],
  driver: null,
  speaker: null,
  speakerLoading: null,
  notices: {},
  info: { version: '', testMode: false },
  voice: null,
  busy: false
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid)
  return el
}

const inputs = () => state.devices.filter(d => d.flow === 'capture' && !d.vac)
const outputs = () => state.devices.filter(d => d.flow === 'render' && !d.vac)
const vacOut = () => state.devices.find(d => d.flow === 'render' && d.vac)
const vacIn = () => state.devices.find(d => d.flow === 'capture' && d.vac)

function currentInput() {
  const list = inputs()
  return list.find(d => d.id === state.settings.inputId) || list.find(d => d.isDefault) || list[0] || null
}

function cableDevice() {
  const forced = state.settings.cableId && state.devices.find(d => d.id === state.settings.cableId && d.flow === 'render')
  return forced || vacOut() || null
}

function monitorDevice() {
  const forced = state.settings.monitorId && state.devices.find(d => d.id === state.settings.monitorId && d.flow === 'render')
  return forced || outputs().find(d => d.isDefault) || null
}

function gainFor(device) {
  return device && state.settings.gains[device.name] != null ? state.settings.gains[device.name] : 100
}

function engineConfig() {
  const s = state.settings
  const input = currentInput()
  return {
    inputName: input ? input.name : '',
    cableName: cableDevice() ? cableDevice().name : '',
    monitorName: monitorDevice() ? monitorDevice().name : '',
    gain: gainFor(input),
    ai: s.ai,
    aiPreset: s.aiPreset,
    aiStrength: s.aiStrength,
    basic: s.basic,
    basicPreset: s.basicPreset,
    speexDb: s.speexDb,
    monitor: s.monitor,
    boardVolume: s.boardVolume,
    voiceprint: s.voiceprint,
    speakerModel: state.speaker
  }
}

let syncTimer = null
let syncWaiters = []
function sync() {
  clearTimeout(syncTimer)
  const done = new Promise(resolve => syncWaiters.push(resolve))
  syncTimer = setTimeout(async () => {
    const waiters = syncWaiters
    syncWaiters = []
    try {
      const cfg = engineConfig()
      if (cfg.ai && cfg.aiPreset === 'custom' && cfg.voiceprint && !state.speaker) await ensureSpeaker().catch(() => {})
      cfg.speakerModel = state.speaker
      await engine.apply(cfg)
      notice('engine', engine.state.error ? { text: 'Audio engine: ' + engine.state.error } : null)
    } finally {
      waiters.forEach(resolve => resolve())
    }
  }, 60)
  return done
}

async function save(patch) {
  Object.assign(state.settings, patch)
  await api.invoke('settings:set', patch)
}

function notice(key, value) {
  if (value) state.notices[key] = value
  else delete state.notices[key]
  const box = $('banners')
  box.replaceChildren(
    ...Object.values(state.notices).map(n =>
      h('div', { class: 'banner' }, h('span', { class: 'msg', text: n.text }), n.action ? h('button', { class: 'btn small', type: 'button', onclick: n.action, text: n.label }) : null)
    )
  )
}

function fill(el) {
  el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%')
}

function setPage(name) {
  for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.id === 'page-' + name)
  for (const el of document.querySelectorAll('.nav')) el.classList.toggle('active', el.dataset.page === name)
  if (name === 'properties' || name === 'home') refreshDevices()
}

function dialog({ title, body, actions = [] }) {
  $('dlg-title').textContent = title
  const box = $('dlg-body')
  box.replaceChildren(...[].concat(body))
  const bar = $('dlg-actions')
  bar.replaceChildren(
    ...actions.map(a =>
      h('button', { class: 'btn' + (a.primary ? ' primary' : ''), type: 'button', id: a.id, onclick: a.onClick, text: a.label, disabled: Boolean(a.disabled) })
    )
  )
  $('overlay').hidden = false
  return { box, bar, close: () => ($('overlay').hidden = true) }
}

function closeDialog() {
  $('overlay').hidden = true
}

function menuItems(menu, items, selected, pick) {
  menu.replaceChildren(
    ...items.map(it =>
      h(
        'button',
        { class: 'menu-item' + (it.value === selected ? ' selected' : ''), type: 'button', onclick: () => pick(it.value) },
        h('b', { text: it.label }),
        it.tag ? h('span', { class: 'tag', text: it.tag }) : null,
        it.small ? h('small', { text: it.small }) : null
      )
    )
  )
}

function renderDevices() {
  const list = inputs()
  const cur = currentInput()
  for (const sel of document.querySelectorAll('[data-select="device"]')) {
    sel.querySelector('[data-device-name]').textContent = cur ? cur.name : 'No input device found'
    menuItems(
      sel.querySelector('.menu'),
      list.map(d => ({ value: d.id, label: d.name, tag: d.isDefault ? 'default' : '' })),
      cur && cur.id,
      async id => {
        closeMenus()
        await save({ inputId: id })
        renderAll()
        sync()
      }
    )
  }
  const cable = cableDevice()
  $('cable-text').textContent = state.settings.cableId && cable ? cable.name : cable ? 'Auto: ' + cable.name : 'Auto (not installed)'
  menuItems(
    document.querySelector('[data-select="cable"] .menu'),
    [{ value: '', label: 'Auto (Vesper Audio Cable)' }, ...outputs().concat(state.devices.filter(d => d.flow === 'render' && d.vac)).map(d => ({ value: d.id, label: d.name }))],
    state.settings.cableId,
    async id => {
      closeMenus()
      await save({ cableId: id })
      renderAll()
      sync()
    }
  )
  const mon = monitorDevice()
  $('monitor-text').textContent = state.settings.monitorId && mon ? mon.name : mon ? 'System default: ' + mon.name : 'System default'
  menuItems(
    document.querySelector('[data-select="monitor"] .menu'),
    [{ value: '', label: 'System default' }, ...outputs().map(d => ({ value: d.id, label: d.name, tag: d.isDefault ? 'default' : '' }))],
    state.settings.monitorId,
    async id => {
      closeMenus()
      await save({ monitorId: id })
      renderAll()
      sync()
    }
  )
}

function renderHome() {
  const s = state.settings
  $('ai-on').checked = s.ai
  $('basic-on').checked = s.basic && !s.ai
  $('basic-on').disabled = s.ai
  $('basic-hint').hidden = !s.ai
  $('monitor-on').checked = s.monitor
  $('ai-preset-text').textContent = s.aiPreset === 'clearcast' ? 'ClearCast' : 'Custom'
  menuItems(
    document.querySelector('[data-select="ai-preset"] .menu'),
    [
      { value: 'custom', label: 'Custom', small: 'Speak a paragraph once and the AI learns your voice. It keeps your voice and laughs and drops everything else.' },
      { value: 'clearcast', label: 'ClearCast', small: 'Studio-grade AI speech cleanup in the style of SteelSeries Sonar. Strength is adjustable.' }
    ],
    s.aiPreset,
    async v => {
      closeMenus()
      await save({ aiPreset: v })
      renderHome()
      if (v === 'custom' && s.ai && !s.voiceprint) await enroll()
      sync()
    }
  )
  $('ai-custom-note').hidden = s.aiPreset !== 'custom'
  $('ai-strength-row').hidden = s.aiPreset !== 'clearcast'
  $('ai-strength').value = s.aiStrength
  $('ai-strength-out').textContent = s.aiStrength + '%'
  fill($('ai-strength'))
  $('voice-status').textContent = s.voiceprint ? 'Your voice is saved. Custom is best and needs no slider.' : 'No voice recorded yet. Record the paragraph once to enable Custom.'
  $('voice-enroll').textContent = s.voiceprint ? 'Re-record' : 'Record voice'
  $('basic-preset-text').textContent = s.basicPreset === 'speex' ? 'Speex' : 'RNNoise'
  menuItems(
    document.querySelector('[data-select="basic-preset"] .menu'),
    [
      { value: 'speex', label: 'Speex', small: 'Classic DSP suppressor with an adjustable suppression level in dB.' },
      { value: 'rnnoise', label: 'RNNoise', small: 'Lightweight neural noise suppressor.' }
    ],
    s.basicPreset,
    async v => {
      closeMenus()
      await save({ basicPreset: v })
      renderHome()
      sync()
    }
  )
  $('basic-sub').hidden = s.basicPreset !== 'speex'
  $('speex-db').value = s.speexDb
  $('speex-db-out').textContent = s.speexDb + ' dB'
  fill($('speex-db'))
}

function renderProps() {
  const d = currentInput()
  const chips = $('device-chips')
  if (!d) {
    chips.replaceChildren(h('span', { class: 'chip', text: 'No input device detected' }))
    return
  }
  const f = d.format
  const bits = []
  if (d.isDefault) bits.push(['Windows default', 'yes'])
  if (f) {
    bits.push(['Format', `${f.sampleRate / 1000} kHz, ${f.bits}-bit`])
    bits.push(['Channels', f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : String(f.channels)])
  }
  bits.push(['Muted', d.muted ? 'yes' : 'no'])
  chips.replaceChildren(...bits.map(([k, v]) => h('span', { class: 'chip' }, k + ': ', h('b', { text: v }))))
  const active = document.activeElement && document.activeElement.id
  if (active !== 'level') {
    $('level').value = d.volume == null ? 100 : d.volume
    $('level-out').textContent = $('level').value + '%'
    fill($('level'))
  }
  if (active !== 'gain') {
    $('gain').value = gainFor(d)
    $('gain-out').textContent = $('gain').value + '%'
    fill($('gain'))
  }
  $('listen-on').checked = Boolean(d.listen)
  $('sysfx-on').checked = d.sysfx !== false
}

function renderBoard() {
  const sounds = state.settings.sounds
  $('sound-count').textContent = sounds.length
  $('board-volume').value = state.settings.boardVolume
  $('board-volume-out').textContent = state.settings.boardVolume + '%'
  fill($('board-volume'))
  const add = h(
    'button',
    { class: 'tile add', type: 'button', title: 'Add Sound', disabled: sounds.length >= 40, onclick: addSounds },
    h('span', { class: 'plus' }),
    h('span', { class: 'name', text: 'Add Sound' })
  )
  add.querySelector('.plus').innerHTML = icon('plus', 34)
  const tiles = sounds.map(s => {
    const tile = h(
      'div',
      { class: 'tile' + (engine.playing.has(s.id) ? ' playing' : ''), role: 'button', tabindex: '0', 'data-id': s.id, onclick: () => playSound(s) },
      h('span', { class: 'play' }),
      h('span', { class: 'name', text: s.name }),
      h('button', {
        class: 'remove',
        type: 'button',
        title: 'Remove',
        'aria-label': 'Remove ' + s.name,
        onclick: e => {
          e.stopPropagation()
          removeSound(s)
        }
      })
    )
    tile.querySelector('.play').innerHTML = icon(engine.playing.has(s.id) ? 'stop' : 'play', 18)
    tile.querySelector('.remove').innerHTML = icon('x', 14)
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        playSound(s)
      }
    })
    return tile
  })
  $('sound-grid').replaceChildren(add, ...tiles)
}

function renderSettings() {
  $('set-autostart').checked = state.settings.autoStart
  $('set-tray').checked = state.settings.closeToTray
  $('version').textContent = 'Vesper Audio ' + state.info.version + (state.driver && state.driver.running ? '  |  Vesper Audio Cable running' : '')
}

function renderAll() {
  renderDevices()
  renderHome()
  renderProps()
  renderBoard()
  renderSettings()
  renderDriverNotice()
}

function renderDriverNotice() {
  const d = state.driver
  if (vacOut() && vacIn()) return notice('driver', null)
  if (d && d.nodePresent && !d.running) {
    return notice('driver', {
      text: d.testSigning ? 'Vesper Audio Cable is installed but not running yet. Restart Windows to finish setup.' : 'Vesper Audio Cable is installed but Windows is blocking the unsigned driver. Test Mode is off.',
      label: 'Fix',
      action: () => installDriver()
    })
  }
  notice('driver', { text: 'Vesper Audio Cable is not installed. Other apps cannot hear Vesper Audio until it is.', label: 'Install', action: () => installDriver() })
}

async function refreshDevices() {
  try {
    state.devices = await api.invoke('devices:list')
  } catch (err) {
    notice('devices', { text: 'Could not read Windows audio devices: ' + err.message })
    return
  }
  notice('devices', null)
  renderAll()
}

function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m.hidden = true
}

function bindMenus() {
  for (const sel of document.querySelectorAll('.select')) {
    sel.querySelector('.select-btn').addEventListener('click', e => {
      e.stopPropagation()
      const menu = sel.querySelector('.menu')
      const was = menu.hidden
      closeMenus()
      menu.hidden = !was
    })
  }
  document.addEventListener('click', closeMenus)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenus()
  })
}

async function ensureSpeaker() {
  if (state.speaker) return state.speaker
  if (!state.speakerLoading) {
    state.speakerLoading = (async () => {
      const url = await api.invoke('model:ensure', 'speaker')
      state.speaker = await loadSpeaker(url)
      return state.speaker
    })().finally(() => (state.speakerLoading = null))
  }
  return state.speakerLoading
}

async function enroll() {
  const input = currentInput()
  if (!input) {
    dialog({ title: 'No microphone', body: h('p', { text: 'Pick an input device first.' }), actions: [{ label: 'Close', onClick: closeDialog }] })
    return false
  }
  const bar = h('i')
  const info = h('p', { class: 'muted', text: 'Downloading the voice model. This happens once.' })
  const off = api.on('model:progress', p => (bar.style.width = Math.round(p.value * 100) + '%'))
  dialog({ title: 'Preparing voice recognition', body: [info, h('div', { class: 'progress' }, bar)], actions: [] })
  try {
    await ensureSpeaker()
  } catch (err) {
    off()
    dialog({ title: 'Voice model unavailable', body: h('p', { class: 'error', text: err.message }), actions: [{ label: 'Close', onClick: closeDialog }] })
    return false
  }
  off()
  await engine.apply({ ...engineConfig(), ai: true, aiPreset: 'custom', basic: false, voiceprint: null, monitor: false })
  if (!engine.ctx) {
    dialog({ title: 'Microphone unavailable', body: h('p', { class: 'error', text: engine.state.error || 'The audio engine could not start.' }), actions: [{ label: 'Close', onClick: closeDialog }] })
    return false
  }
  return new Promise(resolve => {
    const words = PARAGRAPH.split(' ').map(w => h('span', { text: w + ' ' }))
    const progress = h('i')
    const status = h('p', { class: 'muted', text: 'Press Start, then read the paragraph below at your normal speaking volume.' })
    let enroller = null
    const finish = async ok => {
      if (enroller) enroller.cancel()
      enroller = null
      closeDialog()
      await sync()
      resolve(ok)
    }
    const begin = () => {
      enroller = new Enroller(engine.ctx, engine.fxOut, seconds => {
        const total = SPEECH_TARGET + LAUGH_TARGET
        progress.style.width = Math.min(100, (seconds / total) * 100) + '%'
        const read = Math.floor((Math.min(seconds, SPEECH_TARGET) / SPEECH_TARGET) * words.length)
        words.forEach((w, i) => w.classList.toggle('done', i < read))
        if (seconds >= SPEECH_TARGET && seconds < total) status.textContent = 'Now laugh out loud for a few seconds.'
        if (seconds >= total) complete()
      })
      $('dlg-actions').replaceChildren(h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => finish(false) }))
      status.textContent = 'Listening. Keep reading.'
    }
    const complete = async () => {
      if (!enroller) return
      const e = enroller
      enroller = null
      status.textContent = 'Learning your voice'
      $('dlg-actions').replaceChildren()
      try {
        const print = await e.finish(state.speaker)
        await save({ voiceprint: print, ai: true, aiPreset: 'custom', basic: false })
        renderAll()
        closeDialog()
        sync()
        resolve(true)
      } catch (err) {
        status.textContent = err.message
        status.className = 'error'
        $('dlg-actions').replaceChildren(
          h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finish(false) }),
          h('button', { class: 'btn primary', type: 'button', text: 'Try again', onclick: () => finish(false).then(() => enroll()) })
        )
      }
    }
    dialog({
      title: 'Teach Vesper your voice',
      body: [status, h('div', { class: 'paragraph' }, words), h('div', { class: 'progress' }, progress)],
      actions: [
        { label: 'Cancel', onClick: () => finish(false) },
        { label: 'Start', primary: true, onClick: begin }
      ]
    })
  })
}

async function installDriver() {
  const status = await api.invoke('driver:status').catch(() => null)
  state.driver = status
  const lines = [
    h('p', { text: 'Vesper Audio Cable is the virtual microphone other apps will hear. It is downloaded from the Vesper Audio release and installed with administrator approval.' })
  ]
  if (status && !status.testSigning) {
    lines.push(
      h('p', {
        class: status.secureBoot ? 'error' : 'muted',
        text: status.secureBoot
          ? 'Secure Boot is on, so Windows will refuse to load the unsigned driver. Turn Secure Boot off in your firmware settings, then install again.'
          : 'The driver is unsigned, so Windows Test Mode will be switched on and a restart is needed.'
      })
    )
  }
  const bar = h('i')
  const text = h('p', { class: 'muted' })
  const run = async () => {
    $('dlg-actions').replaceChildren()
    const off = api.on('driver:progress', p => {
      bar.style.width = Math.round(p.value * 100) + '%'
      text.textContent = p.text
    })
    $('dlg-body').replaceChildren(text, h('div', { class: 'progress' }, bar))
    try {
      const result = await api.invoke('driver:install')
      off()
      await save({ setupDone: true })
      $('dlg-title').textContent = result.rebootRequired ? 'Restart Windows to finish' : 'Vesper Audio Cable installed'
      $('dlg-body').replaceChildren(h('p', { text: result.rebootRequired ? 'The driver is installed. Windows needs a restart before Vesper Audio Cable appears.' : 'Vesper Audio Cable is ready.' }))
    } catch (err) {
      off()
      $('dlg-title').textContent = 'Driver setup failed'
      $('dlg-body').replaceChildren(h('p', { class: 'error', text: err.message }))
    }
    $('dlg-actions').replaceChildren(h('button', { class: 'btn primary', type: 'button', text: 'Close', onclick: closeDialog }))
    await refreshDevices()
    state.driver = await api.invoke('driver:status').catch(() => null)
    renderAll()
    sync()
  }
  dialog({
    title: 'Install Vesper Audio Cable',
    body: lines,
    actions: [
      {
        label: 'Later',
        onClick: async () => {
          await save({ setupDone: true })
          closeDialog()
        }
      },
      { label: 'Download and install', primary: true, onClick: run }
    ]
  })
}

async function playSound(s) {
  try {
    await engine.toggleSound(s.id, `vesper://sounds/${s.id}.mp3`, s.volume)
  } catch (err) {
    notice('sound', { text: 'Could not play sound: ' + err.message })
    setTimeout(() => notice('sound', null), 4000)
  }
  renderBoard()
}

async function addSounds() {
  const sounds = await api.invoke('sounds:add')
  state.settings.sounds = sounds
  renderBoard()
}

async function removeSound(s) {
  engine.forget(s.id)
  state.settings.sounds = await api.invoke('sounds:remove', s.id)
  renderBoard()
}

function bindControls() {
  for (const btn of document.querySelectorAll('.nav')) btn.addEventListener('click', () => setPage(btn.dataset.page))

  $('ai-on').addEventListener('change', async e => {
    const on = e.target.checked
    if (on && state.settings.aiPreset === 'custom' && !state.settings.voiceprint) {
      await save({ ai: true, basic: false })
      const ok = await enroll()
      if (!ok) await save({ ai: false })
    } else {
      await save({ ai: on, basic: on ? false : state.settings.basic })
    }
    renderHome()
    sync()
  })
  $('basic-on').addEventListener('change', async e => {
    await save({ basic: e.target.checked })
    renderHome()
    sync()
  })
  $('monitor-on').addEventListener('change', async e => {
    await save({ monitor: e.target.checked })
    sync()
  })
  $('ai-strength').addEventListener('input', async e => {
    fill(e.target)
    $('ai-strength-out').textContent = e.target.value + '%'
    await save({ aiStrength: Number(e.target.value) })
    sync()
  })
  $('speex-db').addEventListener('input', async e => {
    fill(e.target)
    $('speex-db-out').textContent = e.target.value + ' dB'
    await save({ speexDb: Number(e.target.value) })
    sync()
  })
  $('voice-enroll').addEventListener('click', async () => {
    const ok = await enroll()
    if (ok) renderAll()
  })

  let levelTimer = null
  $('level').addEventListener('input', e => {
    fill(e.target)
    $('level-out').textContent = e.target.value + '%'
    const d = currentInput()
    if (!d) return
    d.volume = Number(e.target.value)
    clearTimeout(levelTimer)
    levelTimer = setTimeout(() => api.invoke('device:volume', d.id, d.volume).catch(err => notice('props', { text: err.message })), 40)
  })
  $('gain').addEventListener('input', async e => {
    fill(e.target)
    $('gain-out').textContent = e.target.value + '%'
    const d = currentInput()
    if (!d) return
    await save({ gains: { ...state.settings.gains, [d.name]: Number(e.target.value) } })
    sync()
  })
  $('listen-on').addEventListener('change', async e => {
    const d = currentInput()
    if (!d) return
    try {
      await api.invoke('device:listen', d.id, e.target.checked)
      notice('props', null)
    } catch (err) {
      notice('props', { text: 'Windows would not change Listen to this device: ' + err.message })
    }
    await refreshDevices()
  })
  $('sysfx-on').addEventListener('change', async e => {
    const d = currentInput()
    if (!d) return
    try {
      await api.invoke('device:sysfx', d.id, e.target.checked)
      notice('props', null)
    } catch (err) {
      notice('props', { text: 'Windows would not change audio enhancements: ' + err.message })
    }
    await refreshDevices()
  })

  $('board-volume').addEventListener('input', async e => {
    fill(e.target)
    $('board-volume-out').textContent = e.target.value + '%'
    await save({ boardVolume: Number(e.target.value) })
    sync()
  })

  $('set-autostart').addEventListener('change', e => save({ autoStart: e.target.checked }))
  $('set-tray').addEventListener('change', e => save({ closeToTray: e.target.checked }))
  $('set-driver').addEventListener('click', () => installDriver())
  $('set-voice').addEventListener('click', async () => {
    const ok = await enroll()
    if (ok) renderAll()
  })
  $('set-repo').addEventListener('click', () => api.invoke('app:repo'))
}

function meters() {
  $('meter-home').style.width = Math.round(engine.outLevel() * 100) + '%'
  $('meter-props').style.width = Math.round(engine.level() * 100) + '%'
  requestAnimationFrame(meters)
}

async function boot() {
  hydrate()
  state.info = await api.invoke('app:info')
  state.settings = await api.invoke('settings:get')
  bindMenus()
  bindControls()
  engine.onSoundEnd = () => renderBoard()
  engine.onVoiceState = s => (state.voice = s)
  if (state.info.testMode) window.__vesper = { engine, state, api, enroll, installDriver, save, sync, refreshDevices }
  await refreshDevices()
  state.driver = await api.invoke('driver:status').catch(() => null)
  renderAll()
  sync()
  meters()
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices()
    sync()
  })
  setInterval(() => {
    if (!document.hidden) refreshDevices()
  }, 4000)
  api.on('app:shown', refreshDevices)
  if (!state.settings.setupDone && !(vacOut() && vacIn())) installDriver()
}

boot().catch(err => {
  api.invoke('app:log', 'boot failed: ' + (err && err.stack ? err.stack : err))
  notice('boot', { text: 'Vesper Audio failed to start: ' + err.message })
})
