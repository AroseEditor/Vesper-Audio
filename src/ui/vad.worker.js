import { Vad } from './vad.js'

let vad = null

const vendor = file => new URL('./vendor/' + file, import.meta.url).href

self.onmessage = async e => {
  const m = e.data
  if (m.type === 'init') {
    try {
      const ort = await import('./vendor/ort.min.mjs')
      ort.env.wasm.wasmPaths = vendor('')
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      const bytes = new Uint8Array(await (await fetch(m.url)).arrayBuffer())
      vad = await Vad.create(ort, bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
      self.postMessage({ type: 'ready' })
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) })
    }
  } else if (m.type === 'reset') {
    if (vad) vad.reset()
  } else if (m.type === 'push') {
    try {
      const probs = await vad.push(m.samples)
      self.postMessage({ type: 'probs', id: m.id, probs })
    } catch (err) {
      self.postMessage({ type: 'probs', id: m.id, error: String((err && err.message) || err) })
    }
  }
}
