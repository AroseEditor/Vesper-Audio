import { fbank, unit } from './voice.js'

let ort = null
let session = null

const vendor = file => new URL('./vendor/' + file, import.meta.url).href

self.onmessage = async e => {
  const m = e.data
  if (m.type === 'init') {
    try {
      ort = await import(m.provider === 'webgpu' ? './vendor/ort.webgpu.min.mjs' : './vendor/ort.min.mjs')
      ort.env.wasm.wasmPaths = vendor('')
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      session = await ort.InferenceSession.create(m.url, { executionProviders: [m.provider], graphOptimizationLevel: 'all' })
      self.postMessage({ type: 'ready' })
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) })
    }
  } else if (m.type === 'embed') {
    try {
      const feats = fbank(m.samples)
      const frames = feats.length / 80
      if (!frames) throw new Error('audio too short for embedding')
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', feats, [1, frames, 80]) })
      const emb = unit(out[session.outputNames[0]].data)
      self.postMessage({ type: 'embedding', id: m.id, emb }, [emb.buffer])
    } catch (err) {
      self.postMessage({ type: 'embedding', id: m.id, error: String((err && err.message) || err) })
    }
  }
}
