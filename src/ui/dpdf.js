const MODELS = {
  dpdfnet_baseline: { win: 320, rate: 16000 },
  dpdfnet2_48khz_hr: { win: 960, rate: 48000 }
}

const TAPS = 33
const HALF_TAPS = (TAPS - 1) / 2

function lowpass(gain) {
  const fc = 7000 / 48000
  const k = new Float64Array(TAPS)
  let sum = 0
  for (let i = 0; i < TAPS; i++) {
    const n = i - HALF_TAPS
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n)
    k[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)))
    sum += k[i]
  }
  for (let i = 0; i < TAPS; i++) k[i] = (k[i] * gain) / sum
  return k
}

class Down3 {
  constructor() {
    this.k = lowpass(1)
    this.hist = new Float64Array(TAPS - 1)
  }

  process(input) {
    const n = input.length
    const ext = new Float64Array(TAPS - 1 + n)
    ext.set(this.hist)
    ext.set(input, TAPS - 1)
    const out = new Float32Array(n / 3)
    for (let j = 0; j < out.length; j++) {
      let acc = 0
      for (let t = 0; t < TAPS; t++) acc += this.k[t] * ext[3 * j + t]
      out[j] = acc
    }
    this.hist.set(ext.subarray(n))
    return out
  }
}

class Up3 {
  constructor() {
    this.k = lowpass(3)
    this.hist = new Float64Array(TAPS - 1)
  }

  process(input) {
    const n = input.length * 3
    const ext = new Float64Array(TAPS - 1 + n)
    ext.set(this.hist)
    for (let i = 0; i < input.length; i++) ext[TAPS - 1 + 3 * i] = input[i]
    const out = new Float32Array(n)
    for (let j = 0; j < n; j++) {
      let acc = 0
      for (let t = 0; t < TAPS; t++) acc += this.k[t] * ext[j + t]
      out[j] = acc
    }
    this.hist.set(ext.subarray(n))
    return out
  }
}

function readVarint(buf, pos) {
  let result = 0
  let shift = 0
  for (;;) {
    const b = buf[pos++]
    result += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return [result, pos]
    shift += 7
  }
}

export function onnxMetadata(buf) {
  const meta = {}
  const decoder = new TextDecoder()
  let pos = 0
  while (pos < buf.length) {
    let tag
    ;[tag, pos] = readVarint(buf, pos)
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      ;[, pos] = readVarint(buf, pos)
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 5) {
      pos += 4
    } else if (wire === 2) {
      let len
      ;[len, pos] = readVarint(buf, pos)
      if (field === 14) {
        let p = pos
        const end = pos + len
        let key = ''
        let value = ''
        while (p < end) {
          let t
          ;[t, p] = readVarint(buf, p)
          let l
          ;[l, p] = readVarint(buf, p)
          const text = decoder.decode(buf.subarray(p, p + l))
          if (t >>> 3 === 1) key = text
          else value = text
          p += l
        }
        meta[key] = value
      }
      pos += len
    } else {
      throw new Error('unsupported protobuf wire type ' + wire)
    }
  }
  return meta
}

function makeFft(n) {
  const factors = []
  let m = n
  for (const p of [4, 2, 3, 5]) {
    while (m % p === 0) {
      factors.push(p)
      m /= p
    }
  }
  if (m !== 1) throw new Error('unsupported FFT size ' + n)
  const cos = new Float64Array(n)
  const sin = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = -Math.sin((2 * Math.PI * i) / n)
  }
  const tr = new Float64Array(8)
  const ti = new Float64Array(8)
  function rec(inRe, inIm, inOff, stride, outRe, outIm, outOff, size, level) {
    if (size === 1) {
      outRe[outOff] = inRe[inOff]
      outIm[outOff] = inIm[inOff]
      return
    }
    const p = factors[level]
    const sub = size / p
    for (let q = 0; q < p; q++) rec(inRe, inIm, inOff + q * stride, stride * p, outRe, outIm, outOff + q * sub, sub, level + 1)
    const step = n / size
    for (let k = 0; k < sub; k++) {
      for (let q = 0; q < p; q++) {
        const idx = (q * k * step) % n
        const re = outRe[outOff + q * sub + k]
        const im = outIm[outOff + q * sub + k]
        tr[q] = re * cos[idx] - im * sin[idx]
        ti[q] = re * sin[idx] + im * cos[idx]
      }
      for (let r = 0; r < p; r++) {
        let sr = 0
        let si = 0
        for (let q = 0; q < p; q++) {
          const idx = ((q * r * (size / p)) % size) * step
          sr += tr[q] * cos[idx] - ti[q] * sin[idx]
          si += tr[q] * sin[idx] + ti[q] * cos[idx]
        }
        outRe[outOff + r * sub + k] = sr
        outIm[outOff + r * sub + k] = si
      }
    }
  }
  const scratchRe = new Float64Array(n)
  const scratchIm = new Float64Array(n)
  return (re, im, inverse) => {
    if (inverse) for (let i = 0; i < n; i++) im[i] = -im[i]
    rec(re, im, 0, 1, scratchRe, scratchIm, 0, n, 0)
    for (let i = 0; i < n; i++) {
      re[i] = scratchRe[i]
      im[i] = inverse ? -scratchIm[i] : scratchIm[i]
    }
  }
}

export class StreamDenoiser {
  static async create(ort, bytes, name, options = {}) {
    const info = MODELS[name]
    if (!info) throw new Error('unknown denoiser model ' + name)
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: options.providers || ['wasm'],
      graphOptimizationLevel: 'all'
    })
    return new StreamDenoiser(ort, session, onnxMetadata(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)), info)
  }

  constructor(ort, session, meta, info) {
    const win = info.win
    this.ort = ort
    this.session = session
    this.win = win
    this.rate = info.rate
    this.down = new Down3()
    this.up = new Up3()
    this.hop = win / 2
    this.bins = win / 2 + 1
    this.fft = makeFft(win)
    this.window = Float64Array.from({ length: win }, (_, i) => {
      const s = Math.sin((0.5 * Math.PI * (i + 0.5)) / (win / 2))
      return Math.sin(0.5 * Math.PI * s * s)
    })
    this.initState = new Float32Array(Number(meta.state_size))
    const erbSize = Number(meta.erb_norm_state_size)
    const specSize = Number(meta.spec_norm_state_size)
    this.initState.set(meta.erb_norm_init.split(',').map(Number), 0)
    this.initState.set(meta.spec_norm_init.split(',').map(Number), erbSize)
    if (erbSize + specSize > this.initState.length) throw new Error('inconsistent model metadata')
    this.re = new Float64Array(win)
    this.im = new Float64Array(win)
    this.spec = new Float32Array(this.bins * 2)
    this.reset()
  }

  reset() {
    this.down = new Down3()
    this.up = new Up3()
    this.state = this.initState.slice()
    this.inBuf = new Float64Array(this.win)
    this.outBuf = new Float64Array(this.win)
    this.primed = 0
  }

  async process48(hop48) {
    if (this.rate === 48000) return this.process(hop48)
    const out = await this.process(this.down.process(hop48))
    return this.up.process(out)
  }

  async process(hopSamples) {
    const { win, hop, bins, re, im, window } = this
    this.inBuf.copyWithin(0, hop)
    for (let i = 0; i < hop; i++) this.inBuf[hop + i] = hopSamples[i]
    this.primed += hop
    if (this.primed < win) return new Float32Array(hop)
    for (let i = 0; i < win; i++) {
      re[i] = this.inBuf[i] * window[i]
      im[i] = 0
    }
    this.fft(re, im, false)
    for (let k = 0; k < bins; k++) {
      this.spec[2 * k] = re[k]
      this.spec[2 * k + 1] = im[k]
    }
    const out = await this.session.run({
      spec: new this.ort.Tensor('float32', this.spec, [1, 1, bins, 2]),
      state_in: new this.ort.Tensor('float32', this.state, [this.state.length])
    })
    this.state = out.state_out.data
    const enhanced = out.spec_e.data
    for (let k = 0; k < bins; k++) {
      re[k] = enhanced[2 * k]
      im[k] = enhanced[2 * k + 1]
    }
    for (let k = 1; k < win - bins + 1; k++) {
      re[win - k] = re[k]
      im[win - k] = -im[k]
    }
    this.fft(re, im, true)
    for (let i = 0; i < win; i++) this.outBuf[i] += (re[i] / win) * window[i]
    const committed = new Float32Array(hop)
    for (let i = 0; i < hop; i++) committed[i] = this.outBuf[i]
    this.outBuf.copyWithin(0, hop)
    this.outBuf.fill(0, win - hop)
    return committed
  }
}
