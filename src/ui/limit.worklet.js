const CEILING = 0.92
const HARD = 0.98
const RELEASE_S = 0.15

class Limit extends AudioWorkletProcessor {
  constructor() {
    super()
    this.env = 0
    this.release = Math.exp(-1 / (RELEASE_S * sampleRate))
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0][0]
    if (!input) {
      output.fill(0)
      return true
    }
    for (let i = 0; i < input.length; i++) {
      const x = input[i]
      const a = x < 0 ? -x : x
      this.env = a > this.env ? a : a + (this.env - a) * this.release
      let y = this.env > CEILING ? (x * CEILING) / this.env : x
      if (y > HARD) y = HARD
      else if (y < -HARD) y = -HARD
      output[i] = y
    }
    return true
  }
}

registerProcessor('vesper-limit', Limit)
