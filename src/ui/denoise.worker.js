import { StreamDenoiser } from './dpdf.js'

const vendor = file => new URL('./vendor/' + file, import.meta.url).href

async function bytesOf(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not load ${url} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

async function createDfn3() {
  const mod = await import('./vendor/df.js')
  await mod.default(vendor('df_bg.wasm'))
  const state = mod.df_create(await bytesOf(vendor('dfn3.tar.gz')), 100)
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
  return { hop: denoiser.hop, process: frame => denoiser.process(frame) }
}

self.onmessage = async e => {
  const msg = e.data
  if (msg.type !== 'init') return
  try {
    const engine = msg.backend === 'dfn3' ? await createDfn3() : await createDpdf(msg)
    let queue = Promise.resolve()
    let backlog = 0
    msg.port.onmessage = ev => {
      backlog++
      queue = queue
        .then(() => engine.process(ev.data))
        .then(out => {
          backlog--
          msg.port.postMessage(out, [out.buffer])
        })
    }
    self.postMessage({ type: 'ready', hop: engine.hop })
    setInterval(() => self.postMessage({ type: 'stats', backlog }), 1000)
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) })
  }
}
