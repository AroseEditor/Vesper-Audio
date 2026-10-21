const MAX_QUEUE = 8

class Denoise extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions
    this.hop = o.hop
    this.prebuffer = o.prebuffer
    this.inBuf = new Float32Array(this.hop)
    this.inFill = 0
    this.queue = []
    this.cur = null
    this.curPos = 0
    this.started = false
    this.underruns = 0
    this.blocks = 0
    this.link = null
    this.port.onmessage = e => {
      if (e.data.type === 'link') {
        this.link = e.data.port
        this.link.onmessage = m => {
          this.queue.push(m.data)
          while (this.queue.length > MAX_QUEUE) this.queue.shift()
        }
      }
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
          this.inBuf = new Float32Array(this.hop)
          this.inFill = 0
        }
      }
    }
    for (let i = 0; i < output.length; i++) {
      if (!this.cur) {
        if (!this.started) {
          if (this.queue.length >= this.prebuffer) this.started = true
          else {
            output[i] = 0
            continue
          }
        }
        this.cur = this.queue.shift()
        this.curPos = 0
        if (!this.cur) {
          this.underruns++
          output[i] = 0
          continue
        }
      }
      output[i] = this.cur[this.curPos++]
      if (this.curPos === this.hop) this.cur = null
    }
    if (++this.blocks % 375 === 0) this.port.postMessage({ type: 'stats', underruns: this.underruns, queued: this.queue.length })
    return true
  }
}

registerProcessor('vesper-denoise', Denoise)
