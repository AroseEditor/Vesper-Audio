export const VAD_FRAME = 512
const CONTEXT = 64
const STATE_SIZE = 2 * 128

export class Vad {
  constructor(ort, session) {
    this.ort = ort
    this.session = session
    this.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [])
    this.reset()
  }

  static async create(ort, bytes, options) {
    return new Vad(ort, await ort.InferenceSession.create(bytes, options))
  }

  reset() {
    this.state = new Float32Array(STATE_SIZE)
    this.context = new Float32Array(CONTEXT)
    this.rest = new Float32Array(0)
  }

  async push(samples) {
    const all = new Float32Array(this.rest.length + samples.length)
    all.set(this.rest)
    all.set(samples, this.rest.length)
    const probs = []
    let at = 0
    while (at + VAD_FRAME <= all.length) {
      const input = new Float32Array(CONTEXT + VAD_FRAME)
      input.set(this.context)
      input.set(all.subarray(at, at + VAD_FRAME), CONTEXT)
      const out = await this.session.run({
        input: new this.ort.Tensor('float32', input, [1, CONTEXT + VAD_FRAME]),
        state: new this.ort.Tensor('float32', this.state, [2, 1, 128]),
        sr: this.sr
      })
      this.state = Float32Array.from(out.stateN.data)
      probs.push(out.output.data[0])
      this.context = all.slice(at + VAD_FRAME - CONTEXT, at + VAD_FRAME)
      at += VAD_FRAME
    }
    this.rest = all.slice(at)
    return probs
  }
}
