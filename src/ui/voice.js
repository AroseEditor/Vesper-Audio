const RATE = 16000
const WIN = 400
const SHIFT = 160
const NFFT = 512
const HALF = NFFT / 2
const MELS = 80
const VAD_RMS = 0.006
const WINDOW_SECONDS = 1.6
const CHUNK_SECONDS = 0.1

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

function unit(v) {
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

export async function loadSpeaker(url) {
  const ort = await import('./vendor/ort.min.mjs')
  ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  const session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  return {
    async embed(samples) {
      const feats = fbank(samples)
      const frames = feats.length / MELS
      if (!frames) throw new Error('audio too short for embedding')
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', feats, [1, frames, MELS]) })
      return unit(out[session.outputNames[0]].data)
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

  async finish(speaker) {
    this.tap.stop()
    const audio = concat(this.speech)
    const win = Math.round(WINDOW_SECONDS * RATE)
    const hop = Math.round(win / 2)
    const embeddings = []
    for (let at = 0; at + win <= audio.length; at += hop) {
      const part = audio.subarray(at, at + win)
      if (rms(part) > VAD_RMS) embeddings.push(await speaker.embed(part))
    }
    if (embeddings.length < 6) throw new Error('Not enough speech was captured. Please read the paragraph again.')
    const mean = new Float32Array(embeddings[0].length)
    for (const e of embeddings) for (let i = 0; i < mean.length; i++) mean[i] += e[i]
    const centroid = unit(mean)
    const sims = embeddings.map(e => cosine(e, centroid))
    const mu = sims.reduce((a, b) => a + b, 0) / sims.length
    const sigma = Math.sqrt(sims.reduce((a, b) => a + (b - mu) ** 2, 0) / sims.length)
    return {
      id: crypto.randomUUID(),
      emb: Array.from(centroid),
      thr: Math.min(0.5, Math.max(0.35, mu - 2.5 * sigma)),
      mu,
      sigma,
      windows: embeddings.length,
      created: Date.now()
    }
  }

  cancel() {
    this.tap.stop()
  }
}

export class VoiceGate {
  constructor(ctx, source, gate, voiceprint, speaker, onState) {
    this.ctx = ctx
    this.source = source
    this.gate = gate
    this.print = Float32Array.from(voiceprint.emb)
    this.printId = voiceprint.id
    this.thr = voiceprint.thr
    this.speaker = speaker
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
    if (++this.tick % 3 === 0) this.verify()
    this.decide()
  }

  async verify() {
    if (this.busy || !this.tap) return
    if (this.flags.filter(Boolean).length < 8) return
    this.busy = true
    try {
      const n = Math.round(WINDOW_SECONDS * RATE)
      const emb = await this.speaker.embed(this.ring.slice(this.ring.length - n))
      this.sim = cosine(emb, this.print)
      const was = this.verdict
      if (this.sim >= this.thr) this.verdict = 'me'
      else if (was !== 'me' || this.sim < this.thr - 0.05) this.verdict = 'other'
      if (this.verdict === 'other') this.lastOtherAt = this.t
    } catch {
    } finally {
      this.busy = false
    }
  }

  decide() {
    const grace = this.t - this.lastOtherAt < 4 ? 0.25 : 0.8
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
