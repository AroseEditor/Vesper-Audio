export const RATE = 16000
export const CHUNK_SECONDS = 0.1
const VAD_RMS = 0.0035
const WINDOW_SECONDS = 1.6
const SHORT_SECONDS = 1.0
const GALLERY_MAX = 24
const HOLD_ME_SECONDS = 2.5
const STRONG_REJECT = 0.1

export const SENSITIVITY = {
  relaxed: { accept: -0.06, reject: -0.08 },
  balanced: { accept: 0, reject: 0 },
  strict: { accept: 0.05, reject: 0.06 }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function rms(x) {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export class GateLogic {
  constructor({ centroids, thr, speaker, sensitivity = 'balanced', onState = () => {} }) {
    const s = SENSITIVITY[sensitivity] || SENSITIVITY.balanced
    this.centroids = centroids.map(c => Float32Array.from(c))
    this.accept = clamp(thr + s.accept, 0.2, 0.62)
    this.reject = clamp(thr - 0.1 + s.reject, 0.1, this.accept - 0.05)
    this.speaker = speaker
    this.quick = speaker.provider !== 'webgpu'
    this.onState = onState
    this.ring = new Float32Array(Math.round(RATE * 3))
    this.flags = []
    this.gallery = []
    this.scores = []
    this.t = 0
    this.silence = 10
    this.lastMeAt = -100
    this.verdict = 'unknown'
    this.rejects = 0
    this.sim = 0
    this.open = false
    this.busy = false
    this.tick = 0
    this.pending = Promise.resolve()
    this.alive = true
  }

  stop() {
    this.alive = false
  }

  push(chunk) {
    this.t += CHUNK_SECONDS
    this.ring.copyWithin(0, chunk.length)
    this.ring.set(chunk, this.ring.length - chunk.length)
    const speech = rms(chunk) > VAD_RMS
    this.flags.push(speech)
    if (this.flags.length > 16) this.flags.shift()
    if (speech) {
      if (this.silence >= 0.4) this.burst()
      this.silence = 0
      if (this.verdict === 'me') this.lastMeAt = this.t
    } else {
      this.silence += CHUNK_SECONDS
    }
    if (++this.tick % (this.verdict === 'unknown' ? 2 : 4) === 0) this.pending = this.verify()
    this.decide()
  }

  burst() {
    this.scores = []
    this.rejects = 0
    if (this.verdict !== 'me' || this.t - this.lastMeAt > HOLD_ME_SECONDS) this.verdict = 'unknown'
  }

  score(embedding) {
    let best = -1
    for (const c of this.centroids) best = Math.max(best, cosine(embedding, c))
    if (this.gallery.length) {
      const sims = this.gallery.map(g => cosine(embedding, g)).sort((a, b) => b - a)
      const top = sims.slice(0, 2)
      best = Math.max(best, top.reduce((a, b) => a + b, 0) / top.length)
    }
    return best
  }

  remember(embedding) {
    this.gallery.push(embedding)
    if (this.gallery.length > GALLERY_MAX) this.gallery.shift()
  }

  async verify() {
    if (this.busy || !this.alive) return
    const speechChunks = this.flags.filter(Boolean).length
    if (speechChunks < (this.quick ? 5 : 8)) return
    const short = this.quick && speechChunks < 8
    const n = Math.round((short ? SHORT_SECONDS : WINDOW_SECONDS) * RATE)
    const offset = short ? 0.05 : 0
    this.busy = true
    try {
      const embedding = await this.speaker.embed(this.ring.subarray(this.ring.length - n))
      if (!this.alive) return
      const s = this.score(embedding)
      this.sim = s
      this.scores.push(s)
      if (this.scores.length > 3) this.scores.shift()
      const m = median(this.scores)
      const hi = this.accept - offset
      const lo = this.reject - offset
      if (s >= hi || m >= hi) {
        this.verdict = 'me'
        this.lastMeAt = this.t
        this.rejects = 0
        if (s >= hi + 0.08 && !short && speechChunks >= 12) this.remember(embedding)
      } else if (s < lo) {
        this.rejects += s < lo - STRONG_REJECT ? 2 : 1
        if (this.rejects >= 2) this.verdict = 'other'
      } else {
        this.rejects = 0
      }
    } catch {
    } finally {
      this.busy = false
    }
  }

  decide() {
    const open = this.silence <= 0.4 && this.verdict !== 'other'
    this.open = open
    this.onState({ open, verdict: this.verdict, sim: this.sim })
  }
}
