const MIN_HOPS = 1
const MAX_HOPS = 9
const RING_HOPS = 40
const POOL_MAX = 24
const FADE_IN = 96
const HOLD_DECAY = 0.9
const QUIET = 0.003
const CALM_BLOCKS = 5600
const STAT_BLOCKS = 375

class Denoise extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions
    this.hop = o.hop
    this.ring = new Float32Array(this.hop * RING_HOPS)
    this.rd = 0
    this.wr = 0
    this.fill = 0
    this.minHops = o.minHops || MIN_HOPS
    this.maxHops = o.maxHops || MAX_HOPS
    this.calmBlocks = o.calmBlocks || CALM_BLOCKS
    this.target = Math.max(this.minHops, o.prebuffer) * this.hop
    this.playing = false
    this.started = false
    this.ramp = FADE_IN
    this.last = 0
    this.pool = []
    for (let i = 0; i < 12; i++) this.pool.push(new Float32Array(this.hop))
    this.inBuf = this.pool.pop()
    this.inFill = 0
    this.underruns = 0
    this.rebuffers = 0
    this.drops = 0
    this.calm = 0
    this.blocks = 0
    this.link = null
    this.port.onmessage = e => {
      if (e.data.type === 'link') {
        this.link = e.data.port
        this.link.onmessage = m => this.accept(m.data)
      }
    }
  }

  accept(hop) {
    if (this.fill + this.hop > this.ring.length) {
      this.drops++
      this.recycle(hop)
      return
    }
    let w = this.wr
    const ring = this.ring
    for (let i = 0; i < this.hop; i++) {
      ring[w] = hop[i]
      if (++w === ring.length) w = 0
    }
    this.wr = w
    this.fill += this.hop
    this.recycle(hop)
  }

  recycle(buf) {
    if (this.pool.length < POOL_MAX && buf.length === this.hop) this.pool.push(buf)
  }

  nextBuffer() {
    return this.pool.length ? this.pool.pop() : new Float32Array(this.hop)
  }

  hopIsQuiet() {
    let peak = 0
    let r = this.rd
    for (let i = 0; i < this.hop; i++) {
      const v = Math.abs(this.ring[r])
      if (v > peak) peak = v
      if (++r === this.ring.length) r = 0
    }
    return peak < QUIET
  }

  skipHop() {
    this.rd = (this.rd + this.hop) % this.ring.length
    this.fill -= this.hop
    this.drops++
  }

  trim() {
    if (!this.playing) return
    const extra = this.fill - this.target
    if (extra > this.hop * 8) {
      while (this.fill > this.target + this.hop) this.skipHop()
      this.ramp = 0
    } else if (extra > this.hop * 2 && this.hopIsQuiet()) {
      this.skipHop()
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0][0]
    if (input && this.link) {
      for (let i = 0; i < input.length; i++) {
        this.inBuf[this.inFill++] = input[i]
        if (this.inFill === this.hop) {
          this.link.postMessage(this.inBuf, [this.inBuf.buffer])
          this.inBuf = this.nextBuffer()
          this.inFill = 0
        }
      }
    }
    this.trim()
    const ring = this.ring
    for (let i = 0; i < output.length; i++) {
      if (!this.playing) {
        if (this.fill >= this.target) {
          this.playing = true
          this.started = true
          this.ramp = 0
        } else {
          if (this.started) this.underruns++
          this.last *= HOLD_DECAY
          output[i] = this.last
          continue
        }
      }
      if (this.fill === 0) {
        this.playing = false
        this.underruns++
        this.rebuffers++
        this.calm = 0
        this.target = Math.min(this.maxHops * this.hop, this.target + this.hop)
        this.last *= HOLD_DECAY
        output[i] = this.last
        continue
      }
      let v = ring[this.rd]
      if (++this.rd === ring.length) this.rd = 0
      this.fill--
      if (this.ramp < FADE_IN) v *= ++this.ramp / FADE_IN
      this.last = v
      output[i] = v
    }
    if (this.playing && ++this.calm > this.calmBlocks && this.target > this.minHops * this.hop) {
      this.target -= this.hop
      this.calm = 0
    }
    if (++this.blocks % STAT_BLOCKS === 0) {
      this.port.postMessage({ type: 'stats', underruns: this.underruns, queued: Math.round(this.fill / this.hop), target: this.target, drops: this.drops, rebuffers: this.rebuffers })
    }
    return true
  }
}

registerProcessor('vesper-denoise', Denoise)
