const NFFT = 512
const HALF = NFFT / 2
const TAPS = 128
const EDGES = [0, 3, 6, 9, 12, 16, 20, 24, 30, 36, 44, 52, 62, 74, 88, 104, 124, 148, 176, 210, 257]
const NB = EDGES.length - 1
const COS = new Float64Array(HALF)
const SIN = new Float64Array(HALF)
for (let i = 0; i < HALF; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / NFFT)
  SIN[i] = Math.sin((2 * Math.PI * i) / NFFT)
}
const REV = new Uint16Array(NFFT)
for (let i = 0; i < NFFT; i++) {
  let r = 0
  for (let b = 0; b < 9; b++) if (i & (1 << b)) r |= 1 << (8 - b)
  REV[i] = r
}

function fft(re, im, inverse) {
  for (let i = 0; i < NFFT; i++) {
    const j = REV[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1
    const step = NFFT / size
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step]
        const wi = inverse ? SIN[k * step] : -SIN[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
  if (inverse) for (let i = 0; i < NFFT; i++) {
    re[i] /= NFFT
    im[i] /= NFFT
  }
}

class ZeroSpeex extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const p = options.processorOptions
    this.level = typeof p.noiseSuppress === 'number' ? p.noiseSuppress : -30
    this.inBuf = new Float32Array(FRAME)
    this.copy = new Float32Array(FRAME)
    this.fill = 0
    this.hist = new Float32Array(TAPS - 1)
    this.taps = new Float32Array(TAPS)
    this.taps[0] = 1
    this.next = null
    this.gains = new Float32Array(NB).fill(1)
    this.re = new Float64Array(NFFT)
    this.im = new Float64Array(NFFT)
    this.energyIn = new Float64Array(NB)
    this.energyOut = new Float64Array(NB)
    this.window = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / FRAME))
    this.env = 0
    this.open = 0
    this.prevOpen = 0
    this.state = null
    this.destroyed = false
    this.port.onmessage = e => {
      if (e.data === 'destroy') this.destroy()
      else if (typeof e.data === 'number') this.level = e.data
    }
    ;(async () => {
      const m = await o({ locateFile: e => e, wasmBinary: p.wasmBinary })
      if (this.destroyed) return
      this.state = new a(m, FRAME, sampleRate)
      this.state.denoise = true
    })()
  }

  bands(frame, out) {
    this.re.fill(0)
    this.im.fill(0)
    for (let i = 0; i < FRAME; i++) this.re[i] = frame[i] * this.window[i]
    fft(this.re, this.im, false)
    for (let b = 0; b < NB; b++) {
      let sum = 0
      for (let k = EDGES[b]; k < EDGES[b + 1]; k++) sum += this.re[k] * this.re[k] + this.im[k] * this.im[k]
      out[b] = sum
    }
  }

  design() {
    const re = this.re
    const im = this.im
    const mag = new Float64Array(HALF + 1)
    for (let b = 0; b < NB; b++) for (let k = EDGES[b]; k < EDGES[b + 1] && k <= HALF; k++) mag[k] = this.gains[b]
    for (let pass = 0; pass < 2; pass++) {
      const copy = Float64Array.from(mag)
      for (let k = 0; k <= HALF; k++) {
        let s = 0
        let n = 0
        for (let d = -3; d <= 3; d++) {
          const j = k + d
          if (j >= 0 && j <= HALF) {
            s += copy[j]
            n++
          }
        }
        mag[k] = s / n
      }
    }
    im.fill(0)
    for (let k = 0; k <= HALF; k++) {
      const v = Math.log(Math.max(mag[k], 0.02))
      re[k] = v
      if (k > 0 && k < HALF) re[NFFT - k] = v
    }
    fft(re, im, true)
    for (let n = 1; n < HALF; n++) re[n] *= 2
    for (let n = HALF + 1; n < NFFT; n++) re[n] = 0
    im.fill(0)
    fft(re, im, false)
    for (let k = 0; k < NFFT; k++) {
      const m = Math.exp(re[k])
      const ph = im[k]
      re[k] = m * Math.cos(ph)
      im[k] = m * Math.sin(ph)
    }
    fft(re, im, true)
    const taps = new Float32Array(TAPS)
    for (let n = 0; n < TAPS; n++) {
      const fade = n < TAPS - 32 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (n - (TAPS - 32))) / 32)
      taps[n] = re[n] * fade
    }
    return taps
  }

  analyse() {
    this.copy.set(this.inBuf)
    this.state.noiseSuppress = this.level
    this.state.process(this.inBuf)
    this.bands(this.copy, this.energyIn)
    this.bands(this.inBuf, this.energyOut)
    for (let b = 0; b < NB; b++) {
      const g = Math.sqrt((this.energyOut[b] + 1e-9) / (this.energyIn[b] + 1e-9))
      this.gains[b] = 0.4 * this.gains[b] + 0.6 * Math.min(1, Math.max(0.03, g))
    }
    this.next = this.design()
  }

  filter(ext, taps, i) {
    let acc = 0
    const base = i + TAPS - 1
    for (let k = 0; k < TAPS; k++) acc += taps[k] * ext[base - k]
    return acc
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0] && outputs[0][0]
    if (!output) return !this.destroyed
    const n = output.length
    if (!input) {
      output.fill(0)
      return !this.destroyed
    }
    const ext = new Float32Array(TAPS - 1 + n)
    ext.set(this.hist)
    ext.set(input, TAPS - 1)
    let sum = 0
    for (let i = 0; i < n; i++) sum += input[i] * input[i]
    const rms = Math.sqrt(sum / n)
    if (rms > this.env * 3 + 2e-4) this.open = 1
    this.env = this.env * 0.995 + rms * 0.005
    const fade = this.next
    for (let i = 0; i < n; i++) {
      let y = this.filter(ext, this.taps, i)
      if (fade) {
        const t = (i + 1) / n
        y = y * (1 - t) + this.filter(ext, fade, i) * t
      }
      const o = this.prevOpen + ((this.open - this.prevOpen) * (i + 1)) / n
      output[i] = y * (1 - o) + input[i] * o
    }
    if (fade) {
      this.taps = fade
      this.next = null
    }
    this.prevOpen = this.open
    this.open *= 0.8
    this.hist.set(ext.subarray(n))
    if (this.state) {
      for (let i = 0; i < n; i++) {
        const v = input[i]
        this.inBuf[this.fill++] = v > 1 ? 1 : v < -1 ? -1 : v
        if (this.fill === FRAME) {
          this.analyse()
          this.fill = 0
        }
      }
    }
    return !this.destroyed
  }

  destroy() {
    this.destroyed = true
    if (this.state) {
      this.state.destroy()
      this.state = null
    }
  }
}
