import { h, $ } from './dom.js'

const SECONDS = 30

function pcm16(blocks) {
  let n = 0
  for (const b of blocks) n += b.length
  const out = new Int16Array(n)
  let at = 0
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) out[at++] = Math.max(-32768, Math.min(32767, Math.round(b[i] * 32767)))
  }
  return out
}

export class Diag {
  constructor({ api, engine, dialog, closeDialog, reason }) {
    Object.assign(this, { api, engine, dialog, closeDialog, reason })
  }

  tap(source) {
    const engine = this.engine
    const node = new AudioWorkletNode(engine.ctx, 'vesper-record', { channelCount: 1, channelCountMode: 'explicit' })
    const mute = engine.ctx.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute).connect(engine.ctx.destination)
    const blocks = []
    node.port.onmessage = e => blocks.push(e.data)
    return {
      blocks,
      stop: () => {
        node.port.onmessage = null
        try {
          source.disconnect(node)
          node.disconnect()
          mute.disconnect()
        } catch {}
      }
    }
  }

  async run() {
    const engine = this.engine
    if (!engine.ctx) {
      this.dialog({ title: 'Diagnostic recording', body: h('p', { class: 'error', text: engine.state.error || 'The audio engine is not running.' }), actions: [{ label: 'Close', onClick: this.closeDialog }] })
      return
    }
    const bar = h('i')
    const text = h('p', { class: 'muted', text: `Recording ${SECONDS} seconds. Talk normally and let the problem happen.` })
    let cancelled = false
    this.dialog({ title: 'Diagnostic recording', body: [text, h('div', { class: 'progress' }, bar)], actions: [{ label: 'Cancel', onClick: () => (cancelled = true) }] })
    const raw = this.tap(engine.gain)
    const out = this.tap(engine.micOut)
    const stats0 = { ...engine.stats }
    const started = performance.now()
    await new Promise(resolve => {
      const timer = setInterval(() => {
        const p = (performance.now() - started) / (SECONDS * 1000)
        bar.style.width = Math.min(100, p * 100) + '%'
        if (p >= 1 || cancelled) {
          clearInterval(timer)
          resolve()
        }
      }, 200)
    })
    raw.stop()
    out.stop()
    if (cancelled) return this.closeDialog()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    try {
      await this.api.invoke('diag:save', `${stamp}-raw-mic.wav`, pcm16(raw.blocks).buffer)
      await this.api.invoke('diag:save', `${stamp}-processed.wav`, pcm16(out.blocks).buffer)
      const info = {
        time: new Date().toISOString(),
        mode: engine.active,
        denoiser: engine.state.denoiser,
        warning: engine.state.warning,
        input: engine.cfg && engine.cfg.inputName,
        baseLatency: engine.ctx.baseLatency,
        outputLatency: engine.ctx.outputLatency,
        statsBefore: stats0,
        statsAfter: { ...engine.stats },
        recovering: engine.recovering
      }
      await this.api.invoke('diag:save', `${stamp}-info.json`, new TextEncoder().encode(JSON.stringify(info, null, 2)).buffer)
      text.textContent = 'Saved to Documents, Vesper Audio Diagnostics: the raw microphone, the processed audio and a stats file.'
    } catch (err) {
      text.textContent = 'Could not save the recording: ' + this.reason(err)
      text.className = 'error'
    }
    $('dlg-actions').replaceChildren(
      h('button', { class: 'btn', type: 'button', text: 'Open folder', onclick: () => this.api.invoke('diag:open') }),
      h('button', { class: 'btn primary', type: 'button', text: 'Close', onclick: this.closeDialog })
    )
  }
}
