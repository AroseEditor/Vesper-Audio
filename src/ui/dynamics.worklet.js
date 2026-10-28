const FLOOR_DB = -55
const GATE_HYSTERESIS_DB = 6
const GATE_HOLD_S = 0.15
const GATE_OPEN_S = 0.002
const GATE_CLOSE_S = 0.08
const LEVEL_ATTACK_S = 0.002
const LEVEL_RELEASE_S = 0.025
const SLOW_ATTACK_S = 0.005
const SLOW_RELEASE_S = 0.12
const CUT_S = 0.01
const LIFT_S = 0.15
const REF_TRACK_S = 20
const REF_DRIFT_S = 60
const WARM_S = 2
const WARM_TRACK_S = 0.4
const FLOOR_START_DB = -50
const FLOOR_RISE_S = 30
const ACTIVE_DB = 12
const REF_START_DB = -26
const REF_MIN_DB = -50
const REF_MAX_DB = -8
const REF_WINDOW_DB = 15
const LOUD_START_DB = 2
const LOUD_SPAN_DB = 6
const QUIET_START_DB = 2
const QUIET_SPAN_DB = 6
const REPORT_BLOCKS = 40

const db = power => 10 * Math.log10(power + 1e-12)
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = t => t * t * (3 - 2 * t)
const step = seconds => 1 - Math.exp(-1 / (seconds * sampleRate))

class Dynamics extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.cfg = { gateOn: false, gateDb: -45, normOn: false, quietDb: 4, loudDb: -4, ...options.processorOptions }
    this.power = 0
    this.slow = 0
    this.open = true
    this.hold = 0
    this.gate = 1
    this.norm = 1
    this.ref = REF_START_DB
    this.floor = FLOOR_START_DB
    this.warm = WARM_S
    this.blocks = 0
    this.levelAttack = step(LEVEL_ATTACK_S)
    this.levelRelease = step(LEVEL_RELEASE_S)
    this.slowAttack = step(SLOW_ATTACK_S)
    this.slowRelease = step(SLOW_RELEASE_S)
    this.gateOpen = step(GATE_OPEN_S)
    this.gateClose = step(GATE_CLOSE_S)
    this.cut = step(CUT_S)
    this.lift = step(LIFT_S)
    this.port.onmessage = e => Object.assign(this.cfg, e.data)
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0][0]
    if (!input) {
      output.fill(0)
      return true
    }
    const cfg = this.cfg
    const n = input.length
    if (!cfg.gateOn && !cfg.normOn && this.gate === 1 && this.norm === 1) {
      output.set(input)
      this.open = true
      this.hold = 0
      this.ref = REF_START_DB
      this.floor = FLOOR_START_DB
      this.warm = WARM_S
      return true
    }
    let p = this.power
    let q = this.slow
    let peak = 0
    for (let i = 0; i < n; i++) {
      const e = input[i] * input[i]
      p += (e - p) * (e > p ? this.levelAttack : this.levelRelease)
      q += (e - q) * (e > q ? this.slowAttack : this.slowRelease)
      if (p > peak) peak = p
    }
    this.power = p
    this.slow = q
    const levelDb = db(peak)
    const slowDb = db(q)
    let gateTarget = 1
    if (cfg.gateOn) {
      if (levelDb > cfg.gateDb) {
        this.open = true
        this.hold = Math.ceil((GATE_HOLD_S * sampleRate) / n)
      } else if (this.hold > 0) this.hold--
      else if (levelDb < cfg.gateDb - GATE_HYSTERESIS_DB) this.open = false
      gateTarget = this.open ? 1 : 0
    } else {
      this.open = true
      this.hold = 0
    }
    let normTarget = 1
    if (!cfg.normOn) {
      this.ref = REF_START_DB
      this.floor = FLOOR_START_DB
      this.warm = WARM_S
    } else {
      const rate = seconds => 1 - Math.exp(-n / (seconds * sampleRate))
      if (slowDb < this.floor) this.floor = slowDb
      else this.floor += (slowDb - this.floor) * rate(FLOOR_RISE_S)
      if (slowDb > FLOOR_DB && slowDb > this.floor + ACTIVE_DB) {
        this.ref += (slowDb - this.ref) * rate(this.warm > 0 ? WARM_TRACK_S : slowDb > this.ref - REF_WINDOW_DB ? REF_TRACK_S : REF_DRIFT_S)
        if (this.warm > 0) this.warm -= n / sampleRate
        this.ref = Math.min(REF_MAX_DB, Math.max(REF_MIN_DB, this.ref))
      }
      const d = slowDb - this.ref
      let g = 0
      if (d > LOUD_START_DB) g = cfg.loudDb * smooth(clamp01((d - LOUD_START_DB) / LOUD_SPAN_DB))
      else if (d < -QUIET_START_DB) g = cfg.quietDb * smooth(clamp01((-d - QUIET_START_DB) / QUIET_SPAN_DB))
      normTarget = Math.pow(10, g / 20)
    }
    const gateStep = gateTarget > this.gate ? this.gateOpen : this.gateClose
    const normStep = normTarget < this.norm ? this.cut : this.lift
    let gate = this.gate
    let norm = this.norm
    for (let i = 0; i < n; i++) {
      gate += (gateTarget - gate) * gateStep
      norm += (normTarget - norm) * normStep
      output[i] = input[i] * gate * norm
    }
    this.gate = Math.abs(gateTarget - gate) < 1e-5 ? gateTarget : gate
    this.norm = Math.abs(normTarget - norm) < 1e-5 ? normTarget : norm
    if (++this.blocks % REPORT_BLOCKS === 0) this.port.postMessage({ open: this.open, level: levelDb })
    return true
  }
}

registerProcessor('vesper-dyn', Dynamics)
