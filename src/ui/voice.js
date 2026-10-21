export const RATE = 16000
const WIN = 400
const SHIFT = 160
const NFFT = 512
const HALF = NFFT / 2
const MELS = 80
const VAD_RMS = 0.006
const WINDOW_SECONDS = 1.6
const CHUNK_SECONDS = 0.1
export const MIN_SPEECH_SECONDS = 10

const hamming = Float64Array.from({ length: WIN }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WIN - 1)))
const cosT = Float64Array.from({ length: HALF }, (_, i) => Math.cos((2 * Math.PI * i) / NFFT))
const sinT = Float64Array.from({ length: HALF }, (_, i) => -Math.sin((2 * Math.PI * i) / NFFT))
const rev = new Uint16Array(NFFT)
for (let i = 0, bits = Math.log2(NFFT); i < NFFT; i++) {
  let r = 0
  for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
  rev[i] = r
}

const mel = f => 1127 * Math.log(1 + f / 700)
const bank = (() => {
  const low = mel(20)
  const delta = (mel(RATE / 2) - low) / (MELS + 1)
  const out = []
  for (let b = 0; b < MELS; b++) {
    const left = low + b * delta
    const center = left + delta
    const right = center + delta
    const w = new Float32Array(HALF)
    let lo = -1
    let hi = -1
    for (let i = 0; i < HALF; i++) {
      const m = mel((RATE / NFFT) * i)
      if (m > left && m < right) {
        w[i] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center)
        if (lo < 0) lo = i
        hi = i
      }
    }
    out.push({ w, lo, hi })
  }
  return out
})()

function fft(re, im) {
  for (let i = 0; i < NFFT; i++) {
    const j = rev[i]
    if (j > i) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1
    const step = NFFT / size
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = cosT[k * step]
        const s = sinT[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * c - im[b] * s
        const ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

export function fbank(x) {
  const frames = Math.floor((x.length - WIN) / SHIFT) + 1
  if (frames < 1) return new Float32Array(0)
  const out = new Float32Array(frames * MELS)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  const d = new Float64Array(WIN)
  const power = new Float64Array(HALF)
  for (let f = 0; f < frames; f++) {
    const o = f * SHIFT
    let mean = 0
    for (let i = 0; i < WIN; i++) mean += x[o + i]
    mean /= WIN
    for (let i = 0; i < WIN; i++) d[i] = (x[o + i] - mean) * 32768
    for (let i = WIN - 1; i > 0; i--) d[i] -= 0.97 * d[i - 1]
    d[0] -= 0.97 * d[0]
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < WIN; i++) re[i] = d[i] * hamming[i]
    fft(re, im)
    for (let k = 0; k < HALF; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let b = 0; b < MELS; b++) {
      const { w, lo, hi } = bank[b]
      let e = 0
      for (let k = lo; k >= 0 && k <= hi; k++) e += w[k] * power[k]
      out[f * MELS + b] = Math.log(Math.max(e, 1.1920929e-7))
    }
  }
  for (let b = 0; b < MELS; b++) {
    let m = 0
    for (let f = 0; f < frames; f++) m += out[f * MELS + b]
    m /= frames
    for (let f = 0; f < frames; f++) out[f * MELS + b] -= m
  }
  return out
}

export function unit(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Float32Array.from(v, x => x / n)
}

export function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export async function loadSpeaker(url, provider = 'wasm') {
  const worker = new Worker(new URL('./speaker.worker.js', import.meta.url), { type: 'module' })
  const pending = new Map()
  let seq = 0
  const ready = new Promise((resolve, reject) => {
    worker.onmessage = e => {
      const m = e.data
      if (m.type === 'ready') resolve()
      else if (m.type === 'error') reject(new Error(m.message))
      else if (m.type === 'embedding') {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error))
        else p.resolve(new Float32Array(m.emb))
      }
    }
    worker.onerror = e => reject(new Error(e.message || 'speaker worker failed'))
  })
  worker.postMessage({ type: 'init', url, provider })
  try {
    await ready
  } catch (err) {
    worker.terminate()
    throw err
  }
  return {
    provider,
    embed(samples) {
      return new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        const copy = Float32Array.from(samples)
        worker.postMessage({ type: 'embed', id, samples: copy }, [copy.buffer])
      })
    },
    dispose() {
      worker.terminate()
    }
  }
}

export function createTap(ctx, source, onChunk) {
  const node = new AudioWorkletNode(ctx, 'vesper-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
  const mute = ctx.createGain()
  mute.gain.value = 0
  const dest = ctx.createMediaStreamDestination()
  node.port.onmessage = e => onChunk(e.data)
  source.connect(node)
  node.connect(mute).connect(dest)
  return {
    stop() {
      node.port.onmessage = null
      try {
        source.disconnect(node)
      } catch {}
      node.disconnect()
      mute.disconnect()
    }
  }
}

const rms = x => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function pcmToBytes(audio) {
  const out = new Int16Array(audio.length)
  for (let i = 0; i < audio.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32767)))
  return out.buffer
}

export function bytesToPcm(buffer) {
  const src = new Int16Array(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer)
  return Float32Array.from(src, v => v / 32767)
}

function meanUnit(list) {
  const mean = new Float32Array(list[0].length)
  for (const e of list) for (let i = 0; i < mean.length; i++) mean[i] += e[i]
  return unit(mean)
}

export async function buildPrint(speaker, segments, onProgress = () => {}, cap = 0.42) {
  const win = Math.round(WINDOW_SECONDS * RATE)
  const hop = Math.round(win / 2)
  const centroids = []
  const heldOut = []
  let total = 0
  for (const audio of segments) total += Math.max(0, Math.floor((audio.length - win) / hop) + 1)
  let done = 0
  for (const audio of segments) {
    const embeddings = []
    for (let at = 0; at + win <= audio.length; at += hop) {
      const part = audio.subarray(at, at + win)
      if (rms(part) > VAD_RMS) embeddings.push(await speaker.embed(part))
      onProgress(++done / Math.max(1, total))
    }
    if (embeddings.length < 4) continue
    centroids.push(meanUnit(embeddings))
    const even = embeddings.filter((_, i) => i % 2 === 0)
    const odd = embeddings.filter((_, i) => i % 2 === 1)
    const evenCentroid = meanUnit(even)
    const oddCentroid = meanUnit(odd)
    for (const e of odd) heldOut.push(cosine(e, evenCentroid))
    for (const e of even) heldOut.push(cosine(e, oddCentroid))
  }
  if (!centroids.length) throw new Error('Not enough speech was captured. Please read the paragraph again.')
  const mu = heldOut.reduce((a, b) => a + b, 0) / heldOut.length
  const sigma = Math.sqrt(heldOut.reduce((a, b) => a + (b - mu) ** 2, 0) / heldOut.length)
  return {
    id: crypto.randomUUID(),
    centroids: centroids.map(c => Array.from(c)),
    thr: Math.min(cap, Math.max(0.3, mu - 2.5 * sigma)),
    mu,
    sigma,
    windows: heldOut.length,
    created: Date.now()
  }
}

export class Enroller {
  constructor(ctx, source, onProgress) {
    this.speech = []
    this.seconds = 0
    this.hang = 0
    this.onProgress = onProgress
    this.tap = createTap(ctx, source, chunk => this.push(chunk))
  }

  push(chunk) {
    if (rms(chunk) > VAD_RMS) {
      this.hang = 3
      this.speech.push(chunk)
      this.seconds += CHUNK_SECONDS
      this.onProgress(this.seconds)
    } else if (this.hang > 0) {
      this.hang--
      this.speech.push(chunk)
    }
  }

  stop() {
    this.tap.stop()
    return concat(this.speech)
  }
}

export class VoiceGate {
  constructor(ctx, source, gate, voiceprint, speaker, onState) {
    this.ctx = ctx
    this.source = source
    this.gate = gate
    this.centroids = voiceprint.centroids.map(c => Float32Array.from(c))
    this.printId = voiceprint.id
    this.thr = voiceprint.thr
    this.speaker = speaker
    this.quick = speaker.provider !== 'webgpu'
    this.onState = onState
    this.ring = new Float32Array(Math.round(RATE * 3))
    this.flags = []
    this.t = 0
    this.silence = 10
    this.burstStart = -10
    this.lastOtherAt = -100
    this.verdict = 'unknown'
    this.sim = 0
    this.open = false
    this.busy = false
    this.tick = 0
  }

  async start() {
    this.gate.gain.value = 0
    this.tap = createTap(this.ctx, this.source, chunk => this.push(chunk))
  }

  stop() {
    if (this.tap) this.tap.stop()
    this.tap = null
  }

  push(chunk) {
    this.t += CHUNK_SECONDS
    this.ring.copyWithin(0, chunk.length)
    this.ring.set(chunk, this.ring.length - chunk.length)
    const speech = rms(chunk) > VAD_RMS
    this.flags.push(speech)
    if (this.flags.length > 16) this.flags.shift()
    if (speech) {
      if (this.silence >= 0.4) {
        this.burstStart = this.t
        this.verdict = 'unknown'
      }
      this.silence = 0
    } else {
      this.silence += CHUNK_SECONDS
    }
    if (++this.tick % (this.verdict === 'unknown' ? 2 : 4) === 0) this.verify()
    this.decide()
  }

  async verify() {
    if (this.busy || !this.tap) return
    const speechChunks = this.flags.filter(Boolean).length
    if (speechChunks < (this.quick ? 5 : 8)) return
    const short = this.quick && speechChunks < 8
    const n = Math.round((short ? 1 : WINDOW_SECONDS) * RATE)
    const thr = short ? this.thr - 0.05 : this.thr
    this.busy = true
    try {
      const emb = await this.speaker.embed(this.ring.subarray(this.ring.length - n))
      this.sim = Math.max(...this.centroids.map(c => cosine(emb, c)))
      const was = this.verdict
      if (this.sim >= thr) this.verdict = 'me'
      else if (was !== 'me' || this.sim < thr - 0.05) this.verdict = 'other'
      if (this.verdict === 'other') this.lastOtherAt = this.t
    } catch {
    } finally {
      this.busy = false
    }
  }

  decide() {
    const grace = this.quick && this.t - this.lastOtherAt < 4 ? 0.4 : 0.8
    let open
    if (this.silence > 0.4) open = false
    else if (this.verdict === 'me') open = true
    else if (this.verdict === 'other') open = false
    else open = this.t - this.burstStart < grace
    if (open !== this.open) {
      this.open = open
      this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? 0.01 : 0.05)
    }
    this.onState({ open: this.open, verdict: this.verdict, sim: this.sim })
  }
}
