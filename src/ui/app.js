import { hydrate, icon } from './icons.js'
import { Engine } from './engine.js'
import { Enroller, loadSpeaker, buildPrint, pcmToBytes, bytesToPcm, MIN_SPEECH_SECONDS } from './voice.js'

const api = window.vesper
const $ = id => document.getElementById(id)
const engine = new Engine()

const PARAGRAPHS = {
  en: {
    label: 'English',
    text: 'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow.'
  },
  hi: {
    label: 'हिन्दी',
    text: 'भारत एक विशाल और विविधताओं से भरा हुआ देश है। यहाँ हर कुछ किलोमीटर पर बोली, खान-पान और पहनावा बदल जाता है। सुबह की ठंडी हवा में चाय की खुशबू फैल जाती है और गलियों में बच्चों की हँसी गूँजने लगती है। पहाड़ों से लेकर समंदर तक, हर जगह की अपनी एक अलग कहानी है। लोग मिल-जुलकर त्योहार मनाते हैं, एक-दूसरे की मदद करते हैं और नई उम्मीदों के साथ आगे बढ़ते हैं। जब कोई अपने सपनों के पीछे चलता है, तो पूरी दुनिया उसके लिए रास्ता बना देती है।'
  }
}
const PRESET_LABEL = { custom: 'Custom', heavy: 'Custom Heavy', clearcast: 'ClearCast' }
const SPEECH_TARGET = 30
const LAUGH_TARGET = 4
const NVIDIA = 0x10de
const MIN_VRAM_MB = 2048

const state = {
  settings: null,
  devices: [],
  driver: null,
  speakers: {},
  speakerLoading: {},
  gpus: [],
  heavyUrl: '',
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

const tierOf = () => (state.settings.aiPreset === 'heavy' ? 'heavy' : 'small')

function engineConfig() {
  const s = state.settings
  const input = currentInput()
  const tier = tierOf()
  const loaded = state.speakers[tier]
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
    voiceprint: s.voiceprints[tier] || null,
    speaker: loaded ? loaded.speaker : null,
    heavyDenoiserUrl: state.heavyUrl
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
      await prepare()
      await engine.apply(engineConfig())
      notice('engine', engine.state.error ? { text: 'Audio engine: ' + engine.state.error } : null)
      notice('engineWarn', engine.state.warning ? { text: engine.state.warning } : null)
    } finally {
      waiters.forEach(resolve => resolve())
    }
  }, 60)
  return done
}

async function prepare() {
  const s = state.settings
  if (!s.ai || s.aiPreset === 'clearcast') return
  try {
    if (s.aiPreset === 'heavy' && !state.heavyUrl) {
      notice('voice', { text: 'Downloading the Heavy denoiser' })
      state.heavyUrl = await api.invoke('model:ensure', 'denoiserHeavy')
    }
    if (s.voiceSamples.length) {
      const tier = tierOf()
      notice('voice', { text: 'Preparing your voice model' })
      await ensureSpeaker(tier)
      if (!s.voiceprints[tier]) await rebuildPrint(tier)
    }
  } catch (err) {
    notice('voice', { text: 'Voice model unavailable: ' + err.message })
    return
  }
  notice('voice', null)
}

async function gpuVendor() {
  if (!navigator.gpu) return ''
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  return adapter && adapter.info ? adapter.info.vendor : ''
}

const gpuInfo = () => state.gpus.filter(g => g.vendorId === NVIDIA).sort((a, b) => b.vramMb - a.vramMb)[0] || null
const gpuQualifies = () => {
  const g = gpuInfo()
  return Boolean(g && g.vramMb > MIN_VRAM_MB)
}

async function ensureSpeaker(tier) {
  if (state.speakers[tier]) return state.speakers[tier].speaker
  if (!state.speakerLoading[tier]) {
    state.speakerLoading[tier] = (async () => {
      if (tier === 'heavy') {
        try {
          if ((await gpuVendor()) !== 'nvidia') throw new Error('the NVIDIA graphics card is not active yet, restart Vesper Audio')
          const speaker = await loadSpeaker(await api.invoke('model:ensure', 'speakerHeavy'), 'webgpu')
          state.speakers.heavy = { speaker }
          return speaker
        } catch (err) {
          notice('heavy', { text: 'Heavy voice model could not use the graphics card (' + err.message + '). Using the standard voice model.' })
        }
      }
      const speaker = await loadSpeaker(await api.invoke('model:ensure', 'speakerSmall'), 'wasm')
      state.speakers[tier] = { speaker }
      return speaker
    })().finally(() => (state.speakerLoading[tier] = null))
  }
  return state.speakerLoading[tier]
}

async function rebuildPrint(tier, onProgress) {
  const speaker = await ensureSpeaker(tier)
  const samples = await api.invoke('voice:load')
  const progress = onProgress || (p => notice('voice', { text: 'Learning your voice ' + Math.round(p * 100) + '%' }))
  const print = await buildPrint(speaker, samples.map(x => bytesToPcm(x.bytes)), progress)
  state.settings.voiceprints = { ...state.settings.voiceprints, [tier]: print }
  await save({ voiceprints: state.settings.voiceprints })
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

function voiceSummary() {
  const samples = state.settings.voiceSamples
  if (!samples.length) return 'No voice recorded yet. Record the paragraph once to enable Custom.'
  const langs = [...new Set(samples.map(x => (PARAGRAPHS[x.language] ? PARAGRAPHS[x.language].label : x.language)))]
  const seconds = Math.round(samples.reduce((n, x) => n + x.seconds, 0))
  return `Your voice is saved (${langs.join(' and ')}, ${seconds} s). Custom is best and needs no slider.`
}

async function pickPreset(v) {
  closeMenus()
  if (v === 'heavy') return chooseHeavy()
  await save({ aiPreset: v })
  renderHome()
  if (v === 'custom' && state.settings.ai && !state.settings.voiceSamples.length) await enroll()
  sync()
}

function renderHome() {
  const s = state.settings
  $('ai-on').checked = s.ai
  $('basic-on').checked = s.basic && !s.ai
  $('basic-on').disabled = s.ai
  $('basic-hint').hidden = !s.ai
  $('monitor-on').checked = s.monitor
  $('ai-preset-text').textContent = PRESET_LABEL[s.aiPreset] || 'Custom'
  menuItems(
    document.querySelector('[data-select="ai-preset"] .menu'),
    [
      { value: 'custom', label: 'Custom', tag: 'light', small: 'Speak a paragraph once and the AI learns your voice. It keeps your voice and laughs and drops everything else. About 16 MB, runs on the CPU.' },
      { value: 'heavy', label: 'Custom Heavy', tag: 'NVIDIA GPU', small: 'Larger models and a graphics card voice lock for the most accurate result. For PCs with an NVIDIA graphics card above 2 GB VRAM. About 130 MB.' },
      { value: 'clearcast', label: 'ClearCast', small: 'Studio-grade AI speech cleanup in the style of SteelSeries Sonar. Strength is adjustable.' }
    ],
    s.aiPreset,
    pickPreset
  )
  $('ai-custom-note').hidden = s.aiPreset === 'clearcast'
  $('ai-strength-row').hidden = s.aiPreset !== 'clearcast'
  $('ai-strength').value = s.aiStrength
  $('ai-strength-out').textContent = s.aiStrength + '%'
  fill($('ai-strength'))
  $('voice-status').textContent = voiceSummary()
  $('voice-enroll').textContent = s.voiceSamples.length ? 'Re-record' : 'Record voice'
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

const pendingReboot = () => state.settings.pendingReboot && state.settings.pendingReboot > Date.now() - state.info.uptime * 1000

function renderDriverNotice() {
  const d = state.driver
  if (vacOut() && vacIn()) return notice('driver', null)
  if (pendingReboot()) {
    return notice('driver', { text: 'Vesper Audio Cable is installed. Restart Windows to finish setup.', label: 'Restart', action: () => restartDialog() })
  }
  if (d && d.secureBoot && !d.testSigning) {
    return notice('driver', { text: 'Secure Boot is on, so Windows will not load the Vesper Audio Cable driver.', label: 'Show steps', action: () => secureBootDialog() })
  }
  if (d && d.nodePresent && !d.running) {
    return notice('driver', { text: `Vesper Audio Cable is installed but Windows could not start it (code ${d.problem}).`, label: 'Fix', action: () => installDriver() })
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

async function chooseHeavy() {
  const g = gpuInfo()
  const ok = gpuQualifies()
  const detected = g ? `${g.name}, ${(g.vramMb / 1024).toFixed(1)} GB VRAM` : 'No NVIDIA graphics card was detected on this PC.'
  return new Promise(resolve => {
    const finish = value => {
      closeDialog()
      resolve(value)
    }
    const enable = async () => {
      const bar = h('i')
      const text = h('p', { class: 'muted', text: 'Downloading the Heavy models. This happens once.' })
      const off = api.on('model:progress', p => (bar.style.width = Math.round(p.value * 100) + '%'))
      $('dlg-body').replaceChildren(text, h('div', { class: 'progress' }, bar))
      $('dlg-actions').replaceChildren()
      try {
        state.heavyUrl = await api.invoke('model:ensure', 'denoiserHeavy')
        bar.style.width = '0%'
        await api.invoke('model:ensure', 'speakerHeavy')
      } catch (err) {
        off()
        $('dlg-title').textContent = 'Heavy models could not be downloaded'
        $('dlg-body').replaceChildren(h('p', { class: 'error', text: err.message }))
        $('dlg-actions').replaceChildren(h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => finish(false) }))
        return
      }
      off()
      await save({ aiPreset: 'heavy', ai: true, basic: false })
      if ((await gpuVendor()) !== 'nvidia') {
        $('dlg-title').textContent = 'Restart to use your NVIDIA graphics card'
        $('dlg-body').replaceChildren(h('p', { text: 'Vesper Audio has to restart once so Windows runs it on the NVIDIA graphics card. Your settings are saved.' }))
        $('dlg-actions').replaceChildren(
          h('button', { class: 'btn', type: 'button', text: 'Later', onclick: () => finish(true) }),
          h('button', { class: 'btn primary', type: 'button', text: 'Restart now', onclick: () => api.invoke('app:relaunch') })
        )
        return
      }
      finish(true)
      renderAll()
      if (!state.settings.voiceSamples.length) await enroll()
      sync()
    }
    dialog({
      title: 'Custom Heavy',
      body: [
        h('p', { text: 'Custom Heavy uses larger AI models and runs the voice lock on your graphics card for the most accurate result. It is made for PCs with an NVIDIA graphics card that has more than 2 GB of VRAM.' }),
        h('p', { class: ok ? 'ok' : 'error', text: ok ? 'Detected: ' + detected : g ? detected + ' Heavy needs more than 2 GB.' : detected }),
        h('p', { class: 'muted', text: 'About 130 MB is downloaded once.' })
      ],
      actions: [
        { label: 'Cancel', onClick: () => finish(false) },
        { label: 'Enable Heavy', primary: true, disabled: !ok, onClick: enable }
      ]
    })
  })
}

async function enroll() {
  const input = currentInput()
  if (!input) {
    dialog({ title: 'No microphone', body: h('p', { text: 'Pick an input device first.' }), actions: [{ label: 'Close', onClick: closeDialog }] })
    return false
  }
  const bar = h('i')
  const info = h('p', { class: 'muted', text: 'Preparing the voice model. A download happens the first time only.' })
  const off = api.on('model:progress', p => (bar.style.width = Math.round(p.value * 100) + '%'))
  dialog({ title: 'Preparing voice recognition', body: [info, h('div', { class: 'progress' }, bar)], actions: [] })
  try {
    await ensureSpeaker(tierOf())
  } catch (err) {
    off()
    dialog({ title: 'Voice model unavailable', body: h('p', { class: 'error', text: err.message }), actions: [{ label: 'Close', onClick: closeDialog }] })
    return false
  }
  off()
  await engine.apply({ ...engineConfig(), ai: true, aiPreset: 'custom', basic: false, voiceprint: null, speaker: null, monitor: false })
  if (!engine.ctx) {
    dialog({ title: 'Microphone unavailable', body: h('p', { class: 'error', text: engine.state.error || 'The audio engine could not start.' }), actions: [{ label: 'Close', onClick: closeDialog }] })
    return false
  }
  return new Promise(resolve => {
    const total = SPEECH_TARGET + LAUGH_TARGET
    const hasSaved = state.settings.voiceSamples.length > 0
    let language = navigator.language && navigator.language.toLowerCase().startsWith('hi') ? 'hi' : 'en'
    let enroller = null
    let spoken = 0
    const status = h('p', { class: 'muted', text: 'Pick a language, press Start, then read the whole paragraph at your normal speaking volume.' })
    const paragraph = h('div', { class: 'paragraph' })
    const progress = h('i')
    const clock = h('span', { class: 'muted', text: '0 s' })
    const add = h('input', { type: 'checkbox', id: 'enroll-add' })
    const tabs = h('div', { class: 'tabs', role: 'tablist' })
    const words = () => [...paragraph.children]
    const drawParagraph = () => {
      paragraph.replaceChildren(...PARAGRAPHS[language].text.split(' ').map(w => h('span', { text: w + ' ', lang: language })))
      for (const t of tabs.children) t.classList.toggle('active', t.dataset.lang === language)
    }
    for (const [key, p] of Object.entries(PARAGRAPHS)) {
      tabs.append(
        h('button', {
          class: 'tab',
          type: 'button',
          role: 'tab',
          'data-lang': key,
          text: p.label,
          onclick: () => {
            if (enroller) return
            language = key
            drawParagraph()
          }
        })
      )
    }
    const close = ok => {
      if (enroller) enroller.stop()
      enroller = null
      closeDialog()
      sync().then(() => resolve(ok))
    }
    let finishNow = null
    const begin = () => {
      enroller = new Enroller(engine.ctx, engine.fxOut, update)
      status.textContent = 'Listening. Read the whole paragraph, then laugh when asked. You can press Stop once you have spoken for ' + MIN_SPEECH_SECONDS + ' seconds.'
      buttons('recording')
    }
    const buttons = mode => {
      const list = [h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => close(false) })]
      if (mode === 'ready') list.push(h('button', { class: 'btn primary', type: 'button', text: 'Start', onclick: begin }))
      if (mode === 'recording') list.push(h('button', { class: 'btn primary', type: 'button', id: 'enroll-stop', text: `Stop (needs ${MIN_SPEECH_SECONDS} s)`, disabled: true, onclick: () => finishNow() }))
      $('dlg-actions').replaceChildren(...list)
    }
    const update = seconds => {
      spoken = seconds
      progress.style.width = Math.min(100, (seconds / total) * 100) + '%'
      clock.textContent = Math.round(seconds) + ' s'
      const read = Math.floor((Math.min(seconds, SPEECH_TARGET) / SPEECH_TARGET) * words().length)
      words().forEach((w, i) => w.classList.toggle('done', i < read))
      const stop = $('enroll-stop')
      if (stop && seconds >= MIN_SPEECH_SECONDS) {
        stop.disabled = false
        stop.textContent = 'Stop'
      }
      if (seconds >= SPEECH_TARGET && seconds < total) status.textContent = 'Now laugh out loud for a few seconds.'
      if (seconds >= total) finishNow()
    }
    finishNow = async () => {
      if (!enroller) return
      const audio = enroller.stop()
      enroller = null
      status.className = 'muted'
      status.textContent = 'Learning your voice'
      $('dlg-actions').replaceChildren()
      try {
        state.settings.voiceSamples = await api.invoke('voice:save', pcmToBytes(audio), { replace: !(hasSaved && add.checked), language, seconds: spoken })
        state.settings.voiceprints = {}
        await rebuildPrint(tierOf(), p => (status.textContent = 'Learning your voice ' + Math.round(p * 100) + '%'))
        await save({ ai: true, aiPreset: state.settings.aiPreset === 'clearcast' ? 'custom' : state.settings.aiPreset, basic: false })
        renderAll()
        close(true)
      } catch (err) {
        status.className = 'error'
        status.textContent = err.message
        $('dlg-actions').replaceChildren(
          h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => close(false) }),
          h('button', {
            class: 'btn primary',
            type: 'button',
            text: 'Try again',
            onclick: () => {
              drawParagraph()
              update(0)
              status.className = 'muted'
              status.textContent = 'Press Start when you are ready.'
              buttons('ready')
            }
          })
        )
      }
    }
    dialog({
      title: 'Teach Vesper your voice',
      body: [
        tabs,
        status,
        paragraph,
        h('div', { class: 'progress' }, progress),
        h('div', { class: 'row' }, clock, hasSaved ? h('label', { class: 'inline-check' }, add, h('span', { text: 'Add to my saved voice instead of replacing it' })) : h('span')),
        h('p', { class: 'hint', text: 'Your recording stays on this PC. It is only used to recognise your voice.' })
      ],
      actions: []
    })
    drawParagraph()
    buttons('ready')
  })
}

async function refreshDriver() {
  state.driver = await api.invoke('driver:status').catch(() => null)
  return state.driver
}

async function waitForCable(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    await refreshDevices()
    if (vacOut() && vacIn()) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

function steps(items) {
  return h('ol', { class: 'steps' }, items.map(t => h('li', { text: t })))
}

function secureBootDialog() {
  dialog({
    title: 'Turn off Secure Boot',
    body: [
      h('p', { text: 'Vesper Audio Cable is an unsigned driver. Windows only loads unsigned drivers when Secure Boot is off and Test Mode is on. Vesper Audio switches Test Mode on for you, but Secure Boot can only be changed in your PC firmware.' }),
      steps([
        'Save your work and close other apps.',
        'Open Settings, System, Recovery, then press Restart now next to Advanced startup.',
        'Choose Troubleshoot, Advanced options, UEFI Firmware Settings, then Restart.',
        'In the firmware menu open the Security or Boot tab and set Secure Boot to Disabled.',
        'Save and exit. Windows starts normally.',
        'Open Vesper Audio and press Install again. Windows will ask for permission once.'
      ]),
      h('p', { class: 'hint', text: 'Some online games with kernel anti-cheat refuse to start while Secure Boot is off. Turn it back on when you do not need the Vesper Audio Cable.' })
    ],
    actions: [
      { label: 'Close', onClick: closeDialog },
      { label: 'Open recovery settings', onClick: () => api.invoke('app:settings') },
      {
        label: 'I turned it off, check again',
        primary: true,
        onClick: async () => {
          closeDialog()
          await refreshDriver()
          renderAll()
          if (!(state.driver && state.driver.secureBoot && !state.driver.testSigning)) installDriver()
        }
      }
    ]
  })
}

function restartDialog() {
  dialog({
    title: 'Restart Windows',
    body: [h('p', { text: 'Windows needs a restart before Vesper Audio Cable can start. Save your work first. Windows restarts about 15 seconds after you press Restart.' })],
    actions: [
      { label: 'Not now', onClick: closeDialog },
      {
        label: 'Restart',
        primary: true,
        onClick: async () => {
          await api.invoke('system:restart', false)
          $('dlg-body').replaceChildren(h('p', { text: 'Restarting in 15 seconds.' }))
          $('dlg-actions').replaceChildren(
            h('button', {
              class: 'btn',
              type: 'button',
              text: 'Cancel restart',
              onclick: async () => {
                await api.invoke('system:restart', true)
                closeDialog()
              }
            })
          )
        }
      }
    ]
  })
}

const PROBLEMS = {
  52: 'Windows could not verify the driver signature. Test Mode must be on and Secure Boot off.',
  10: 'The driver could not start.',
  31: 'The driver is not working properly.',
  37: 'The driver returned a failure while starting.',
  39: 'The driver file is missing or corrupt.'
}

async function installDriver() {
  const status = await refreshDriver()
  if (status && status.secureBoot && !status.testSigning) return secureBootDialog()
  const bar = h('i')
  const text = h('p', { class: 'muted' })
  const finishDialog = (title, body, actions) => {
    $('dlg-title').textContent = title
    $('dlg-body').replaceChildren(...[].concat(body))
    $('dlg-actions').replaceChildren(...actions)
  }
  const closeButton = h('button', { class: 'btn primary', type: 'button', text: 'Close', onclick: closeDialog })
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
      text.textContent = 'Checking that Windows started the driver'
      if (await waitForCable(12000)) {
        await save({ pendingReboot: 0 })
        finishDialog('Vesper Audio Cable is ready', h('p', { text: 'Windows started the driver and the virtual microphone is available. No restart is needed.' }), [closeButton])
      } else if (result.rebootRequired) {
        await save({ pendingReboot: Date.now() })
        finishDialog('Restart Windows to finish', h('p', { text: 'The driver is installed. Windows only starts it after a restart because Test Mode was just switched on.' }), [
          h('button', { class: 'btn', type: 'button', text: 'Later', onclick: closeDialog }),
          h('button', { class: 'btn primary', type: 'button', text: 'Restart', onclick: restartDialog })
        ])
      } else {
        const now = await refreshDriver()
        const code = now && now.problem != null ? now.problem : null
        finishDialog(
          'Windows did not start the driver',
          [
            h('p', { class: 'error', text: code != null ? `Device problem code ${code}. ${PROBLEMS[code] || ''}` : 'The driver was installed but no device was created.' }),
            steps(['Make sure Secure Boot is off in your PC firmware.', 'Press Re-init and Setup in Settings to install again.', 'Restart Windows if the problem stays.'])
          ],
          [closeButton]
        )
      }
    } catch (err) {
      off()
      finishDialog('Driver setup failed', h('p', { class: 'error', text: err.message }), [closeButton])
    }
    await refreshDevices()
    await refreshDriver()
    renderAll()
    sync()
  }
  const note = status && !status.testSigning ? 'The driver is unsigned, so Windows Test Mode is switched on and a restart may be needed.' : 'Windows asks for permission once.'
  dialog({
    title: vacOut() && vacIn() ? 'Reinstall Vesper Audio Cable' : 'Install Vesper Audio Cable',
    body: [h('p', { text: 'Vesper Audio Cable is the virtual microphone other apps will hear. It is downloaded from the Vesper Audio release and installed with administrator approval.' }), h('p', { class: 'muted', text: note })],
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
    if (on && state.settings.aiPreset !== 'clearcast' && !state.settings.voiceSamples.length) {
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
  state.gpus = await api.invoke('system:gpus').catch(() => [])
  if (state.settings.aiPreset === 'heavy' && !gpuQualifies()) {
    await save({ aiPreset: 'custom' })
    notice('heavy', { text: 'Custom Heavy needs an NVIDIA graphics card with more than 2 GB of VRAM. Vesper Audio is using Custom instead.' })
  }
  bindMenus()
  bindControls()
  engine.onSoundEnd = () => renderBoard()
  engine.onVoiceState = s => (state.voice = s)
  if (state.info.testMode) window.__vesper = { engine, state, api, enroll, installDriver, save, sync, refreshDevices, config: engineConfig, ensureSpeaker, rebuildPrint, tierOf }
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
