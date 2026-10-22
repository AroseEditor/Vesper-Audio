import { RnnoiseWorkletNode, loadRnnoise } from './vendor/noise.js'

const SPEEX_ID = '@sapphi-red/web-noise-suppressor/speex'
const HOP = 480
const PREBUFFER_HOPS = 2
const DFN3_MODEL_DELAY = 0.032
const DPDFNET_MODEL_DELAY = 0.062
const RELEASE_MS = 90
const HEALTH_MS = 2000
const STALL_CHECKS = 3
const FROZEN_CHECKS = 15
const FROZEN_COOLDOWN_MS = 120000
const DITHER = 3e-6
const MAX_ATTENUATION_DB = 45
const WATCH_MS = 2000
const WATCH_WARMUP_S = 8
const WATCH_STRIKES = 2
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
  if (cfg.ai) return cfg.aiPreset === 'clearcast' ? 'clearcast' : 'personal'
  if (cfg.basic) return cfg.basicPreset === 'speex' ? 'speex' : cfg.basicPreset === 'speexzero' ? 'speexzero' : 'rnnoise'
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
    this.pending = null
    this.draining = null
    this.onSoundEnd = () => {}
    this.stats = { underruns: 0, queued: 0, backlog: 0, target: PREBUFFER_HOPS * HOP, rebuffers: 0, drops: 0 }
    this.forceLight = false
    this.watch = null
    this.health = null
    this.recovering = false
    this.stall = 0
    this.lastUnderruns = 0
    this.frozen = 0
    this.lastFrozenFix = 0
    this.deviceTimer = null
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => this.deviceChanged())
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
    await Promise.all(['./limit.worklet.js', './record.worklet.js', './denoise.worklet.js', './vendor/rnnoise.worklet.js', './vendor/speex.worklet.js'].map(f => ctx.audioWorklet.addModule(asset(f))))
    this.stream = stream
    this.ctx = ctx
    this.src = ctx.createMediaStreamSource(stream)
    this.gain = ctx.createGain()
    this.fxIn = ctx.createGain()
    this.fxOut = ctx.createGain()
    this.limiter = new AudioWorkletNode(ctx, 'vesper-limit', { channelCount: 1, channelCountMode: 'explicit' })
    this.micOut = ctx.createGain()
    this.monitorGain = ctx.createGain()
    this.bus = ctx.createGain()
    this.sbBus = ctx.createGain()
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.fxAnalyser = ctx.createAnalyser()
    this.fxAnalyser.fftSize = 1024
    this.outAnalyser = ctx.createAnalyser()
    this.outAnalyser.fftSize = 1024
    this.sink = ctx.createMediaStreamDestination()
    this.sbDest = ctx.createMediaStreamDestination()
    this.src.connect(this.gain)
    this.gain.connect(this.fxIn)
    this.gain.connect(this.analyser)
    this.fxOut.connect(this.limiter)
    this.fxOut.connect(this.fxAnalyser)
    this.limiter.connect(this.micOut)
    this.micOut.connect(this.bus)
    this.micOut.connect(this.monitorGain)
    this.micOut.connect(this.outAnalyser)
    this.sbBus.connect(this.bus)
    this.sbBus.connect(this.sbDest)
    this.bus.connect(this.sink)
    this.cableEl = new Audio()
    this.cableEl.srcObject = this.sink.stream
    this.sbEl = new Audio()
    this.sbEl.srcObject = this.sbDest.stream
    this.mode = ''
    this.sinkKey = ''
    const dither = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const noise = dither.getChannelData(0)
    for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 2 * DITHER
    this.dither = ctx.createBufferSource()
    this.dither.buffer = dither
    this.dither.loop = true
    this.dither.connect(this.fxIn)
    this.dither.start()
    ctx.onstatechange = () => {
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {})
    }
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => this.recover('The microphone stopped, so Vesper Audio reconnected it.'))
    this.state.running = true
    if (ctx.state === 'suspended') await ctx.resume()
    this.startHealth()
  }

  rms(node) {
    if (!node) return 0
    const buf = new Float32Array(node.fftSize)
    node.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    return Math.sqrt(sum / buf.length)
  }

  startHealth() {
    this.stopHealth()
    this.stall = 0
    this.lastUnderruns = this.stats.underruns
    this.health = setInterval(() => this.checkHealth(), HEALTH_MS)
  }

  stopHealth() {
    if (this.health) clearInterval(this.health)
    this.health = null
  }

  checkHealth() {
    const ctx = this.ctx
    if (!ctx || this.recovering) return
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {})
    const track = this.stream && this.stream.getAudioTracks()[0]
    if (!track || track.readyState === 'ended') return this.recover('The microphone stopped, so Vesper Audio reconnected it.')
    const input = this.rms(this.analyser)
    this.frozen = input === 0 || track.muted ? this.frozen + 1 : 0
    if (this.frozen >= FROZEN_CHECKS && Date.now() - this.lastFrozenFix > FROZEN_COOLDOWN_MS) {
      this.frozen = 0
      this.lastFrozenFix = Date.now()
      return this.recover('The microphone went silent, so Vesper Audio reconnected it.')
    }
    if (this.active !== 'personal' && this.active !== 'clearcast') return
    const lost = this.stats.underruns - this.lastUnderruns
    this.lastUnderruns = this.stats.underruns
    this.stall = lost >= ctx.sampleRate * (HEALTH_MS / 1000) * 0.8 ? this.stall + 1 : 0
    if (this.stall >= STALL_CHECKS) this.recover('Noise cancellation stalled, so Vesper Audio restarted it.', true)
  }

  recover(reason, fxOnly = false) {
    if (!this.cfg || this.recovering) return Promise.resolve()
    this.recovering = true
    this.stall = 0
    if (fxOnly) this.mode = ''
    else this.structKey = ''
    return this.apply(this.cfg).finally(() => {
      this.recovering = false
      if (reason) this.state.warning = reason
    })
  }

  deviceChanged() {
    clearTimeout(this.deviceTimer)
    this.deviceTimer = setTimeout(async () => {
      if (!this.ctx || !this.cfg || this.recovering) return
      const want = await resolveDevice('audioinput', this.cfg.inputName).catch(() => '')
      const track = this.stream && this.stream.getAudioTracks()[0]
      const have = track && track.getSettings().deviceId
      if (want && have && want !== have) this.recover('Audio devices changed, so Vesper Audio reconnected.')
    }, 1500)
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
    if (mode !== this.mode || this.denoiserKey !== this.keyFor(mode, cfg)) {
      const old = this.detachFx()
      this.mode = mode
      if (!this.forceLight) this.state.warning = ''
      try {
        await this.buildFx(mode, cfg)
      } catch (err) {
        this.discard(old, 0)
        throw err
      }
      this.discard(old, RELEASE_MS)
    }
    if ((mode === 'speex' || mode === 'speexzero') && this.fxNodes.speex) this.fxNodes.speex.port.postMessage(Math.round(cfg.speexDb))
    if (mode === 'clearcast' && this.fxNodes.wet) {
      const k = leak(cfg.aiStrength)
      this.fxNodes.wet.gain.setTargetAtTime(1 - k, ctx.currentTime, 0.02)
      this.fxNodes.dry.gain.setTargetAtTime(k, ctx.currentTime, 0.02)
    }
    this.gain.gain.setTargetAtTime(Math.max(0, cfg.gain) / 100, ctx.currentTime, 0.02)
  }

  keyFor(mode, cfg) {
    return mode === 'personal' ? 'personal|' + (cfg.personalUrl || '') : cfg.denoiserUrl
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
    node.onprocessorerror = () => this.recover('The noise cancelling engine crashed, so Vesper Audio restarted it.', true)
    node.port.postMessage({ type: 'link', port: channel.port1 }, [channel.port1])
    node.port.onmessage = e => {
      if (node.dead) return
      if (e.data.type === 'stats') {
        this.stats.underruns = e.data.underruns
        this.stats.queued = e.data.queued
        this.stats.target = e.data.target
        this.stats.rebuffers = e.data.rebuffers
        this.stats.drops = e.data.drops
        this.syncDry()
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
    worker.onerror = () => this.recover('The noise cancelling engine crashed, so Vesper Audio restarted it.', true)
    worker.onmessageerror = worker.onerror
    this.disposers.push(() => worker.terminate())
    return node
  }

  async buildFx(mode, cfg) {
    const ctx = this.ctx
    const add = (...nodes) => this.fx.push(...nodes)
    this.active = mode
    this.denoiserKey = this.keyFor(mode, cfg)
    this.state.denoiser = ''
    this.fxOut.gain.value = 1
    if (mode === 'off') {
      const pass = ctx.createGain()
      this.fxIn.connect(pass).connect(this.fxOut)
      add(pass)
    } else if (mode === 'rnnoise') {
      const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await this.wasmBinary('rnnoise') })
      node.onprocessorerror = () => this.recover('The noise cancelling engine crashed, so Vesper Audio restarted it.', true)
      this.fxIn.connect(node).connect(this.fxOut)
      add(node)
      this.fxNodes = { rnnoise: node }
    } else if (mode === 'speex' || mode === 'speexzero') {
      const node = new AudioWorkletNode(ctx, mode === 'speexzero' ? 'vesper-speex-zero' : SPEEX_ID, {
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { maxChannels: 1, wasmBinary: await this.wasmBinary('speex'), noiseSuppress: Math.round(cfg.speexDb) }
      })
      node.onprocessorerror = () => this.recover('The noise cancelling engine crashed, so Vesper Audio restarted it.', true)
      this.fxIn.connect(node).connect(this.fxOut)
      add(node)
      this.fxNodes = { speex: node }
    } else {
      const { node, kind } = await this.aiDenoiser(cfg)
      this.state.denoiser = kind
      const wet = ctx.createGain()
      const dry = ctx.createGain()
      const delay = ctx.createDelay(0.5)
      this.dryBase = kind === 'dpdfnet' ? DPDFNET_MODEL_DELAY : DFN3_MODEL_DELAY
      delay.delayTime.value = this.dryBase + this.stats.target / ctx.sampleRate
      const k = mode === 'clearcast' ? leak(cfg.aiStrength) : 0
      wet.gain.value = 1 - k
      dry.gain.value = k
      this.fxIn.connect(node).connect(wet).connect(this.fxOut)
      this.fxIn.connect(delay).connect(dry).connect(this.fxOut)
      add(node, wet, dry, delay)
      this.fxNodes = { denoise: node, wet, dry, delay }
      if (kind === 'dpdfnet' || kind === 'personal') this.startWatch()
    }
  }

  async aiDenoiser(cfg) {
    if (this.active === 'personal' && !this.forceLight) {
      const url = cfg.personalUrl || asset('./vendor/dfn3_ll.tar.gz')
      try {
        return { node: await this.denoiser({ backend: 'dfn3', modelUrl: url }), kind: 'personal' }
      } catch (err) {
        this.state.warning = 'The personal model could not start (' + String((err && err.message) || err) + '). Using the built-in light model.'
        return { node: await this.denoiser({ backend: 'dfn3' }), kind: 'dfn3' }
      }
    }
    const url = cfg.denoiserUrl
    if (this.active === 'clearcast' && url && !this.forceLight) {
      try {
        return { node: await this.denoiser({ backend: 'dpdfnet', model: 'dpdfnet_baseline', modelUrl: url, provider: 'wasm' }), kind: 'dpdfnet' }
      } catch (err) {
        this.state.warning = 'The main AI model could not start (' + String((err && err.message) || err) + '). Using the built-in light model.'
      }
    } else if (!this.forceLight) {
      this.state.warning = 'The main AI model is not downloaded yet. Using the built-in light model.'
    }
    return { node: await this.denoiser({ backend: 'dfn3' }), kind: 'dfn3' }
  }

  syncDry() {
    const delay = this.fxNodes && this.fxNodes.delay
    if (delay && this.ctx) delay.delayTime.setTargetAtTime(this.dryBase + this.stats.target / this.ctx.sampleRate, this.ctx.currentTime, 0.5)
  }

  startWatch() {
    this.stopWatch()
    let strikes = 0
    let seen = 0
    let last = this.stats.rebuffers
    this.watch = setInterval(() => {
      seen += WATCH_MS / 1000
      const delta = this.stats.rebuffers - last
      last = this.stats.rebuffers
      if (seen < WATCH_WARMUP_S) return
      strikes = this.stats.backlog >= 4 || delta >= 2 ? strikes + 1 : 0
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

  detachFx() {
    this.stopWatch()
    const old = { fx: this.fx, disposers: this.disposers }
    this.fx = []
    this.disposers = []
    this.fxNodes = {}
    this.active = ''
    return old
  }

  discard(old, delayMs) {
    const release = () => {
      for (const dispose of old.disposers) dispose()
      for (const n of old.fx) {
        try {
          this.fxIn.disconnect(n)
        } catch {}
        if (typeof n.destroy === 'function') n.destroy()
        n.disconnect()
        n.dead = true
      }
    }
    if (delayMs) setTimeout(release, delayMs)
    else release()
  }

  teardownFx() {
    this.discard(this.detachFx(), 0)
  }

  async route(cfg) {
    const monitorId = await resolveDevice('audiooutput', cfg.monitorName)
    const cableId = await resolveDevice('audiooutput', cfg.cableName)
    this.state.hasCable = Boolean(cableId)
    const key = [Boolean(cfg.monitor), monitorId, cableId].join('|')
    if (key !== this.sinkKey) {
      this.sinkKey = key
      const ctx = this.ctx
      try {
        this.bus.disconnect(ctx.destination)
      } catch {}
      try {
        this.monitorGain.disconnect(ctx.destination)
      } catch {}
      if (cfg.monitor) {
        await ctx.setSinkId(monitorId)
        this.monitorGain.connect(ctx.destination)
        if (cableId) {
          if (this.cableEl.setSinkId) await this.cableEl.setSinkId(cableId)
          await this.cableEl.play().catch(() => {})
        } else {
          this.cableEl.pause()
        }
      } else {
        this.cableEl.pause()
        if (cableId) {
          await ctx.setSinkId(cableId)
          this.bus.connect(ctx.destination)
        }
      }
    }
    if (this.sbEl.sinkId !== monitorId && this.sbEl.setSinkId) await this.sbEl.setSinkId(monitorId)
    this.monitorGain.gain.value = cfg.monitor ? 1 : 0
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
    this.stopHealth()
    if (this.ctx) {
      for (const s of this.playing.values()) {
        try {
          s.stop()
        } catch {}
      }
      this.playing.clear()
      this.teardownFx()
      for (const el of [this.cableEl, this.sbEl]) {
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
    this.fxAnalyser = null
    this.outAnalyser = null
    this.dither = null
    this.mode = ''
    this.structKey = ''
    this.buffers.clear()
    this.state.running = false
  }
}
