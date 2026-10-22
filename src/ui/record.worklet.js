const BLOCK = 4800

class Record extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(BLOCK)
    this.fill = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.buf[this.fill++] = input[i]
      if (this.fill === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(BLOCK)
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('vesper-record', Record)
