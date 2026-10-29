import { hydrate, icon } from './icons.js'
import { Engine } from './engine.js'
import { h, $ } from './dom.js'
import { Personal } from './personal.js'
import { Diag } from './diag.js'
import { Phones } from './phones.js'

const api = window.vesper
const engine = new Engine()
let personal = null
let diag = null
let phones = null

const PRESET_LABEL = { personal: 'Personal', clearcast: 'ClearCast' }
const GATE_HINT = 'Silences your microphone while you are quieter than the threshold.'
const BASIC_LABEL = { speex: 'Speex', speexzero: 'Speex zero latency', rnnoise: 'RNNoise' }

const state = {
  settings: null,
  devices: [],
  driver: null,
  devicesKey: '',
  denoiserUrl: '',
  notices: {},
  info: { version: '', testMode: false },
  busy: false,
  hidden: false,
  page: 'home'
}

const reason = err => String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

const inputs = () => state.devices.filter(d => d.flow === 'capture' && !d.vac)
const outputs = () => state.devices.filter(d => d.flow === 'render' && !d.vac)
const vacOut = () => state.devices.find(d => d.flow === 'render' && d.vac)
const vacIn = () => state.devices.find(d => d.flow === 'capture' && d.vac)

function currentInput() {
  const phone = phones && phones.input()
  if (phone) return phone
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
    input: input && input.phone ? { kind: 'phone', id: input.phoneId } : { kind: 'device', id: input ? input.id : '' },
    cableName: cableDevice() ? cableDevice().name : '',
    monitorName: monitorDevice() ? monitorDevice().name : '',
    gain: gainFor(input),
    ai: s.ai,
    aiPreset: s.aiPreset,
    aiStrength: s.aiStrength,
    basic: s.basic,
    basicPreset: s.basicPreset,
    speexDb: s.speexDb,
    gateOn: s.gateOn,
    gateDb: s.gateDb,
    normOn: s.normOn,
    quietDb: s.quietDb,
    loudDb: s.loudDb,
    monitor: s.monitor,
    boardVolume: s.boardVolume,
    personalUrl: personal ? personal.url() : '',
    denoiserUrl: state.denoiserUrl
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
      refreshEngineNotice()
    } finally {
      waiters.forEach(resolve => resolve())
    }
  }, 60)
  return done
}

function refreshEngineNotice() {
  notice('engine', engine.state.error ? { text: 'Audio engine: ' + engine.state.error } : null)
  notice('engineWarn', engine.state.warning ? { text: engine.state.warning } : null)
}

async function prepare() {
  const s = state.settings
  if (!s.ai || s.aiPreset !== 'clearcast' || state.denoiserUrl) return
  try {
    notice('voice', { text: 'Downloading the AI model' })
    state.denoiserUrl = await api.invoke('model:ensure', 'denoiser')
    notice('voice', null)
  } catch (err) {
    state.denoiserUrl = ''
    notice('voice', { text: 'The AI model could not be downloaded, using the built-in light model: ' + reason(err) })
  }
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

function signed(db) {
  return (db > 0 ? '+' : '') + db + ' dB'
}

function fill(el) {
  el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%')
}

function setPage(name) {
  state.page = name
  for (const el of document.querySelectorAll('.page')) el.classList.toggle('active', el.id === 'page-' + name)
  for (const el of document.querySelectorAll('.nav')) el.classList.toggle('active', el.dataset.page === name)
  if (name === 'properties' || name === 'home') refreshDevices()
  if ((name === 'display' || name === 'settings') && phones) phones.refreshSystem()
  if (name === 'display' && phones) phones.refresh().then(() => phones.newCode())
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
      [...list.map(d => ({ value: d.id, label: d.name, tag: d.isDefault ? 'default' : '' })), ...(phones ? phones.entries() : [])],
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

async function pickPreset(v) {
  closeMenus()
  await save({ aiPreset: v })
  renderHome()
  sync()
}

function renderHome() {
  const s = state.settings
  $('ai-on').checked = s.ai
  $('basic-on').checked = s.basic && !s.ai
  $('basic-on').disabled = s.ai
  $('basic-hint').hidden = !s.ai
  $('monitor-on').checked = s.monitor
  $('ai-preset-text').textContent = PRESET_LABEL[s.aiPreset] || 'Personal'
  menuItems(
    document.querySelector('[data-select="ai-preset"] .menu'),
    [
      { value: 'personal', label: 'Personal', tag: 'about 45 ms', small: 'A model that is fine-tuned on your own voice, on this PC. No lookahead, so it is the lowest delay a neural model allows. Works right away and gets better when you train it.' },
      { value: 'clearcast', label: 'ClearCast', small: 'Studio-grade AI speech cleanup. Best sound, but it adds about 90 ms of delay. Strength is adjustable.' }
    ],
    s.aiPreset,
    pickPreset
  )
  $('ai-custom-note').hidden = s.aiPreset === 'clearcast'
  $('ai-strength-row').hidden = s.aiPreset !== 'clearcast'
  $('ai-strength').value = s.aiStrength
  $('ai-strength-out').textContent = s.aiStrength + '%'
  fill($('ai-strength'))
  $('voice-status').textContent = personal.note()
  $('voice-enroll').textContent = personal.button()
  $('basic-preset-text').textContent = BASIC_LABEL[s.basicPreset] || 'RNNoise'
  menuItems(
    document.querySelector('[data-select="basic-preset"] .menu'),
    [
      { value: 'speex', label: 'Speex', small: 'Low CPU usage, low quality. Suppression Level from -60 dB (strongest) to 0 dB (off). Adds about 15 ms.' },
      { value: 'speexzero', label: 'Speex zero latency', tag: '0 ms', small: 'Applies Speex gains to your live voice with a minimum phase filter, so nothing is delayed. Slightly less precise at the start of words.' },
      { value: 'rnnoise', label: 'RNNoise', small: 'Good quality, more CPU usage. Adds about 20 ms.' }
    ],
    s.basicPreset,
    async v => {
      closeMenus()
      await save({ basicPreset: v })
      renderHome()
      sync()
    }
  )
  $('basic-sub').hidden = s.basicPreset !== 'speex' && s.basicPreset !== 'speexzero'
  $('speex-db').value = s.speexDb
  $('speex-db-out').textContent = s.speexDb + ' dB'
  fill($('speex-db'))
  $('gate-on').checked = s.gateOn
  $('gate-sub').hidden = !s.gateOn
  $('gate-db').value = s.gateDb
  $('gate-db-out').textContent = signed(s.gateDb)
  fill($('gate-db'))
  $('norm-on').checked = s.normOn
  $('norm-sub').hidden = !s.normOn
  for (const [id, value] of [['quiet-db', s.quietDb], ['loud-db', s.loudDb]]) {
    $(id).value = value
    $(id + '-out').textContent = signed(value)
    fill($(id))
  }
}

function renderProps() {
  const d = currentInput()
  const chips = $('device-chips')
  if (!d) {
    chips.replaceChildren(h('span', { class: 'chip', text: 'No input device detected' }))
    return
  }
  if (d.phone) {
    chips.replaceChildren(
      ...[['Source', 'Phone over Wi-Fi'], ['Link', d.online ? 'connected' : 'waiting for the phone'], ['Muted on phone', d.muted ? 'yes' : 'no']].map(([k, v]) => h('span', { class: 'chip' }, k + ': ', h('b', { text: v })))
    )
    $('level').disabled = true
    $('listen-on').disabled = true
    $('sysfx-on').disabled = true
    $('gain').value = gainFor(d)
    $('gain-out').textContent = $('gain').value + '%'
    fill($('gain'))
    return
  }
  $('level').disabled = false
  $('listen-on').disabled = false
  $('sysfx-on').disabled = false
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

function renderUpdate() {
  const u = state.update || { state: 'idle' }
  const rows = {
    checking: ['Checking for updates', 'Checking', true],
    downloading: [`Downloading version ${u.version} (${u.percent || 0}%)`, 'Downloading', true],
    ready: [`Version ${u.version} is ready to install`, 'Restart to update', false],
    available: [`Version ${u.version} is available`, 'Download', false],
    current: ['Vesper Audio is up to date', 'Check again', false],
    error: ['Update check failed: ' + (u.message || 'unknown error'), 'Try again', false]
  }
  const [text, label, busy] = rows[u.state] || [u.message || 'Updates', 'Check for updates', false]
  $('update-text').textContent = text
  const button = $('set-update')
  button.textContent = label
  button.disabled = busy
  const offer = u.state === 'ready' || u.state === 'available'
  notice('update', offer ? { text, label, action: () => api.invoke('update:act') } : null)
}

function renderSettings() {
  $('set-autostart').checked = state.settings.autoStart
  $('set-tray').checked = state.settings.closeToTray
  renderUpdate()
  $('version').textContent = 'Vesper Audio ' + state.info.version + (vacOut() && vacIn() ? '  |  Vesper Audio Cable ready' : '')
  $('set-voice-text').textContent = personal.note()
  $('set-voice').textContent = personal.button()
  $('set-voice-remove').hidden = !personal.model()
  if (phones) phones.renderSettings()
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
  if (d && d.nodePresent && !d.running) {
    return notice('driver', { text: `The fallback Vesper Audio Cable driver is installed but Windows could not start it (code ${d.problem}).`, label: 'Fix', action: () => installOwnDriver() })
  }
  if (d && d.vbPresent) {
    return notice('driver', { text: 'The cable driver is installed but its devices are missing. Run setup again to repair it.', label: 'Repair', action: () => installDriver() })
  }
  notice('driver', { text: 'Vesper Audio Cable is not installed. Other apps cannot hear Vesper Audio until it is.', label: 'Install', action: () => installDriver() })
}

async function refreshDevices() {
  let next
  try {
    next = await api.invoke('devices:list')
  } catch (err) {
    notice('devices', { text: 'Could not read Windows audio devices: ' + reason(err) })
    return
  }
  notice('devices', null)
  const key = JSON.stringify(next)
  if (key === state.devicesKey) return
  state.devicesKey = key
  state.devices = next
  renderAll()
  brandCable()
}

let brandTries = 0

async function brandCable() {
  if (brandTries >= 3 || !state.settings.cableOwned || !state.devices.some(d => d.cable === 'vb')) return
  brandTries++
  try {
    await api.invoke('driver:brand')
  } catch {}
  state.devicesKey = ''
  refreshDevices()
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
    if (e.key !== 'Escape') return
    closeMenus()
    if ($('overlay').hidden) return
    const dismiss = $('dlg-actions').firstElementChild
    if (dismiss && !dismiss.classList.contains('primary')) dismiss.click()
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
          if (!(state.driver && state.driver.secureBoot && !state.driver.testSigning)) installOwnDriver()
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

async function uninstallDriver() {
  const closeButton = h('button', { class: 'btn primary', type: 'button', text: 'Close', onclick: closeDialog })
  dialog({
    title: 'Uninstall Vesper Audio Cable',
    body: [h('p', { text: 'This removes the virtual microphone and its driver from Windows. Windows asks for permission once. You can install it again at any time.' })],
    actions: [
      { label: 'Cancel', onClick: closeDialog },
      {
        label: 'Uninstall',
        primary: true,
        onClick: async () => {
          $('dlg-actions').replaceChildren()
          $('dlg-body').replaceChildren(h('p', { class: 'muted', text: 'Removing the driver' }))
          try {
            await api.invoke('driver:uninstall')
            await save({ pendingReboot: 0 })
            $('dlg-title').textContent = 'Vesper Audio Cable removed'
            $('dlg-body').replaceChildren(h('p', { text: 'The virtual microphone is no longer installed.' }))
          } catch (err) {
            $('dlg-title').textContent = 'Could not remove the driver'
            $('dlg-body').replaceChildren(h('p', { class: 'error', text: reason(err) }))
          }
          $('dlg-actions').replaceChildren(closeButton)
          await refreshDevices()
          await refreshDriver()
          renderAll()
          sync()
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
      await api.invoke('driver:install', 'cable')
      off()
      await save({ setupDone: true, cableOwned: true })
      text.textContent = 'Checking that Windows created the devices'
      if (await waitForCable(20000)) {
        brandTries = 0
        await save({ pendingReboot: 0 })
        finishDialog('Vesper Audio Cable is ready', h('p', { text: 'The virtual microphone is installed and renamed Vesper Audio Cable. Pick it as the microphone in Discord, OBS, games or any other app.' }), [closeButton])
      } else {
        await save({ pendingReboot: Date.now() })
        finishDialog('Restart Windows to finish', h('p', { text: 'If you pressed Install Driver in the VB-Audio window, Windows only creates the devices after a restart. If you closed that window without installing, press Download and install again.' }), [
          h('button', { class: 'btn', type: 'button', text: 'Later', onclick: closeDialog }),
          h('button', { class: 'btn primary', type: 'button', text: 'Restart', onclick: restartDialog })
        ])
      }
    } catch (err) {
      off()
      finishDialog('Driver setup failed', h('p', { class: 'error', text: reason(err) }), [closeButton])
    }
    await refreshDevices()
    await refreshDriver()
    renderAll()
    sync()
  }
  dialog({
    title: vacOut() && vacIn() ? 'Reinstall Vesper Audio Cable' : 'Install Vesper Audio Cable',
    body: [
      h('p', { text: 'Vesper Audio Cable is the virtual microphone other apps will hear. It runs on the VB-CABLE driver, which is signed by Microsoft, so Secure Boot and Test Mode stay untouched.' }),
      steps([
        'Vesper Audio downloads VB-CABLE from vb-audio.com and checks its hash and Microsoft signature.',
        'Windows asks for permission, then the VB-Audio installer opens.',
        'Press Install Driver in that window and accept the VB-Audio licence.',
        'Vesper Audio renames the devices to Vesper Audio Cable.'
      ]),
      h('p', { class: 'muted', text: 'VB-CABLE is donationware by VB-Audio Software (vb-cable.com). Please consider donating to the author.' })
    ],
    actions: [
      {
        label: 'Later',
        onClick: async () => {
          await save({ setupDone: true })
          closeDialog()
        }
      },
      {
        label: 'Use fallback driver',
        onClick: () => {
          closeDialog()
          installOwnDriver()
        }
      },
      { label: 'Download and install', primary: true, onClick: run }
    ]
  })
}

async function installOwnDriver() {
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
      const result = await api.invoke('driver:install', 'own')
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
      finishDialog('Driver setup failed', h('p', { class: 'error', text: reason(err) }), [closeButton])
    }
    await refreshDevices()
    await refreshDriver()
    renderAll()
    sync()
  }
  const note = status && !status.testSigning ? 'The driver is unsigned, so Windows Test Mode is switched on and a restart may be needed.' : 'Windows asks for permission once.'
  dialog({
    title: 'Install the fallback driver',
    body: [h('p', { text: 'This is the self-signed Vesper driver. Use it only when VB-CABLE cannot be installed. It is downloaded from the Vesper Audio release and installed with administrator approval.' }), h('p', { class: 'muted', text: note })],
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
    notice('sound', { text: 'Could not play sound: ' + reason(err) })
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
    await save({ ai: on, basic: on ? false : state.settings.basic })
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
  $('gate-on').addEventListener('change', async e => {
    await save({ gateOn: e.target.checked })
    renderHome()
    sync()
  })
  $('norm-on').addEventListener('change', async e => {
    await save({ normOn: e.target.checked })
    renderHome()
    sync()
  })
  for (const [id, key] of [['gate-db', 'gateDb'], ['quiet-db', 'quietDb'], ['loud-db', 'loudDb']]) {
    $(id).addEventListener('input', async e => {
      fill(e.target)
      $(id + '-out').textContent = signed(Number(e.target.value))
      await save({ [key]: Number(e.target.value) })
      sync()
    })
  }
  $('voice-enroll').addEventListener('click', () => personal.open())
  $('add-phone').addEventListener('click', () => phones.openAdd())

  let levelTimer = null
  $('level').addEventListener('input', e => {
    fill(e.target)
    $('level-out').textContent = e.target.value + '%'
    const d = currentInput()
    if (!d || d.phone) return
    d.volume = Number(e.target.value)
    clearTimeout(levelTimer)
    levelTimer = setTimeout(() => api.invoke('device:volume', d.id, d.volume).catch(err => notice('props', { text: reason(err) })), 40)
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
    if (!d || d.phone) return
    try {
      await api.invoke('device:listen', d.id, e.target.checked)
      notice('props', null)
    } catch (err) {
      notice('props', { text: 'Windows would not change Listen to this device: ' + reason(err) })
    }
    await refreshDevices()
  })
  $('sysfx-on').addEventListener('change', async e => {
    const d = currentInput()
    if (!d || d.phone) return
    try {
      await api.invoke('device:sysfx', d.id, e.target.checked)
      notice('props', null)
    } catch (err) {
      notice('props', { text: 'Windows would not change audio enhancements: ' + reason(err) })
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
  $('set-own').addEventListener('click', () => installOwnDriver())
  $('set-update').addEventListener('click', () => api.invoke('update:act'))
  $('set-uninstall').addEventListener('click', () => uninstallDriver())
  $('set-voice').addEventListener('click', () => personal.open())
  $('set-diag').addEventListener('click', () => diag.run())
  $('set-voice-remove').addEventListener('click', () => personal.remove())
  $('set-repo').addEventListener('click', () => api.invoke('app:repo'))
}

let meterTimer = null
function meters() {
  clearInterval(meterTimer)
  meterTimer = setInterval(() => {
    if (state.hidden) return
    if (state.page === 'home') {
      $('meter-home').style.transform = `scaleX(${engine.outLevel().toFixed(3)})`
      const gate = state.settings && state.settings.gateOn ? (engine.dynOpen ? 'Gate open' : 'Gate closed') : GATE_HINT
      if ($('gate-state').textContent !== gate) $('gate-state').textContent = gate
    } else if (state.page === 'properties') {
      $('meter-props').style.transform = `scaleX(${engine.level().toFixed(3)})`
    }
  }, 50)
}

async function boot() {
  hydrate()
  state.info = await api.invoke('app:info')
  state.settings = await api.invoke('settings:get')
  personal = new Personal({ api, engine, state, dialog, closeDialog, notice, save, sync, reason, renderAll })
  diag = new Diag({ api, engine, dialog, closeDialog, reason })
  phones = new Phones({ api, engine, state, dialog, closeDialog, notice, save, sync, reason, renderAll })
  if (state.settings.speexDb > 0) await save({ speexDb: -state.settings.speexDb })
  bindMenus()
  bindControls()
  engine.onSoundEnd = () => renderBoard()
  api.on('app:hidden', () => (state.hidden = true))
  api.on('app:wake', () => engine.recover('Windows woke up, so Vesper Audio restarted the audio.'))
  state.update = await api.invoke('update:status').catch(() => null)
  api.on('update:status', s => {
    state.update = s
    renderUpdate()
  })
  if (state.info.testMode) window.__vesper = { engine, state, api, personal, phones, installDriver, installOwnDriver, uninstallDriver, save, sync, refreshDevices, config: engineConfig }
  await phones.init()
  await refreshDevices()
  state.driver = await api.invoke('driver:status').catch(() => null)
  renderAll()
  phones.render()
  sync()
  meters()
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices()
    sync()
  })
  setInterval(() => {
    if (!state.hidden) refreshDevices()
  }, 4000)
  api.on('app:shown', () => {
    state.hidden = false
    refreshDevices()
  })
  if (!state.settings.setupDone && !(vacOut() && vacIn())) {
    await save({ setupDone: true })
    installDriver()
  }
}

boot().catch(err => {
  api.invoke('app:log', 'boot failed: ' + (err && err.stack ? err.stack : err))
  notice('boot', { text: 'Vesper Audio failed to start: ' + reason(err) })
})
