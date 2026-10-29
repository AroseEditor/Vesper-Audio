const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { _electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-lowend-'))
const results = []

function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function writeNoise(file, seconds) {
  const samples = new Int16Array(seconds * 48000)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round((Math.random() + Math.random() + Math.random() - 1.5) * 0.08 * 32767)
  const b = Buffer.alloc(44 + samples.length * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + samples.length * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(48000, 24)
  b.writeUInt32LE(96000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(samples.length * 2, 40)
  Buffer.from(samples.buffer).copy(b, 44)
  fs.writeFileSync(file, b)
}

function pin(pid, mask) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`], { windowsHide: true })
  } catch {}
}

async function main() {
  const wav = path.join(work, 'noise.wav')
  writeNoise(wav, 12)
  const env = { ...process.env, VESPER_USER_DATA: path.join(work, 'userdata') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ cwd: root, args: ['.', '--test', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav], env })
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.__vesper && window.__vesper.engine.state.running, null, { timeout: 60000 })
  const pids = await app.evaluate(({ app }) => app.getAppMetrics().map(m => m.pid))
  for (const pid of pids) pin(pid, 3)
  const hogs = []
  for (let i = 0; i < 2; i++) {
    const hog = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true })
    pin(hog.pid, 3)
    hogs.push(hog)
  }
  try {
    await page.evaluate(async () => {
      const v = window.__vesper
      await v.save({ ai: true, aiPreset: 'personal', basic: false, perfPersonal: 0, perfClearcast: 0 })
      await v.sync()
    })
    await page.waitForTimeout(15000)
    const first = await page.evaluate(() => ({ ...window.__vesper.engine.stats }))
    await page.waitForTimeout(8000)
    const last = await page.evaluate(() => {
      const e = window.__vesper.engine
      return { stats: { ...e.stats }, active: e.active, warning: e.state.warning, rungs: { ...e.rungs } }
    })
    const settled = await page.evaluate(() => window.__vesper.api.invoke('settings:get'))
    check('ladder leaves Personal when two cores are loaded', last.active !== 'personal', `${last.active} ${last.warning}`)
    check('rebuffers stop growing once the ladder settled', last.stats.rebuffers - first.rebuffers <= 3, `${first.rebuffers} to ${last.stats.rebuffers}`)
    check('backlog stays small', last.stats.backlog <= 2, `backlog ${last.stats.backlog}`)
    check('the step-down is remembered in settings', settled.perfPersonal === last.rungs.personal && settled.perfPersonal > 0, `saved ${settled.perfPersonal}`)
  } finally {
    for (const h of hogs) h.kill()
    await app.close()
  }
  const failed = results.filter(r => !r).length
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error('lowend failed', err.message)
  process.exit(1)
})
