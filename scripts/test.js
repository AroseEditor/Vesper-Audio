const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { _electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-test-'))
const results = []

function writeWav(file, samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + samples.length * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  fs.writeFileSync(file, b)
}

function noise(seconds, level) {
  const out = new Float32Array(seconds * 48000)
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() + Math.random() + Math.random() - 1.5) * level
  return out
}

function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function launch(userData, wav, env = {}) {
  const base = { ...process.env, VESPER_USER_DATA: userData, ...env }
  delete base.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    cwd: root,
    args: ['.', '--test', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav],
    env: base
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.waitForFunction(() => window.__vesper && window.__vesper.engine.state.running, null, { timeout: 60000 })
  await page.evaluate(() => window.__vesper.save({ setupDone: true }))
  return { app, page, errors }
}

async function modes(page) {
  const list = [
    ['rnnoise', { ai: false, basic: true, basicPreset: 'rnnoise' }, 10],
    ['speex', { ai: false, basic: true, basicPreset: 'speex', speexDb: -40 }, 8],
    ['speexzero', { ai: false, basic: true, basicPreset: 'speexzero', speexDb: -40 }, 6],
    ['personal', { ai: true, aiPreset: 'personal', basic: false }, 10],
    ['clearcast', { ai: true, aiPreset: 'clearcast', aiStrength: 100, basic: false }, 10]
  ]
  for (const [name, patch, need] of list) {
    const r = await page.evaluate(async p => {
      const v = window.__vesper
      await v.save({ ai: false, basic: false })
      await v.save(p)
      await v.sync()
      await new Promise(res => setTimeout(res, 8000))
      let input = 0
      let output = 0
      const n = 60
      for (let i = 0; i < n; i++) {
        input += v.engine.level() * 60 - 60
        output += v.engine.outLevel() * 60 - 60
        await new Promise(res => setTimeout(res, 50))
      }
      return { input: input / n, output: output / n, error: v.engine.state.error }
    }, patch)
    check(`${name} reduces noise by at least ${need} dB`, !r.error && r.input - r.output >= need, `in ${r.input.toFixed(1)} out ${r.output.toFixed(1)} ${r.error}`)
  }
}

async function dynamics(page) {
  const ui = await page.evaluate(async () => {
    const set = (id, value) => {
      const el = document.getElementById(id)
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.getElementById('gate-on').click()
    document.getElementById('norm-on').click()
    set('gate-db', -33)
    set('quiet-db', 7)
    set('loud-db', -12)
    await new Promise(res => setTimeout(res, 500))
    const s = await window.__vesper.api.invoke('settings:get')
    const text = id => document.getElementById(id).textContent
    return {
      saved: [s.gateOn, s.gateDb, s.normOn, s.quietDb, s.loudDb],
      shown: [!document.getElementById('gate-sub').hidden, !document.getElementById('norm-sub').hidden],
      labels: [text('gate-db-out'), text('quiet-db-out'), text('loud-db-out')]
    }
  })
  check('gate and loudness controls save to settings', JSON.stringify(ui.saved) === JSON.stringify([true, -33, true, 7, -12]), JSON.stringify(ui.saved))
  check('gate and loudness sliders appear when ticked and show dB', ui.shown.every(Boolean) && ui.labels.join() === '-33 dB,+7 dB,-12 dB', ui.labels.join())

  const gate = async db => {
    return page.evaluate(async db => {
      const v = window.__vesper
      await v.save({ ai: false, basic: false, gateOn: true, gateDb: db, normOn: false })
      await v.sync()
      await new Promise(res => setTimeout(res, 2500))
      let input = 0
      let output = 0
      const n = 40
      for (let i = 0; i < n; i++) {
        input += v.engine.level() * 60 - 60
        output += v.engine.outLevel() * 60 - 60
        await new Promise(res => setTimeout(res, 50))
      }
      return { input: input / n, output: output / n, open: v.engine.dynOpen }
    }, db)
  }
  const closed = await gate(-10)
  check('noise gate silences a signal below the threshold', !closed.open && closed.input - closed.output >= 25, `in ${closed.input.toFixed(1)} out ${closed.output.toFixed(1)}`)
  const passing = await gate(-80)
  check('noise gate stays open for a signal above the threshold', passing.open && Math.abs(passing.input - passing.output) <= 1.5, `in ${passing.input.toFixed(1)} out ${passing.output.toFixed(1)}`)

  const shape = async (segments, patch, span) => {
    return page.evaluate(
      async ({ segments, patch, span }) => {
        const v = window.__vesper
        const e = v.engine
        await v.save({ ai: false, basic: false, gateOn: false, normOn: false })
        await v.sync()
        await new Promise(res => setTimeout(res, 300))
        await v.save({ normOn: true, ...patch })
        await v.sync()
        await new Promise(res => setTimeout(res, 1500))
        e.gain.gain.cancelScheduledValues(0)
        e.gain.gain.value = 0
        const sp = e.ctx.createScriptProcessor(1024, 1, 1)
        const mute = e.ctx.createGain()
        mute.gain.value = 0
        const chunks = []
        e.micOut.connect(sp)
        sp.connect(mute).connect(e.ctx.destination)
        sp.onaudioprocess = ev => chunks.push(ev.inputBuffer.getChannelData(0).slice())
        const total = segments.reduce((n, seg) => n + seg[0], 0)
        const buf = e.ctx.createBuffer(1, Math.round(total * 48000), 48000)
        const data = buf.getChannelData(0)
        let at = 0
        for (const [seconds, amp] of segments) {
          const end = at + Math.round(seconds * 48000)
          for (let i = at; i < end; i++) data[i] = Math.sin((2 * Math.PI * 300 * i) / 48000) * amp
          at = end
        }
        const src = e.ctx.createBufferSource()
        src.buffer = buf
        src.connect(e.fxIn)
        src.start()
        await new Promise(res => setTimeout(res, (total + 0.6) * 1000))
        sp.onaudioprocess = null
        e.micOut.disconnect(sp)
        const flat = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
        let o = 0
        for (const c of chunks) {
          flat.set(c, o)
          o += c.length
        }
        let start = 0
        while (start < flat.length && Math.abs(flat[start]) < 1e-4) start++
        const from = start + Math.round(span[0] * 48000)
        const to = start + Math.round(span[1] * 48000)
        let sum = 0
        for (let i = from; i < to; i++) sum += flat[i] * flat[i]
        return 10 * Math.log10(sum / (to - from) + 1e-12)
      },
      { segments, patch, span }
    )
  }
  const rms = amp => 20 * Math.log10(amp / Math.SQRT2)
  const lifted = (await shape([[8, 0.5], [2, 0.0316]], { quietDb: 10, loudDb: 0 }, [8.8, 9.8])) - rms(0.0316)
  check('loudness normalization lifts quiet speech by the quiet slider', Math.abs(lifted - 10) <= 1.5, `${lifted.toFixed(1)} dB`)
  const cut = (await shape([[3, 0.063], [0.8, 0.5]], { quietDb: 0, loudDb: -6 }, [3.12, 3.45])) - rms(0.5)
  check('loudness normalization lowers loud speech by the loud slider', Math.abs(cut + 6) <= 1.5, `${cut.toFixed(1)} dB`)
  await page.evaluate(() => window.__vesper.save({ gateOn: false, normOn: false }))
}

function fakePhonePath() {
  if (process.env.VESPER_FAKEPHONE) return process.env.VESPER_FAKEPHONE
  for (const dir of ['release', 'debug']) {
    const file = path.join(root, 'core', 'target', dir, 'fakephone.exe')
    if (fs.existsSync(file)) return file
  }
  return ''
}

async function phoneMic(page) {
  const fake = fakePhonePath()
  if (!fake) {
    console.log('SKIP  phone microphone checks (build the core first: npm run core)')
    return
  }
  await page.evaluate(() => window.__vesper.save({ ai: false, basic: false, gateOn: false, normOn: false }))
  await page.evaluate(() => window.__vesper.sync())
  const started = await page.evaluate(() => window.__vesper.api.invoke('link:call', 'link.start', {}).then(s => s.port))
  check('link component starts and listens', started > 0, 'port ' + started)
  const uri = await page.evaluate(() => window.__vesper.api.invoke('link:call', 'link.pairUri', {}).then(r => r.uri))
  const local = uri.split('&').map(part => (part.startsWith('a=') ? 'a=127.0.0.1' : part)).join('&')
  const dir = fs.mkdtempSync(path.join(work, 'phone-'))
  const child = spawn(fake, ['--qr', local, '--dir', dir, '--name', 'Test Phone', '--id', 'test-phone', '--mode', 'mic', '--seconds', '14', '--mute-after', '9000'], { stdio: 'ignore', windowsHide: true })
  const online = async () => page.evaluate(() => window.__vesper.phones.list.find(p => p.paired && p.online && p.intent === 'mic') || null)
  let phone = null
  for (let i = 0; i < 60 && !phone; i++) {
    await new Promise(res => setTimeout(res, 250))
    phone = await online()
  }
  check('a phone pairs with the QR code and appears', Boolean(phone), phone ? phone.name : 'none')
  if (!phone) {
    child.kill()
    return
  }
  await page.evaluate(p => window.__vesper.phones.use(p), phone)
  let level = 0
  for (let i = 0; i < 24 && level < 0.5; i++) {
    await new Promise(res => setTimeout(res, 250))
    level = await page.evaluate(() => window.__vesper.engine.outLevel())
  }
  const info = await page.evaluate(() => ({ kind: window.__vesper.engine.cfg.input.kind, stats: window.__vesper.engine.stats.phone || null, sessions: window.__vesper.phones.list.map(p => p.session) }))
  check('the phone becomes the microphone and its audio plays', info.kind === 'phone' && level > 0.5, `level ${level.toFixed(2)} ${JSON.stringify(info.stats)}`)
  const poll = async (limit, fn) => {
    for (let i = 0; i < limit * 4; i++) {
      if (await page.evaluate(fn)) return true
      await new Promise(res => setTimeout(res, 250))
    }
    return false
  }
  const sawMute = await poll(14, () => window.__vesper.phones.list.some(p => p.muted))
  await new Promise(res => setTimeout(res, 700))
  const muted = await page.evaluate(() => ({ muted: window.__vesper.phones.list.some(p => p.muted), level: window.__vesper.engine.outLevel() }))
  check('muting on the phone shows on the PC and goes silent', sawMute && muted.level < 0.1, JSON.stringify(muted))
  const left = await poll(20, () => !window.__vesper.phones.list.some(p => p.online))
  await new Promise(res => setTimeout(res, 500))
  const gone = await page.evaluate(() => ({ online: window.__vesper.phones.list.some(p => p.online), level: window.__vesper.engine.outLevel() }))
  check('when the phone leaves, nothing is played and the default microphone is not used', left && gone.level < 0.1, JSON.stringify(gone))
  child.kill()
  await page.evaluate(() => window.__vesper.save({ inputId: '' }))
}

async function phoneDisplay(page) {
  const fake = fakePhonePath()
  if (!fake) return
  const dump = path.join(work, 'screen.h264')
  const uri = await page.evaluate(() => window.__vesper.api.invoke('link:call', 'link.pairUri', {}).then(r => r.uri))
  const local = uri.split('&').map(part => (part.startsWith('a=') ? 'a=127.0.0.1' : part)).join('&')
  const dir = fs.mkdtempSync(path.join(work, 'phone-display-'))
  const child = spawn(fake, ['--qr', local, '--dir', dir, '--name', 'Display Phone', '--id', 'display-phone', '--mode', 'display', '--seconds', '9', '--dump', dump], { stdio: 'ignore', windowsHide: true })
  const poll = async (limit, fn, arg) => {
    for (let i = 0; i < limit * 4; i++) {
      const value = await page.evaluate(fn, arg)
      if (value) return value
      await new Promise(res => setTimeout(res, 250))
    }
    return null
  }
  const phone = await poll(14, () => window.__vesper.phones.list.find(p => p.paired && p.online && p.intent === 'display') || null)
  check('a phone that opened the second monitor screen is listed', Boolean(phone), phone ? phone.name : 'none')
  if (!phone) {
    child.kill()
    return
  }
  await page.evaluate(() => window.__vesper.api.invoke('app:log', 'display test'))
  await page.evaluate(() => document.querySelector('.nav[data-page="display"]').click())
  await page.evaluate(p => window.__vesper.phones.startDisplay(p), phone)
  const active = await poll(10, () => window.__vesper.phones.list.some(p => p.sessionKind === 'display'))
  check('the PC starts sending the screen to the phone', Boolean(active))
  await new Promise(res => setTimeout(res, 3500))
  const button = await page.evaluate(() => [...document.querySelectorAll('#display-root .btn')].map(b => b.textContent))
  check('the Second Monitor page offers to stop the screen while it is shown', button.includes('Stop the screen'), button.join('|'))
  const rows = await page.evaluate(() => {
    document.querySelector('.nav[data-page="settings"]').click()
    return document.querySelectorAll('#set-link-root .card.row').length
  })
  check('Settings lists the phone link, the paired phone and the display driver', rows >= 3, 'rows ' + rows)
  await new Promise(res => setTimeout(res, 4500))
  child.kill()
  const bytes = fs.existsSync(dump) ? fs.readFileSync(dump) : Buffer.alloc(0)
  const nal = type => {
    for (let i = 0; i + 4 < bytes.length; i++) if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 31) === type) return true
    return false
  }
  check('the phone received a keyframe with parameter sets over the encrypted link', bytes.length > 2000 && nal(7) && nal(8) && nal(5), bytes.length + ' bytes')
  await page.evaluate(() => document.querySelector('.nav[data-page="home"]').click())
}

async function main() {
  const noiseWav = path.join(work, 'noise.wav')
  writeWav(noiseWav, noise(12, 0.08), 48000)
  const toneWav = path.join(work, 'sound.mp3')
  const tone = new Float32Array(48000)
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.3
  writeWav(toneWav, tone, 48000)
  const userData = path.join(work, 'userdata')

  let { app, page, errors } = await launch(userData, noiseWav, { VESPER_TEST_SOUNDS: toneWav })
  check('app boots and engine starts', true)
  const pages = await page.evaluate(() => [...document.querySelectorAll('.nav')].map(n => n.dataset.page))
  check('five pages present', pages.join() === 'home,properties,board,display,settings', pages.join())
  const devices = await page.evaluate(() => window.__vesper.api.invoke('devices:list'))
  check('windows endpoints detected', devices.length > 0, devices.length + ' endpoints')

  await modes(page)
  await dynamics(page)
  await phoneMic(page)
  if (require('child_process').spawnSync(path.join(root, 'core', 'target', 'release', 'vesper-display.exe'), ['--list']).stdout.toString().includes('DISPLAY')) await phoneDisplay(page)

  await page.evaluate(() => window.__vesper.save({ ai: false, basic: false, closeToTray: true, boardVolume: 42, speexDb: -31, aiStrength: 55, basicPreset: 'speex' }))
  const sounds = await page.evaluate(() => window.__vesper.api.invoke('sounds:add'))
  check('soundboard imports a sound', sounds.length === 1)
  const played = await page.evaluate(async list => {
    const v = window.__vesper
    const id = list[0].id
    const on = await v.engine.toggleSound(id, 'vesper://sounds/' + id + '.mp3', 100)
    await new Promise(res => setTimeout(res, 500))
    const level = v.engine.outLevel()
    const off = !(await v.engine.toggleSound(id, 'vesper://sounds/' + id + '.mp3', 100))
    return { on, off, level }
  }, sounds)
  check('soundboard plays through the output bus', played.on && played.off)

  const hidden = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.show()
    w.close()
    await new Promise(res => setTimeout(res, 300))
    return !w.isDestroyed() && !w.isVisible()
  })
  check('closing hides to tray', hidden)
  check('engine survives hidden window', await page.evaluate(() => window.__vesper.engine.state.running))
  const personal = await page.evaluate(async () => {
    const v = window.__vesper
    await v.save({ ai: true, aiPreset: 'personal', basic: false })
    await v.sync()
    return { active: v.engine.active, denoiser: v.engine.state.denoiser, warning: v.engine.state.warning }
  })
  check('personal model starts with the built-in zero lookahead model', personal.active === 'personal' && personal.denoiser === 'personal' && !personal.warning, JSON.stringify(personal))
  check('no page errors', errors.length === 0, errors.join(' | '))
  await page.evaluate(() => window.__vesper.save({ closeToTray: false }))
  await new Promise(res => setTimeout(res, 400))
  await app.close()

  ;({ app, page } = await launch(userData, noiseWav))
  const saved = await page.evaluate(() => window.__vesper.api.invoke('settings:get'))
  check('settings survive a restart', saved.boardVolume === 42 && saved.speexDb === -31 && saved.aiStrength === 55 && saved.basicPreset === 'speex' && saved.sounds.length === 1)
  await app.close()

  fs.rmSync(work, { recursive: true, force: true })
  const failed = results.filter(r => !r).length
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
