import { RnnoiseWorkletNode, loadRnnoise } from './vendor/noise.js'
import { VoiceGate } from './voice.js'

const SPEEX_ID = '@sapphi-red/web-noise-suppressor/speex'
const HOP = 480
const PREBUFFER_HOPS = 2
const DFN3_DRY_DELAY = 0.052
const DPDFNET_DRY_DELAY = 0.082
const MAX_ATTENUATION_DB = 45
const MAKEUP_DB = { rnnoise: 7, speex: 2, dfn3: 0, dpdfnet: 0 }
const WATCH_MS = 2000
const WATCH_WARMUP_S = 8
const WATCH_STRIKES = 3
const db = v => Math.pow(10, v / 20)
const asset = file => new URL(file, import.meta.url).href

function leak(strength) {
  return strength >= 99 ? 0 : Math.pow(10, -((Math.max(0, strength) / 100) * MAX_ATTENUATION_DB) / 20)
}

async function listDevices(kind) {
  let list = await navigator.mediaDevices.enumerateDevices()
  if (!list.some(d => d.kind === kind && d.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach(t => t.stop())
    list = await navigator.mediaDevices.enumerateDevices()
  }
  return list.filter(d => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
}

export async function resolveDevice(kind, name) {
  if (!name) return ''
  const real = await listDevices(kind)
  const hit = real.find(d => d.label === name) || real.find(d => d.label && (d.label.includes(name) || name.includes(d.label)))
  return hit ? hit.deviceId : ''
}

function modeOf(cfg) {
  if (cfg.ai) return cfg.aiPreset === 'heavy' ? 'heavy' : cfg.aiPreset === 'clearcast' ? 'clearcast' : 'custom'
  if (cfg.basic) return cfg.basicPreset === 'speex' ? 'speex' : 'rnnoise'
  return 'off'
}

export class Engine {
  constructor() {
    this.ctx = null
    this.cfg = null
    this.structKey = ''
    this.mode = ''
    this.active = ''
    this.fx = []
    this.fxNodes = {}
    this.disposers = []
    this.wasm = {}
    this.buffers = new Map()
    this.playing = new Map()
    this.voice = null
    this.pending = null
    this.draining = null
    this.onSoundEnd = () => {}
    this.onVoiceState = () => {}
    this.stats = { underruns: 0, queued: 0, backlog: 0 }
    this.forceLight = false
    this.watch = null
    this.state = { running: false, hasCable: false, error: '', warning: '', denoiser: '' }
  }

  apply(cfg) {
    this.pending = cfg
    if (!this.draining) {
      this.draining = (async () => {
        while (this.pending) {
          const next = this.pending
          this.pending = null
          try {
            await this.run(next)
          } catch (err) {
            this.state.error = String((err && err.message) || err)
            this.state.running = false
            await this.teardown()
          }
        }
        this.draining = null
      })()
    }
    return this.draining
  }

  async run(cfg) {
    const key = [cfg.inputName, cfg.cableName].join('|')
    if (!this.ctx || key !== this.structKey) {
      await this.build(cfg)
      this.structKey = key
    }
    this.cfg = cfg
    await this.chain(cfg)
    await this.route(cfg)
    this.state.error = ''
  }

  async build(cfg) {
    await this.teardown()
    if (!cfg.inputName) throw new Error('No input device selected')
    const inputId = await resolveDevice('audioinput', cfg.inputName)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    })
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    await Promise.all(['./tap.worklet.js', './denoise.worklet.js', './vendor/rnnoise.worklet.js', './vendor/speex.worklet.js'].map(f => ctx.audioWorklet.addModule(asset(f))))
    this.stream = stream
    this.ctx = ctx
    this.src = ctx.createMediaStreamSource(stream)
    this.gain = ctx.createGain()
    this.fxIn = ctx.createGain()
    this.fxOut = ctx.createGain()
    this.gate = ctx.createGain()
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -2
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.12
    this.micOut = ctx.createGain()
    this.monitorGain = ctx.createGain()
    this.bus = ctx.createGain()
    this.sbBus = ctx.createGain()
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.outAnalyser = ctx.createAnalyser()
    this.outAnalyser.fftSize = 1024
    this.sink = ctx.createMediaStreamDestination()
    this.monitorDest = ctx.createMediaStreamDestination()
    this.sbDest = ctx.createMediaStreamDestination()
    this.src.connect(this.gain)
    this.gain.connect(this.fxIn)
    this.gain.connect(this.analyser)
    this.fxOut.connect(this.gate)
    this.gate.connect(this.limiter)
    this.limiter.connect(this.micOut)
    this.micOut.connect(this.bus)
    this.micOut.connect(this.monitorGain)
    this.micOut.connect(this.outAnalyser)
    this.monitorGain.connect(this.monitorDest)
    this.sbBus.connect(this.bus)
    this.sbBus.connect(this.sbDest)
    this.bus.connect(this.sink)
    const cableId = await resolveDevice('audiooutput', cfg.cableName)
    this.state.hasCable = Boolean(cableId)
    if (cableId) {
      await ctx.setSinkId(cableId)
      this.bus.connect(ctx.destination)
    }
    this.monitorEl = new Audio()
    this.monitorEl.srcObject = this.monitorDest.stream
    this.sbEl = new Audio()
    this.sbEl.srcObject = this.sbDest.stream
    this.mode = ''
    this.state.running = true
    if (ctx.state === 'suspended') await ctx.resume()
  }

  async wasmBinary(name) {
    if (!this.wasm[name]) {
      const url = asset(`./vendor/${name}.wasm`)
      this.wasm[name] = name === 'rnnoise' ? await loadRnnoise({ url, simdUrl: asset('./vendor/rnnoise_simd.wasm') }) : await (await fetch(url)).arrayBuffer()
    }
    return this.wasm[name].slice(0)
  }

  async chain(cfg) {
    const mode = modeOf(cfg)
    const ctx = this.ctx
    if (mode !== this.mode || this.denoiserKey !== (mode === 'heavy' ? cfg.denoiserHeavyUrl : cfg.denoiserUrl)) {
      this.teardownFx()
      this.mode = mode
      if (!this.forceLight) this.state.warning = ''
      await this.buildFx(mode, cfg)
    }
    if (mode === 'speex' && this.fxNodes.speex) this.fxNodes.speex.port.postMessage(Math.round(cfg.speexDb))
    if (mode === 'clearcast' && this.fxNodes.wet) {
      const k = leak(cfg.aiStrength)
      this.fxNodes.wet.gain.setTargetAtTime(1 - k, ctx.currentTime, 0.02)
      this.fxNodes.dry.gain.setTargetAtTime(k, ctx.currentTime, 0.02)
    }
    this.gain.gain.setTargetAtTime(Math.max(0, cfg.gain) / 100, ctx.currentTime, 0.02)
    const gated = this.active === 'custom' || this.active === 'heavy'
    const wantVoice = gated && cfg.voiceprint && cfg.speaker
    if (wantVoice && (!this.voice || this.voice.printId !== cfg.voiceprint.id || this.voice.speaker !== cfg.speaker)) {
      if (this.voice) this.voice.stop()
      this.voice = new VoiceGate(ctx, this.fxOut, this.gate, cfg.voiceprint, cfg.speaker, s => this.onVoiceState(s))
      await this.voice.start()
    } else if (!wantVoice && this.voice) {
      this.voice.stop()
      this.voice = null
      this.gate.gain.setTargetAtTime(1, ctx.currentTime, 0.02)
    }
  }

  async denoiser(options) {
    const ctx = this.ctx
    const worker = new Worker(asset('./denoise.worker.js'), { type: 'module' })
    const channel = new MessageChannel()
    const node = new AudioWorkletNode(ctx, 'vesper-denoise', {
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { hop: HOP, prebuffer: PREBUFFER_HOPS }
    })
    node.port.postMessage({ type: 'link', port: channel.port1 }, [channel.port1])
    node.port.onmessage = e => {
      if (e.data.type === 'stats') {
        this.stats.underruns = e.data.underruns
        this.stats.queued = e.data.queued
      }
    }
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = e => {
        const m = e.data
        if (m.type === 'ready') resolve(m)
        else if (m.type === 'error') reject(new Error(m.message))
        else if (m.type === 'stats') this.stats.backlog = m.backlog
      }
      worker.onerror = e => reject(new Error(e.message || 'denoise worker failed'))
    })
    worker.postMessage({ type: 'init', port: channel.port2, ...options }, [channel.port2])
    try {
      const info = await ready
      if (info.hop !== HOP) throw new Error('unexpected denoiser frame size ' + info.hop)
    } catch (err) {
      worker.terminate()
      node.disconnect()
      throw err
    }
    this.disposers.push(() => worker.terminate())
    return node
  }

  async buildFx(mode, cfg) {
    const ctx = this.ctx
    const add = (...nodes) => this.fx.push(...nodes)
    this.active = mode
    this.denoiserKey = mode === 'heavy' ? cfg.denoiserHeavyUrl : cfg.denoiserUrl
    this.state.denoiser = ''
    this.fxOut.gain.value = 1
    if (mode === 'off') {
      this.fxIn.connect(this.fxOut)
    } else if (mode === 'rnnoise') {
      this.fxOut.gain.value = db(MAKEUP_DB.rnnoise)
      const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await this.wasmBinary('rnnoise') })
      this.fxIn.connect(node).connect(this.fxOut)
      add(node)
      this.fxNodes = { rnnoise: node }
    } else if (mode === 'speex') {
      this.fxOut.gain.value = db(MAKEUP_DB.speex)
      const node = new AudioWorkletNode(ctx, SPEEX_ID, {
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { maxChannels: 1, wasmBinary: await this.wasmBinary('speex'), noiseSuppress: Math.round(cfg.speexDb) }
      })
      this.fxIn.connect(node).connect(this.fxOut)
      add(node)
      this.fxNodes = { speex: node }
    } else {
      const { node, kind } = await this.aiDenoiser(cfg)
      this.state.denoiser = kind
      this.fxOut.gain.value = db(MAKEUP_DB[kind])
      const wet = ctx.createGain()
      const dry = ctx.createGain()
      const delay = ctx.createDelay(0.5)
      delay.delayTime.value = kind === 'dpdfnet' ? DPDFNET_DRY_DELAY : DFN3_DRY_DELAY
      const k = mode === 'clearcast' ? leak(cfg.aiStrength) : 0
      wet.gain.value = 1 - k
      dry.gain.value = k
      this.fxIn.connect(node).connect(wet).connect(this.fxOut)
      this.fxIn.connect(delay).connect(dry).connect(this.fxOut)
      add(node, wet, dry, delay)
      this.fxNodes = { denoise: node, wet, dry }
      if (kind === 'dpdfnet') this.startWatch()
    }
  }

  async aiDenoiser(cfg) {
    const heavy = this.active === 'heavy'
    const url = heavy ? cfg.denoiserHeavyUrl : cfg.denoiserUrl
    if (url && !this.forceLight) {
      try {
        const model = heavy ? 'dpdfnet2_48khz_hr' : 'dpdfnet_baseline'
        return { node: await this.denoiser({ backend: 'dpdfnet', model, modelUrl: url, provider: 'wasm' }), kind: 'dpdfnet' }
      } catch (err) {
        this.state.warning = 'The main AI model could not start (' + String((err && err.message) || err) + '). Using the built-in light model.'
      }
    } else if (!this.forceLight) {
      this.state.warning = 'The main AI model is not downloaded yet. Using the built-in light model.'
    }
    return { node: await this.denoiser({ backend: 'dfn3' }), kind: 'dfn3' }
  }

  startWatch() {
    this.stopWatch()
    let strikes = 0
    let seen = 0
    let last = this.stats.underruns
    this.watch = setInterval(() => {
      seen += WATCH_MS / 1000
      const delta = this.stats.underruns - last
      last = this.stats.underruns
      if (seen < WATCH_WARMUP_S) return
      strikes = this.stats.backlog >= 4 || delta > 2400 ? strikes + 1 : 0
      if (strikes < WATCH_STRIKES) return
      this.forceLight = true
      this.state.warning = 'Your CPU could not keep up with the main AI model, so Vesper Audio switched to the built-in light model.'
      this.stopWatch()
      this.mode = ''
      if (this.cfg) this.apply(this.cfg)
    }, WATCH_MS)
  }

  stopWatch() {
    if (this.watch) clearInterval(this.watch)
    this.watch = null
  }

  teardownFx() {
    this.stopWatch()
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    for (const n of this.fx) {
      if (typeof n.destroy === 'function') n.destroy()
      n.disconnect()
    }
    this.fx = []
    this.fxNodes = {}
    this.active = ''
    if (this.fxIn) this.fxIn.disconnect()
  }

  async route(cfg) {
    const monitorId = await resolveDevice('audiooutput', cfg.monitorName)
    for (const el of [this.monitorEl, this.sbEl]) {
      if (el.sinkId !== monitorId && el.setSinkId) await el.setSinkId(monitorId)
    }
    this.monitorGain.gain.value = cfg.monitor ? 1 : 0
    if (cfg.monitor) await this.monitorEl.play().catch(() => {})
    else this.monitorEl.pause()
    await this.sbEl.play().catch(() => {})
    this.sbBus.gain.setTargetAtTime(Math.max(0, cfg.boardVolume) / 100, this.ctx.currentTime, 0.02)
  }

  level() {
    return this.measure(this.analyser)
  }

  outLevel() {
    return this.measure(this.outAnalyser)
  }

  measure(node) {
    if (!node) return 0
    const buf = new Float32Array(node.fftSize)
    node.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const level = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9)
    return Math.min(1, Math.max(0, (level + 60) / 60))
  }

  async buffer(id, url) {
    if (!this.buffers.has(id)) {
      const bytes = await (await fetch(url)).arrayBuffer()
      this.buffers.set(id, await this.ctx.decodeAudioData(bytes))
    }
    return this.buffers.get(id)
  }

  async toggleSound(id, url, volume) {
    if (!this.ctx) throw new Error('Audio engine is not running')
    const current = this.playing.get(id)
    if (current) {
      current.stop()
      return false
    }
    const source = this.ctx.createBufferSource()
    source.buffer = await this.buffer(id, url)
    const level = this.ctx.createGain()
    level.gain.value = Math.max(0, volume) / 100
    source.connect(level).connect(this.sbBus)
    source.onended = () => {
      this.playing.delete(id)
      level.disconnect()
      this.onSoundEnd(id)
    }
    this.playing.set(id, source)
    source.start()
    return true
  }

  forget(id) {
    const current = this.playing.get(id)
    if (current) current.stop()
    this.buffers.delete(id)
  }

  async teardown() {
    if (this.voice) this.voice.stop()
    this.voice = null
    if (this.ctx) {
      for (const s of this.playing.values()) {
        try {
          s.stop()
        } catch {}
      }
      this.playing.clear()
      this.teardownFx()
      for (const el of [this.monitorEl, this.sbEl]) {
        if (el) {
          el.pause()
          el.srcObject = null
        }
      }
      await this.ctx.close().catch(() => {})
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop())
    this.ctx = null
    this.stream = null
    this.analyser = null
    this.outAnalyser = null
    this.mode = ''
    this.structKey = ''
    this.buffers.clear()
    this.state.running = false
  }
}
