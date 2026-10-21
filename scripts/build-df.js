const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const COMMIT = 'd375b2d8309e0935d165700c91da9de862a99c31'
const MODEL_URL = `https://raw.githubusercontent.com/Rikorose/DeepFilterNet/${COMMIT}/models/DeepFilterNet3_onnx.tar.gz`
const MODEL_SHA256 = 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616'
const BINDGEN_VERSION = '0.2.92'

const root = path.join(__dirname, '..')
const vendor = path.join(root, 'src', 'ui', 'vendor')
const cache = path.join(root, '.cache')
const repo = path.join(cache, 'DeepFilterNet')
const force = process.argv.includes('--force')

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })

function ensureTools() {
  try {
    const out = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' })
    if (!out.includes(BINDGEN_VERSION)) throw new Error('wrong version ' + out.trim())
  } catch (err) {
    throw new Error(`wasm-bindgen-cli ${BINDGEN_VERSION} is required: cargo install wasm-bindgen-cli --version ${BINDGEN_VERSION} --locked (${err.message})`)
  }
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown'])
}

function checkout() {
  fs.mkdirSync(cache, { recursive: true })
  if (!fs.existsSync(repo)) {
    run('git', ['clone', '--filter=blob:none', 'https://github.com/Rikorose/DeepFilterNet.git', repo])
  }
  run('git', ['fetch', '--depth', '1', 'origin', COMMIT], { cwd: repo })
  run('git', ['checkout', '--force', COMMIT], { cwd: repo })
}

function build() {
  run(
    'cargo',
    ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'deep_filter', '--lib', '--no-default-features', '--features', 'wasm'],
    { cwd: repo, env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' } }
  )
  const out = path.join(cache, 'df-pkg')
  fs.rmSync(out, { recursive: true, force: true })
  run('wasm-bindgen', ['--target', 'web', '--out-dir', out, path.join(repo, 'target', 'wasm32-unknown-unknown', 'release', 'df.wasm')])
  fs.mkdirSync(vendor, { recursive: true })
  fs.copyFileSync(path.join(out, 'df.js'), path.join(vendor, 'df.js'))
  fs.copyFileSync(path.join(out, 'df_bg.wasm'), path.join(vendor, 'df_bg.wasm'))
}

async function model() {
  const dest = path.join(vendor, 'dfn3.tar.gz')
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error('model download failed ' + res.status)
  const bytes = Buffer.from(await res.arrayBuffer())
  const sum = crypto.createHash('sha256').update(bytes).digest('hex')
  if (sum !== MODEL_SHA256) throw new Error('DeepFilterNet3 model checksum mismatch: ' + sum)
  fs.writeFileSync(dest, bytes)
}

async function main() {
  const done = ['df.js', 'df_bg.wasm', 'dfn3.tar.gz'].every(f => fs.existsSync(path.join(vendor, f)))
  if (done && !force) return
  ensureTools()
  checkout()
  build()
  await model()
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
