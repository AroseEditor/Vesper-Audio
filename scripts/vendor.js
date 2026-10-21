const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'src', 'ui', 'vendor')
const nm = (...p) => path.join(root, 'node_modules', ...p)
const ns = nm('@sapphi-red', 'web-noise-suppressor', 'dist')
const ort = nm('onnxruntime-web', 'dist')
const fonts = nm('@fontsource', 'inter', 'files')

const copies = [
  [path.join(ns, 'index.js'), 'noise.js'],
  [path.join(ns, 'gtcrn', 'workletProcessor.js'), 'gtcrn.worklet.js'],
  [path.join(ns, 'rnnoise', 'workletProcessor.js'), 'rnnoise.worklet.js'],
  [path.join(ns, 'gtcrn.wasm'), 'gtcrn.wasm'],
  [path.join(ns, 'rnnoise.wasm'), 'rnnoise.wasm'],
  [path.join(ns, 'rnnoise_simd.wasm'), 'rnnoise_simd.wasm'],
  [path.join(ns, 'speex.wasm'), 'speex.wasm'],
  [path.join(ort, 'ort.wasm.min.mjs'), 'ort.min.mjs'],
  [path.join(ort, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
  [path.join(ort, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  ...[400, 500, 600, 700].map(w => [path.join(fonts, `inter-latin-${w}-normal.woff2`), `inter-${w}.woff2`])
]

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
for (const [from, to] of copies) fs.copyFileSync(from, path.join(out, to))

const speexSrc = fs.readFileSync(path.join(ns, 'speex', 'workletProcessor.js'), 'utf8')
const patches = [
  [
    'this.port.addEventListener(`message`,e=>{e.data===`destroy`&&this.destroy()})',
    'this.port.onmessage=e=>{e.data===`destroy`?this.destroy():typeof e.data==`number`&&(this.ns=e.data,this.processor?.setProperty(`noiseSuppress`,e.data))}'
  ],
  [
    'this.processor=s(t,{bufferSize:128,maxChannels:e.processorOptions.maxChannels,sampleRate}),',
    'this.processor=s(t,{bufferSize:128,maxChannels:e.processorOptions.maxChannels,sampleRate}),this.processor.setProperty(`noiseSuppress`,this.ns??e.processorOptions.noiseSuppress??-15),'
  ]
]
let patched = speexSrc
for (const [from, to] of patches) {
  if (!patched.includes(from)) throw new Error('speex worklet patch target missing: ' + from)
  patched = patched.replace(from, () => to)
}
fs.writeFileSync(path.join(out, 'speex.worklet.js'), patched)
