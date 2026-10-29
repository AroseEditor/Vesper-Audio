const RING = 131072
const FRAME = 480
const START_TARGET = 1440
const MIN_TARGET = 960
const MAX_TARGET = 5760
const STEP = 240
const CALM_BLOCKS = 3750
const STAT_BLOCKS = 375
const MAX_RATE_SKEW = 0.004
const CONCEAL_FRAMES = 5

class PhoneIn extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ring = new Float32Array(RING)
    this.wr = 0
    this.rp = 0
    this.target = START_TARGET
    this.playing = false
    this.muted = false
    this.underruns = 0
    this.drops = 0
    this.calm = 0
    this.blocks = 0
    this.last = new Float32Array(FRAME)
    this.held = 0
    this.port.onmessage = e => {
      const m = e.data
      if (m.type === 'pcm') this.accept(m.pcm, m.lost | 0)
      else if (m.type === 'mute') this.mute(Boolean(m.on))
    }
  }

  mute(on) {
    this.muted = on
    this.playing = false
    this.rp = this.wr
    this.held = 0
  }

  put(samples) {
    if (this.wr - this.rp > RING - samples.length * 2) {
      this.drops++
      return
    }
    for (let i = 0; i < samples.length; i++) this.ring[this.wr++ % RING] = samples[i]
  }

  accept(bytes, lost) {
    if (this.muted) return
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = Math.min(FRAME * 2, bytes.byteLength >> 1)
    const frame = new Float32Array(count)
    for (let i = 0; i < count; i++) frame[i] = view.getInt16(i * 2, true) / 32768
    const conceal = Math.min(lost, CONCEAL_FRAMES)
    for (let k = 1; k <= conceal; k++) {
      const gain = Math.pow(0.6, k)
      const patch = new Float32Array(this.last.length)
      for (let i = 0; i < patch.length; i++) patch[i] = this.last[i] * gain
      this.put(patch)
    }
    this.put(frame)
    this.last = frame.length === FRAME ? frame : this.last
  }

  process(inputs, outputs) {
    const out = outputs[0][0]
    const n = out.length
    if (this.muted) {
      out.fill(0)
      return true
    }
    let avail = this.wr - this.rp
    if (!this.playing) {
      if (avail >= this.target) this.playing = true
      else {
        this.held *= 0.9
        out.fill(this.held)
        this.report()
        return true
      }
    }
    const skew = Math.max(-MAX_RATE_SKEW, Math.min(MAX_RATE_SKEW, ((avail - this.target) / 48000) * 0.5))
    const rate = 1 + skew
    for (let i = 0; i < n; i++) {
      if (this.wr - this.rp < 2) {
        this.playing = false
        this.underruns++
        this.calm = 0
        this.target = Math.min(MAX_TARGET, this.target + STEP)
        for (let j = i; j < n; j++) out[j] = 0
        break
      }
      const idx = Math.floor(this.rp)
      const frac = this.rp - idx
      const a = this.ring[idx % RING]
      const b = this.ring[(idx + 1) % RING]
      const v = a + (b - a) * frac
      out[i] = v
      this.held = v
      this.rp += rate
    }
    if (this.playing && ++this.calm > CALM_BLOCKS && this.target > MIN_TARGET) {
      this.target -= STEP
      this.calm = 0
    }
    this.report()
    return true
  }

  report() {
    if (++this.blocks % STAT_BLOCKS === 0) {
      this.port.postMessage({ type: 'stats', underruns: this.underruns, fillMs: Math.round(((this.wr - this.rp) / 48000) * 1000), targetMs: Math.round((this.target / 48000) * 1000), drops: this.drops })
    }
  }
}

registerProcessor('vesper-phone', PhoneIn)
