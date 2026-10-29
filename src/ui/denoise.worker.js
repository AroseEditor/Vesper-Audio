import { StreamDenoiser } from './dpdf.js'

const vendor = file => new URL('./vendor/' + file, import.meta.url).href
const MAX_QUEUE = 2
const BENCH_FRAMES = 40
const BENCH_SKIP = 8
const SAMPLES = 200

async function bytesOf(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not load ${url} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

async function createDfn3(msg) {
  const mod = await import('./vendor/df.js')
  await mod.default(vendor('df_bg.wasm'))
  const state = mod.df_create(await bytesOf(msg.modelUrl || vendor('dfn3.tar.gz')), 100)
  return {
    hop: mod.df_get_frame_length(state),
    process: async frame => mod.df_process_frame(state, frame)
  }
}

async function createDpdf(msg) {
  const ort = await import(msg.provider === 'webgpu' ? './vendor/ort.webgpu.min.mjs' : './vendor/ort.min.mjs')
  ort.env.wasm.wasmPaths = vendor('')
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  const denoiser = await StreamDenoiser.create(ort, await bytesOf(msg.modelUrl), msg.model, { providers: [msg.provider] })
  return { hop: 480, process: frame => denoiser.process48(frame) }
}

function summary(times) {
  if (!times.length) return { p50: 0, p95: 0, max: 0 }
  const sorted = times.slice().sort((a, b) => a - b)
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

async function benchmark(engine) {
  const times = []
  for (let i = 0; i < BENCH_FRAMES; i++) {
    const frame = new Float32Array(engine.hop)
    for (let j = 0; j < frame.length; j++) frame[j] = (Math.random() - 0.5) * 2e-4
    const t0 = performance.now()
    await engine.process(frame)
    times.push(performance.now() - t0)
  }
  return summary(times.slice(BENCH_SKIP))
}

self.onmessage = async e => {
  const msg = e.data
  if (msg.type !== 'init') return
  try {
    const engine = msg.backend === 'dfn3' ? await createDfn3(msg) : await createDpdf(msg)
    const bench = await benchmark(engine)
    const queue = []
    const times = []
    let busy = false
    let skipped = 0
    const pump = async () => {
      if (busy) return
      busy = true
      while (queue.length) {
        const frame = queue.shift()
        let out = frame
        if (queue.length >= MAX_QUEUE) {
          skipped++
        } else {
          const t0 = performance.now()
          out = await engine.process(frame)
          times.push(performance.now() - t0)
          if (times.length > SAMPLES) times.shift()
        }
        msg.port.postMessage(out, [out.buffer])
      }
      busy = false
    }
    msg.port.onmessage = ev => {
      queue.push(ev.data)
      pump()
    }
    self.postMessage({ type: 'ready', hop: engine.hop, bench })
    setInterval(() => self.postMessage({ type: 'stats', backlog: queue.length + (busy ? 1 : 0), skipped, ...summary(times) }), 1000)
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) })
  }
}
