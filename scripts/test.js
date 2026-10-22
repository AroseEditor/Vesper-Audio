const fs = require('fs')
const os = require('os')
const path = require('path')
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
  check('four pages present', pages.join() === 'home,properties,board,settings', pages.join())
  const devices = await page.evaluate(() => window.__vesper.api.invoke('devices:list'))
  check('windows endpoints detected', devices.length > 0, devices.length + ' endpoints')

  await modes(page)

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
