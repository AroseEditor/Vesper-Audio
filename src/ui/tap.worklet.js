const TAPS = 33
const DECIM = 3
const CHUNK = 1600
const cutoff = 7000 / 48000

const kernel = new Float32Array(TAPS)
let total = 0
for (let i = 0; i < TAPS; i++) {
  const n = i - (TAPS - 1) / 2
  const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n)
  kernel[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)))
  total += kernel[i]
}
for (let i = 0; i < TAPS; i++) kernel[i] /= total

class Tap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.hist = new Float32Array(TAPS - 1)
    this.phase = 0
    this.out = new Float32Array(CHUNK)
    this.fill = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    const n = input.length
    const ext = new Float32Array(TAPS - 1 + n)
    ext.set(this.hist)
    ext.set(input, TAPS - 1)
    let j = this.phase
    for (; j < n; j += DECIM) {
      let acc = 0
      for (let k = 0; k < TAPS; k++) acc += kernel[k] * ext[j + k]
      this.out[this.fill++] = acc
      if (this.fill === CHUNK) {
        this.port.postMessage(this.out, [this.out.buffer])
        this.out = new Float32Array(CHUNK)
        this.fill = 0
      }
    }
    this.phase = j - n
    this.hist.set(ext.subarray(n))
    return true
  }
}

registerProcessor('vesper-tap', Tap)
