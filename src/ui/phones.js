import { h, $ } from './dom.js'
import { icon } from './icons.js'
import qrcode from './vendor/qrcode.js'

const ico = (name, size) => {
  const el = h('span', { class: 'ico-box' })
  el.innerHTML = icon(name, size)
  return el
}

const QUALITY = {
  low: { label: 'Low latency: 720p, 30 fps', w: 1280, h: 720, fps: 30, kbps: 6000 },
  balanced: { label: 'Balanced: 1080p, 30 fps', w: 1920, h: 1080, fps: 30, kbps: 12000 },
  smooth: { label: 'Smooth: 1080p, 60 fps', w: 1920, h: 1080, fps: 60, kbps: 16000 }
}

const RELEASES = 'https://github.com/AroseEditor/Vesper-Audio/releases/latest'
const CODE_REFRESH_MS = 100000

function qrImage(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createDataURL(6, 2)
}

export class Phones {
  constructor({ api, engine, state, dialog, closeDialog, notice, save, sync, reason, renderAll }) {
    Object.assign(this, { api, engine, state, dialog, closeDialog, notice, save, sync, reason, renderAll })
    this.list = []
    this.status = null
    this.failed = ''
    this.adding = false
    this.starting = false
    this.uri = ''
    this.apk = null
    this.watch = null
    this.codeTimer = null
    this.firewall = null
    this.vdd = null
    this.vddBusy = ''
  }

  async init() {
    this.api.on('link:event', m => this.event(m.event, m.data))
    this.api.on('link:pcm', m => this.engine.pushPhone(m))
    this.api.on('link:failed', message => {
      this.failed = message
      this.notice('link', { text: message, label: 'Retry', action: () => this.retry() })
      this.render()
    })
    const wanted = String(this.state.settings.inputId || '').startsWith('phone:') || (await this.api.invoke('link:paired').catch(() => false))
    if (wanted) await this.refresh()
    this.refreshSystem()
  }

  call(method, params = {}) {
    return this.api.invoke('link:call', method, params)
  }

  async refresh() {
    try {
      this.status = await this.call('link.start')
      this.list = await this.call('link.phones')
      this.failed = ''
      this.notice('link', null)
    } catch (err) {
      this.failed = this.reason(err)
      this.notice('link', { text: this.failed, label: 'Retry', action: () => this.retry() })
    }
    this.changed()
  }

  async retry() {
    this.notice('link', null)
    try {
      await this.api.invoke('link:retry')
    } catch {}
    await this.refresh()
  }

  paired() {
    return this.list.filter(p => p.paired)
  }

  selected() {
    const id = String(this.state.settings.inputId || '')
    return id.startsWith('phone:') ? this.list.find(p => p.id === id.slice(6)) || null : null
  }

  input() {
    const id = String(this.state.settings.inputId || '')
    if (!id.startsWith('phone:')) return null
    const phone = this.list.find(p => p.id === id.slice(6))
    return { phone: true, id, phoneId: id.slice(6), name: 'Phone: ' + (phone ? phone.name : this.state.settings.phoneName || 'phone'), online: Boolean(phone && phone.online), muted: Boolean(phone && phone.muted), isDefault: false, volume: null, format: null }
  }

  tag(p) {
    if (!p.online) return 'offline'
    return p.muted ? 'muted' : 'connected'
  }

  entries() {
    return this.paired().map(p => ({ value: 'phone:' + p.id, label: 'Phone: ' + p.name, tag: this.tag(p) }))
  }

  event(name, data) {
    if (name === 'phones') {
      this.list = data
      this.changed()
    } else if (name === 'sas') {
      this.showCode(data)
    } else if (name === 'attempt') {
      if (data.ok) this.notice('attempt', null)
      else this.notice('attempt', { text: `A phone at ${data.addr} reached this PC but the secure connection failed: ${data.message}. Scan a fresh code and try again.` })
    } else if (name === 'bluetooth') {
      if (data.state === 'paired') this.notice('bluetooth', { text: `${data.name || 'Your phone'} paired over Bluetooth. It is now joining over Wi-Fi.` })
      else if (data.state === 'status' && !data.ok) this.notice('bluetooth', { text: data.message || 'The phone could not reach this PC over Wi-Fi. Check Windows Firewall and that both are on the same Wi-Fi.' })
      else this.notice('bluetooth', null)
    } else if (name === 'display') {
      if (data.state === 'error') this.notice('display', { text: data.message })
      else if (data.state === 'started') this.notice('display', null)
    }
  }

  changed() {
    const sel = this.selected()
    this.engine.setPhoneMuted(Boolean(sel && sel.muted))
    if (this.adding) {
      const fresh = this.paired().find(p => p.online && p.intent === 'mic' && !(this.state.settings.inputId || '').startsWith('phone:'))
      if (fresh) this.use(fresh)
    }
    this.reconcile()
    this.renderAll()
    this.render()
    this.renderAdd()
  }

  async reconcile() {
    const sel = this.selected()
    if (sel && sel.online && sel.paired && sel.intent === 'mic' && sel.session == null && !this.starting) {
      this.starting = true
      try {
        await this.call('link.session.start', { id: sel.id, kind: 'mic' })
      } catch {}
      this.starting = false
    }
    for (const p of this.list) {
      if (p.session != null && p.sessionKind === 'mic' && (!sel || sel.id !== p.id)) this.call('link.session.stop', { id: p.id }).catch(() => {})
    }
  }

  async use(phone) {
    await this.save({ inputId: 'phone:' + phone.id, phoneName: phone.name })
    this.adding = false
    this.closeDialog()
    this.renderAll()
    await this.sync()
    this.reconcile()
  }

  showCode(data) {
    this.dialog({
      title: 'Pair this phone?',
      body: [
        h('p', { text: `${data.name || 'A phone'}${data.model ? ' (' + data.model + ')' : ''} wants to connect to this PC.` }),
        h('div', { class: 'sas', text: data.code }),
        h('p', { class: 'muted', text: 'Check that the phone shows the same six digits. Press Pair on both only if they match.' })
      ],
      actions: [
        { label: 'Cancel', onClick: () => this.answer(data.id, false) },
        { label: 'Pair', primary: true, onClick: () => this.answer(data.id, true) }
      ]
    })
  }

  async answer(id, accept) {
    this.closeDialog()
    await this.call('link.confirm', { id, accept }).catch(() => {})
  }

  async newCode() {
    try {
      this.uri = (await this.call('link.pairUri')).uri
    } catch (err) {
      this.uri = ''
      this.failed = this.reason(err)
    }
    this.render()
    this.renderAdd()
  }

  async openAdd() {
    this.adding = true
    await this.refresh()
    await this.ensureFirewall()
    await this.newCode()
    this.dialog({ title: 'Add phone mic', body: h('div', { id: 'add-body' }), actions: [{ label: 'Get the Connector app', onClick: () => this.openApk() }, { label: 'Close', primary: true, onClick: () => this.closeAdd() }] })
    this.renderAdd()
    clearInterval(this.codeTimer)
    this.codeTimer = setInterval(() => (this.adding && !$('overlay').hidden ? this.newCode() : this.closeAdd(true)), CODE_REFRESH_MS)
  }

  closeAdd(silent) {
    this.adding = false
    clearInterval(this.codeTimer)
    if (!silent) this.closeDialog()
  }

  qrBlock() {
    if (!this.uri) return h('p', { class: 'error', text: this.failed || 'Could not create a pairing code.' })
    return h('div', { class: 'qr-wrap' }, h('img', { class: 'qr', src: qrImage(this.uri), alt: 'Pairing code' }), h('button', { class: 'btn small', type: 'button', text: 'New code', onclick: () => this.newCode() }))
  }

  phoneRow(p, actions) {
    const chips = [h('span', { class: 'chip' }, p.online ? 'Online' : 'Offline')]
    if (p.online && p.intent !== 'idle') chips.push(h('span', { class: 'chip' }, p.intent === 'mic' ? 'Wants to be a microphone' : 'Wants to be a second screen'))
    if (p.online && p.muted) chips.push(h('span', { class: 'chip warn' }, 'Muted on phone'))
    if (p.online && p.session != null) chips.push(h('span', { class: 'chip ok' }, p.sessionKind === 'display' ? 'Showing the screen' : 'Sending the microphone'))
    return h('div', { class: 'phone-row' }, ico('smartphone', 22), h('div', { class: 'phone-name' }, h('b', { text: p.name }), h('small', { text: p.model || '' })), h('div', { class: 'phone-chips' }, ...chips), h('div', { class: 'phone-actions' }, ...actions))
  }

  renderAdd() {
    const body = $('add-body')
    if (!this.adding || !body) return
    const rows = this.paired().map(p =>
      this.phoneRow(p, [h('button', { class: 'btn small primary', type: 'button', text: p.online ? 'Use this phone' : 'Waiting', disabled: !p.online, onclick: () => this.use(p) })])
    )
    body.replaceChildren(
      h('p', { text: 'Open Vesper Audio Connector on your phone and scan this code. Keep Bluetooth on: the phone connects to this PC over Bluetooth first, checks, then joins over Wi-Fi. Both must be on the same Wi-Fi.' }),
      this.qrBlock(),
      h('p', { class: 'hint', text: 'The code works once and expires after two minutes. Phones that are already paired connect on their own.' }),
      ...(rows.length ? [h('h3', { class: 'step-title', text: 'Paired phones' }), ...rows] : [])
    )
  }

  async openApk() {
    clearInterval(this.codeTimer)
    this.adding = false
    this.apk = await this.api.invoke('apk:start').catch(() => ({ available: false }))
    const url = this.apk.urls && this.apk.urls[0]
    const body = [h('p', { text: 'Vesper Audio Connector is an Android app. It lets your phone be a microphone or a second screen for this PC.' })]
    if (url) {
      body.push(
        h('p', { text: 'Scan this code with your phone camera while the phone is on the same Wi-Fi, or type the address in the phone browser:' }),
        h('div', { class: 'qr-wrap' }, h('img', { class: 'qr', src: qrImage(url), alt: 'Download code' })),
        h('p', { class: 'mono', text: url }),
        h('p', { class: 'hint', text: `SHA-256 ${this.apk.sha256}. The address works for ten minutes and only on your own network. Android may ask you to allow installing from your browser and Play Protect may ask for a scan.` })
      )
    } else {
      body.push(h('p', { class: 'hint', text: 'This build does not include the app file. Download it from the releases page.' }))
    }
    this.dialog({
      title: 'Get the Connector app',
      body,
      actions: [
        { label: 'Open releases page', onClick: () => this.api.invoke('app:link', RELEASES) },
        {
          label: 'Close',
          primary: true,
          onClick: () => {
            this.api.invoke('apk:stop').catch(() => {})
            this.closeDialog()
          }
        }
      ]
    })
  }

  async refreshSystem() {
    this.firewall = await this.api.invoke('firewall:status').catch(() => ({ allowed: false }))
    this.vdd = await this.api.invoke('display:status').catch(() => ({ nodePresent: false, running: false, monitors: [] }))
    this.renderSettings()
    this.render()
  }

  async ensureFirewall() {
    if (this.state.info.testMode) return true
    const status = await this.api.invoke('firewall:status').catch(() => ({ allowed: true }))
    this.firewall = status
    if (status.allowed) return true
    return new Promise(resolve => {
      const network = status.profile ? `Your network is set to ${status.profile}. ` : ''
      this.dialog({
        title: 'Let your phone reach this PC',
        body: [
          h('p', { text: 'Windows Firewall blocks phones from connecting to Vesper Audio until you allow it. ' + network + 'This adds one rule for Vesper Audio only and needs one administrator approval.' }),
          h('p', { class: 'hint', text: 'Without it the phone shows Reconnecting and never connects.' })
        ],
        actions: [
          {
            label: 'Not now',
            onClick: () => {
              this.closeDialog()
              resolve(false)
            }
          },
          {
            label: 'Allow',
            primary: true,
            onClick: async () => {
              this.closeDialog()
              await this.allowFirewall()
              resolve(Boolean(this.firewall && this.firewall.allowed))
            }
          }
        ]
      })
    })
  }

  async allowFirewall() {
    try {
      await this.api.invoke('firewall:allow')
    } catch (err) {
      this.notice('link', { text: this.reason(err) })
    }
    await this.refreshSystem()
  }

  async installDisplayDriver() {
    this.vddBusy = 'Installing'
    this.render()
    this.renderSettings()
    const off = this.api.on('display:progress', p => {
      this.vddBusy = `${p.message || 'Installing'} ${p.percent || 0}%`
      this.renderSettings()
      this.render()
    })
    try {
      const result = await this.api.invoke('display:install')
      this.notice('display', result.rebootRequired ? { text: 'The virtual display driver is installed. Restart Windows to finish.' } : null)
    } catch (err) {
      this.notice('display', { text: 'Virtual display driver: ' + this.reason(err) })
    }
    off()
    this.vddBusy = ''
    await this.refreshSystem()
  }

  async removeDisplayDriver() {
    this.vddBusy = 'Removing'
    this.renderSettings()
    try {
      await this.api.invoke('display:uninstall')
    } catch (err) {
      this.notice('display', { text: 'Virtual display driver: ' + this.reason(err) })
    }
    this.vddBusy = ''
    await this.refreshSystem()
  }

  virtualMonitor() {
    return ((this.vdd && this.vdd.monitors) || []).find(m => m.virtual) || null
  }

  async startDisplay(phone) {
    const q = QUALITY[this.state.settings.displayQuality] || QUALITY.low
    const virtual = this.virtualMonitor()
    let monitor = ''
    if (virtual) {
      await this.api.invoke('display:mode', virtual.device, q.w, q.h, q.fps).catch(() => {})
      monitor = virtual.device
    }
    try {
      await this.call('link.session.start', { id: phone.id, kind: 'display', video: { w: q.w, h: q.h, fps: q.fps, kbps: q.kbps, idrMs: 2000, monitor } })
      this.notice('display', null)
    } catch (err) {
      this.notice('display', { text: this.reason(err) })
    }
  }

  stopDisplay(phone) {
    return this.call('link.session.stop', { id: phone.id }).catch(() => {})
  }

  driverText() {
    const v = this.vdd
    if (this.vddBusy) return this.vddBusy
    if (!v) return 'Checking the virtual display driver'
    if (v.running) return 'Virtual display driver installed. Your phone can be an extra monitor.'
    if (v.nodePresent) return `Virtual display driver installed but Windows could not start it (code ${v.problem}).`
    return 'Virtual display driver not installed. Without it your phone mirrors your main screen.'
  }

  renderSettings() {
    const root = $('set-link-root')
    if (!root) return
    const row = (title, ...controls) => h('div', { class: 'card row' }, h('span', { class: 'title', text: title }), h('span', { class: 'btn-group' }, ...controls))
    const btn = (label, onclick, disabled) => h('button', { class: 'btn', type: 'button', text: label, onclick, disabled: Boolean(disabled) })
    const status = this.status
    const rows = [
      row(status ? `Phone link is on: ${status.name}, port ${status.port}, Bluetooth ${status.bluetooth ? 'ready' : 'not available'}` : this.failed || 'Phone link starts when you open Second Monitor or add a phone', btn('Download Vesper Audio Connector', () => this.openApk()), ...(this.firewall && !this.firewall.allowed ? [btn('Allow in Windows Firewall', () => this.allowFirewall())] : [])),
      ...this.paired().map(p => row(`Phone: ${p.name}${p.model ? ' (' + p.model + ')' : ''}${p.online ? ', online' : ', offline'}`, btn('Forget', () => this.call('link.forget', { id: p.id })))),
      row(this.driverText(), btn('Install', () => this.installDisplayDriver(), this.vddBusy || (this.vdd && this.vdd.nodePresent)), btn('Uninstall', () => this.removeDisplayDriver(), this.vddBusy || !(this.vdd && this.vdd.nodePresent)))
    ]
    root.replaceChildren(...rows)
  }

  render() {
    const root = $('display-root')
    if (!root) return
    const phones = this.list
    const rows = phones.map(p => {
      const actions = []
      if (p.paired) {
        if (p.online && p.sessionKind === 'display') actions.push(h('button', { class: 'btn small primary', type: 'button', text: 'Stop the screen', onclick: () => this.stopDisplay(p) }))
        else if (p.online && p.intent === 'display') actions.push(h('button', { class: 'btn small primary', type: 'button', text: 'Use as second monitor', onclick: () => this.startDisplay(p) }))
        actions.push(h('button', { class: 'btn small', type: 'button', text: 'Use as microphone', onclick: () => this.use(p) }))
        actions.push(h('button', { class: 'btn small', type: 'button', text: 'Forget', onclick: () => this.call('link.forget', { id: p.id }) }))
      }
      return this.phoneRow(p, actions)
    })
    root.replaceChildren(
      h(
        'div',
        { class: 'card' },
        h('h3', { class: 'card-title', text: 'Your phones' }),
        ...(rows.length ? rows : [h('p', { class: 'muted', text: this.failed || 'No phone yet. Install Vesper Audio Connector on your phone, open it and scan the code below.' })])
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', { class: 'card-title', text: 'Second monitor' }),
        h('p', { class: 'muted', text: this.driverText() }),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'muted', text: 'Quality' }),
          (() => {
            const select = h('select', { class: 'phone-select' }, ...Object.entries(QUALITY).map(([key, q]) => h('option', { value: key, text: q.label, selected: key === (this.state.settings.displayQuality || 'low') })))
            select.addEventListener('change', () => this.save({ displayQuality: select.value }))
            return select
          })(),
          this.vdd && this.vdd.nodePresent ? null : h('button', { class: 'btn small', type: 'button', text: this.vddBusy || 'Install virtual display driver', disabled: Boolean(this.vddBusy), onclick: () => this.installDisplayDriver() })
        ),
        h('p', { class: 'hint', text: 'On the phone choose Use as second monitor in Vesper Audio Connector, then press Use as second monitor next to the phone above.' })
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', { class: 'card-title', text: 'Pair a phone' }),
        this.uri ? this.qrBlock() : h('button', { class: 'btn', type: 'button', text: 'Show pairing code', onclick: () => this.refresh().then(() => this.newCode()) }),
        h('p', { class: 'hint', text: 'Both devices must be on the same Wi-Fi network.' })
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row' }, h('div', {}, h('b', { text: 'Vesper Audio Connector' }), h('p', { class: 'muted', text: 'The Android app for the phone microphone and the second screen.' })), h('button', { class: 'btn', type: 'button', text: 'Download Vesper Audio Connector', onclick: () => this.openApk() }))
      )
    )
  }
}
