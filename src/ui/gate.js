export const RATE = 16000
export const CHUNK_SECONDS = 0.1
const FRAME_SECONDS = 512 / RATE
const SPEECH_ON = 0.5
const SPEECH_OFF = 0.35
const HANG = 0.25
const TAIL = 0.12
const PRE = 0.08
const GALLERY_MAX = 24
const STRONG_REJECT = 0.1
const FLIP_MARGIN = 0.05
const PRIOR_SECONDS = 2
const SEGMENTS_KEPT = 24
const MIN_WINDOW = 0.5
const MAX_WINDOW = 1.6

export const LEVELS = {
  relaxed: { accept: -0.03, reject: -0.05, lookahead: 0.5, lean: true, prior: true, slope: 0.2, floor: 0.3 },
  balanced: { accept: 0.02, reject: 0.02, lookahead: 0.8, lean: false, prior: true, slope: 0.15, floor: 0.34 },
  strict: { accept: 0.05, reject: 0.06, lookahead: 1.0, lean: false, prior: false, slope: 0.15, floor: 0.36 }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export class GateLogic {
  constructor({ centroids, thr, speaker, vad, sensitivity = 'balanced', lookahead, onState = () => {} }) {
    const level = LEVELS[sensitivity] || LEVELS.balanced
    this.level = level
    this.lookahead = lookahead == null ? level.lookahead : lookahead
    this.centroids = centroids.map(c => Float32Array.from(c))
    this.accept = clamp(thr + level.accept, 0.2, 0.62)
    this.reject = clamp(thr - 0.1 + level.reject, 0.1, this.accept - 0.05)
    this.speaker = speaker
    this.vad = vad
    this.heavy = speaker.provider === 'webgpu'
    this.minSpeech = this.heavy ? 1 : MIN_WINDOW
    this.minReject = this.heavy ? 1.2 : 0.9
    this.onState = onState
    this.ring = new Float32Array(Math.round(RATE * MAX_WINDOW))
    this.gallery = []
    this.segments = []
    this.seg = null
    this.inSpeech = false
    this.lastSpeech = -100
    this.frames = 0
    this.t = 0
    this.chain = Promise.resolve()
    this.busy = false
    this.lastVerifyAt = -100
    this.sim = 0
    this.alive = true
  }

  stop() {
    this.alive = false
  }

  push(chunk) {
    if (!this.alive) return
    this.t += chunk.length / RATE
    this.ring.copyWithin(0, chunk.length)
    this.ring.set(chunk, this.ring.length - chunk.length)
    const copy = Float32Array.from(chunk)
    this.chain = this.chain.then(() => this.consume(copy)).catch(() => {})
  }

  async consume(chunk) {
    const probs = await this.vad.push(chunk)
    for (const p of probs) this.frame(p)
    if (this.seg && !this.seg.closed) this.verify()
    this.onState({ open: this.openAt(this.t - this.lookahead), verdict: this.seg ? this.seg.verdict : 'idle', sim: this.sim })
  }

  frame(p) {
    const t0 = this.frames * FRAME_SECONDS
    const t1 = t0 + FRAME_SECONDS
    this.frames++
    const speech = this.inSpeech ? p >= SPEECH_OFF : p >= SPEECH_ON
    this.inSpeech = speech
    if (speech) {
      this.lastSpeech = t1
      if (!this.seg || this.seg.closed) this.begin(t0)
      this.seg.speech += FRAME_SECONDS
    } else if (this.seg && !this.seg.closed && t1 - this.lastSpeech > HANG) {
      this.seg.closed = true
      this.seg.end = this.lastSpeech + TAIL
    }
  }

  begin(start) {
    const last = this.segments[this.segments.length - 1]
    const prior = Boolean(last && last.verdict === 'me' && last.end != null && start - last.end < PRIOR_SECONDS)
    this.seg = { start, end: null, closed: false, speech: 0, verdict: 'pending', prior, scores: [], rejects: 0 }
    this.segments.push(this.seg)
    if (this.segments.length > SEGMENTS_KEPT) this.segments.shift()
  }

  open(seg) {
    if (seg.verdict === 'me') return true
    if (seg.verdict === 'other') return false
    return this.level.lean || (seg.prior && this.level.prior)
  }

  openAt(t) {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i]
      const end = seg.closed ? seg.end : this.t
      if (t >= seg.start - PRE && t <= end) return this.open(seg)
    }
    return false
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
    const seg = this.seg
    if (this.busy || !this.alive || seg.speech < this.minSpeech || this.t - this.lastVerifyAt < 0.2) return
    this.busy = true
    this.lastVerifyAt = this.t
    try {
      const seconds = clamp(seg.speech, this.minSpeech, MAX_WINDOW)
      const n = Math.round(seconds * RATE)
      const embedding = await this.speaker.embed(this.ring.subarray(this.ring.length - n))
      if (!this.alive) return
      this.judge(seg, this.score(embedding), embedding, seconds)
    } catch {
    } finally {
      this.busy = false
    }
  }

  acceptFor(seconds) {
    return Math.max(this.level.floor, this.accept - this.level.slope * (MAX_WINDOW - seconds))
  }

  judge(seg, s, embedding, seconds) {
    this.sim = s
    seg.scores.push(s)
    if (seg.scores.length > 3) seg.scores.shift()
    const m = median(seg.scores)
    const accept = this.acceptFor(seconds)
    if (s >= accept || m >= accept) {
      seg.verdict = 'me'
      seg.rejects = 0
      if (s >= this.accept + 0.08 && seg.speech >= 1.2) this.remember(embedding)
      return
    }
    if (seg.speech < this.minReject) return
    if (seg.verdict === 'me') {
      if (s < this.reject - FLIP_MARGIN) seg.rejects++
      else seg.rejects = 0
      if (seg.rejects >= 3) seg.verdict = 'other'
      return
    }
    if (s < this.reject) {
      seg.rejects += s < this.reject - STRONG_REJECT ? 2 : 1
      if (seg.rejects >= 2) seg.verdict = 'other'
    } else {
      seg.rejects = 0
    }
    if (seg.verdict === 'pending' && seg.speech >= 2) seg.verdict = m >= (this.accept + this.reject) / 2 ? 'me' : 'other'
  }
}
