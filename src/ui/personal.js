import { h, $ } from './dom.js'

const PASSAGES = {
  en: [
    'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow.',
    'The market was full of color that morning. Vendors called out their prices while the smell of fresh bread drifted through the narrow lanes. A small boy carried a basket of oranges almost as big as himself, and an old woman counted her coins twice before smiling. By noon the sun was high, the shade was precious, and everyone agreed it was going to be a long, warm day.',
    'Last Sunday we planned a short trip to the lake. We packed sandwiches, two bottles of water, a blue blanket, and a deck of cards. The road was quiet and the radio played soft music. When we finally arrived, the water was perfectly still, and for a moment nobody said anything at all.'
  ],
  hi: [
    'भारत एक विशाल और विविधताओं से भरा हुआ देश है। यहाँ हर कुछ किलोमीटर पर बोली, खान-पान और पहनावा बदल जाता है। सुबह की ठंडी हवा में चाय की खुशबू फैल जाती है और गलियों में बच्चों की हँसी गूँजने लगती है। पहाड़ों से लेकर समंदर तक, हर जगह की अपनी एक अलग कहानी है। लोग मिल-जुलकर त्योहार मनाते हैं, एक-दूसरे की मदद करते हैं और नई उम्मीदों के साथ आगे बढ़ते हैं। जब कोई अपने सपनों के पीछे चलता है, तो पूरी दुनिया उसके लिए रास्ता बना देती है।',
    'कल शाम को हम सब छत पर बैठे थे। आसमान में हल्के बादल थे और ठंडी हवा चल रही थी। माँ ने गरमागरम पकौड़े बनाए और दादाजी पुरानी कहानियाँ सुनाने लगे। सबने मिलकर खूब बातें कीं और किसी को समय का पता ही नहीं चला। जब चाँद निकला तो सब चुप हो गए और बस उसे देखते रहे।',
    'मुझे हर सुबह जल्दी उठकर टहलना अच्छा लगता है। पार्क में पक्षियों की आवाज़ सुनाई देती है और फूलों की महक मन को शांत कर देती है। रास्ते में मैं अक्सर अपने पुराने दोस्तों से मिलता हूँ, हम थोड़ी देर बातें करते हैं और फिर अपने-अपने काम पर निकल पड़ते हैं।'
  ]
}

const KINDS = [
  { id: 'normal', title: 'in your normal voice', seconds: 90 },
  { id: 'quiet', title: 'quietly, like late at night', seconds: 60 },
  { id: 'loud', title: 'louder, like talking across a room', seconds: 60 }
]
const LANGUAGE = { en: 'English', hi: 'Hindi' }
const FREE = { id: 'free', lang: 'mix', title: 'Talk freely', text: 'Tell Vesper about your day in whichever language you normally speak. Mix Hindi and English if that is how you talk. Keep going until the bar is full.', seconds: 120 }
const SPEECH_LEVEL = 0.006
const MIN_STOP_SECONDS = 240
const VAL_SHARE = 0.15

function stepsFor(languages) {
  const out = []
  for (const lang of languages) {
    KINDS.forEach((k, i) => out.push({ id: `${lang}-${k.id}`, lang, title: `Read ${LANGUAGE[lang]} ${k.title}`, text: PASSAGES[lang][i], seconds: k.seconds }))
  }
  out.push(FREE)
  return out
}

function minutes(seconds) {
  const m = Math.round(seconds / 60)
  return m <= 1 ? 'about a minute' : `about ${m} minutes`
}

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

export class Personal {
  constructor({ api, engine, state, dialog, closeDialog, notice, save, sync, reason, renderAll }) {
    Object.assign(this, { api, engine, state, dialog, closeDialog, notice, save, sync, reason, renderAll })
    this.status = { phase: 'idle', installed: false, personal: null }
    this.view = null
    api.on('trainer:progress', s => this.progress(s))
    api.invoke('trainer:status').then(s => (this.status = { ...this.status, ...s })).catch(() => {})
  }

  model() {
    const p = this.state.settings.personal
    return p && p.accepted ? p : null
  }

  url() {
    const m = this.model()
    return m ? m.url : ''
  }

  busy() {
    return ['download', 'train', 'validate'].includes(this.status.phase)
  }

  note() {
    const m = this.model()
    if (this.busy()) return `Training your voice model: ${this.status.percent || 0}%${this.status.etaSeconds ? ', about ' + minutes(this.status.etaSeconds) + ' left' : ''}`
    if (m) {
      const langs = (m.languages || []).map(l => LANGUAGE[l]).filter(Boolean).join(' and ')
      return `Trained on your voice${langs ? ' (' + langs + ')' : ''}. About 45 ms delay.`
    }
    return 'Using the built-in model, about 45 ms delay. Train it on your voice for the best result.'
  }

  button() {
    return this.busy() ? 'Open' : this.model() ? 'Retrain' : 'Train my voice'
  }

  async refresh() {
    const s = await this.api.invoke('settings:get')
    this.state.settings.personal = s.personal
  }

  progress(s) {
    this.status = { ...this.status, ...s }
    this.notice('trainer', this.busy() ? { text: this.note(), label: 'Open', action: () => this.open() } : null)
    if (this.view) this.view(this.status)
    if (s.phase === 'done' || s.phase === 'error' || s.phase === 'cancelled') {
      this.refresh().then(() => {
        this.renderAll()
        this.sync()
      })
    } else {
      this.renderAll()
    }
  }

  async open() {
    this.view = null
    const status = await this.api.invoke('trainer:status').catch(() => this.status)
    this.status = { ...this.status, ...status }
    if (this.busy()) return this.trainStage()
    return this.chooseStage()
  }

  chooseStage() {
    const english = h('input', { type: 'checkbox', id: 'pm-en', checked: true })
    const hindi = h('input', { type: 'checkbox', id: 'pm-hi', checked: true })
    const light = h('input', { type: 'radio', name: 'pm-depth', id: 'pm-light', checked: true })
    const heavy = h('input', { type: 'radio', name: 'pm-depth', id: 'pm-heavy' })
    const warn = h('p', { class: 'error', text: '' })
    const languages = () => [english.checked ? 'en' : '', hindi.checked ? 'hi' : ''].filter(Boolean)
    const depth = () => (heavy.checked ? 'heavy' : 'light')
    const begin = async skip => {
      if (!languages().length) {
        warn.textContent = 'Tick at least one language.'
        return
      }
      if (skip) return this.train(languages(), depth())
      return this.recordStage(languages(), depth())
    }
    this.api.invoke('voice:list').then(list => {
      if (list.length && $('pm-start') && !$('pm-again')) {
        const seconds = Math.round(list.reduce((n, f) => n + f.seconds, 0))
        $('dlg-actions').firstElementChild.after(h('button', { class: 'btn', id: 'pm-again', type: 'button', text: `Train on saved recording (${Math.round(seconds / 60)} min)`, onclick: () => begin(true) }))
      }
    })
    this.dialog({
      title: 'Train your voice model',
      body: [
        h('p', { text: 'Vesper Audio fine-tunes its own noise cancelling model on your voice, on this PC. Nothing is uploaded. The model keeps you natural and learns to drop other voices and background noise, with no lookahead delay.' }),
        h('label', { class: 'inline-check' }, english, h('span', { text: 'English' })),
        h('label', { class: 'inline-check' }, hindi, h('span', { text: 'Hindi' })),
        h('p', { class: 'muted', text: 'Tick both if you speak both. You read a few passages in each language and then talk freely, about 9 minutes in total.' }),
        h('label', { class: 'inline-check' }, light, h('span', { text: 'Light: about 30 minutes of training, one-time download of about 235 MB' })),
        h('label', { class: 'inline-check' }, heavy, h('span', { text: 'Heavy: the same recording, about 2 hours of training for the best result' })),
        h('p', { class: 'hint', text: 'Training runs in the background at low priority. You can keep using the app. Record in a quiet room.' }),
        warn
      ],
      actions: [
        { label: 'Cancel', onClick: this.closeDialog },
        { label: 'Start recording', primary: true, id: 'pm-start', onClick: () => begin(false) }
      ]
    })
  }

  async recordStage(languages, depth) {
    const steps = stepsFor(languages)
    const total = steps.reduce((n, s) => n + s.seconds, 0)
    const engine = this.engine
    if (!engine.ctx) {
      this.dialog({ title: 'Microphone unavailable', body: h('p', { class: 'error', text: engine.state.error || 'The audio engine is not running. Pick a microphone first.' }), actions: [{ label: 'Close', onClick: this.closeDialog }] })
      return
    }
    const heading = h('h3', { class: 'step-title' })
    const passage = h('div', { class: 'paragraph' })
    const bar = h('i')
    const stepBar = h('i')
    const level = h('i')
    const clock = h('span', { class: 'muted' })
    const status = h('p', { class: 'muted', text: 'Press Start, then read in your natural voice. The bar fills while you speak.' })
    let index = 0
    let blocks = []
    let credited = 0
    let recorded = 0
    let node = null
    let mute = null
    let paused = true
    let floors = []
    let peak = 0
    const draw = () => {
      const s = steps[index]
      heading.textContent = `Step ${index + 1} of ${steps.length}: ${s.title}`
      passage.replaceChildren(...s.text.split(' ').map(w => h('span', { text: w + ' ', lang: s.lang === 'hi' ? 'hi' : 'en' })))
    }
    const stopNode = () => {
      if (node) {
        try {
          engine.gain.disconnect(node)
          node.disconnect()
          mute.disconnect()
        } catch {}
        node.port.onmessage = null
      }
      node = null
    }
    const finishStep = async () => {
      const s = steps[index]
      const all = blocks
      blocks = []
      credited = 0
      if (all.length) {
        const cut = Math.floor(all.length * (1 - VAL_SHARE))
        await this.api.invoke('voice:wav', { name: s.id + '-a', split: 'train' }, pcm16(all.slice(0, cut)).buffer)
        await this.api.invoke('voice:wav', { name: s.id + '-b', split: 'val' }, pcm16(all.slice(cut)).buffer)
      }
    }
    const next = async () => {
      await finishStep()
      if (index >= steps.length - 1) return done()
      index++
      draw()
    }
    const done = async () => {
      paused = true
      stopNode()
      const sorted = floors.slice().sort((a, b) => a - b)
      const floor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0
      const floorDb = 20 * Math.log10(floor + 1e-9)
      const notes = []
      if (floorDb > -45) notes.push(`The room is noisy (${Math.round(floorDb)} dBFS). Recording in a quieter place gives a better model.`)
      if (peak > 0.99) notes.push('Your voice clipped. Lower the microphone gain in Properties.')
      this.train(languages, depth, notes)
    }
    const buttons = mode => {
      const list = [h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => cancel() })]
      if (mode === 'ready') list.push(h('button', { class: 'btn primary', type: 'button', id: 'pm-go', text: 'Start', onclick: begin }))
      if (mode === 'recording') {
        list.push(h('button', { class: 'btn', type: 'button', id: 'pm-pause', text: 'Pause', onclick: toggle }))
        list.push(h('button', { class: 'btn', type: 'button', id: 'pm-skip', text: 'Next step', onclick: next }))
        list.push(h('button', { class: 'btn primary', type: 'button', id: 'pm-finish', text: `Finish (needs ${Math.round(MIN_STOP_SECONDS / 60)} min)`, disabled: true, onclick: done }))
      }
      $('dlg-actions').replaceChildren(...list)
    }
    const cancel = () => {
      paused = true
      stopNode()
      this.closeDialog()
    }
    const toggle = () => {
      paused = !paused
      $('pm-pause').textContent = paused ? 'Resume' : 'Pause'
      status.textContent = paused ? 'Paused.' : 'Listening.'
    }
    const onBlock = data => {
      let sum = 0
      let top = 0
      for (let i = 0; i < data.length; i++) {
        const v = data[i]
        sum += v * v
        const a = v < 0 ? -v : v
        if (a > top) top = a
      }
      const rms = Math.sqrt(sum / data.length)
      level.style.width = Math.min(100, rms * 400) + '%'
      if (paused) return
      blocks.push(data)
      floors.push(rms)
      if (top > peak) peak = top
      if (rms > SPEECH_LEVEL) {
        credited += data.length / 48000
        recorded += data.length / 48000
      }
      const s = steps[index]
      stepBar.style.width = Math.min(100, (credited / s.seconds) * 100) + '%'
      bar.style.width = Math.min(100, (recorded / total) * 100) + '%'
      clock.textContent = Math.round(recorded) + ' s of speech'
      const words = [...passage.children]
      const read = Math.floor(Math.min(1, credited / s.seconds) * words.length)
      words.forEach((w, i) => w.classList.toggle('done', i < read))
      const finish = $('pm-finish')
      if (finish && recorded >= MIN_STOP_SECONDS) {
        finish.disabled = false
        finish.textContent = 'Finish'
      }
      if (credited >= s.seconds) next()
    }
    const begin = async () => {
      paused = false
      node = new AudioWorkletNode(engine.ctx, 'vesper-record', { channelCount: 1, channelCountMode: 'explicit' })
      mute = engine.ctx.createGain()
      mute.gain.value = 0
      engine.gain.connect(node)
      node.connect(mute).connect(engine.ctx.destination)
      node.port.onmessage = e => onBlock(e.data)
      status.textContent = 'Listening. Keep reading until the bar is full, or press Next step.'
      buttons('recording')
    }
    await this.api.invoke('voice:wipe')
    this.dialog({
      title: 'Record your voice',
      body: [status, heading, passage, h('p', { class: 'muted', text: 'This step' }), h('div', { class: 'progress' }, stepBar), h('p', { class: 'muted', text: 'Everything' }), h('div', { class: 'progress' }, bar), h('p', { class: 'muted', text: 'Microphone level' }), h('div', { class: 'progress' }, level), h('div', { class: 'row' }, clock)],
      actions: []
    })
    draw()
    buttons('ready')
  }

  async train(languages, depth, notes = []) {
    await this.api.invoke('trainer:start', { languages, depth })
    this.trainStage(notes)
  }

  trainStage(notes = []) {
    const bar = h('i')
    const text = h('p', { class: 'muted' })
    const detail = h('p', { class: 'hint' })
    const result = h('div')
    const update = s => {
      bar.style.width = (s.percent || 0) + '%'
      const eta = s.etaSeconds ? `, about ${minutes(s.etaSeconds)} left` : ''
      if (s.phase === 'download') text.textContent = (s.message || 'Downloading the trainer') + ` ${s.percent || 0}%`
      else if (s.phase === 'train') text.textContent = `Training your voice model: step ${s.step || 0} of ${s.total || '?'}${eta}`
      else if (s.phase === 'validate') text.textContent = s.message
      else text.textContent = s.message || ''
      const actions = []
      if (this.busy()) actions.push({ label: 'Hide', onClick: this.closeDialog }, { label: 'Cancel training', onClick: () => this.api.invoke('trainer:cancel') })
      else actions.push({ label: 'Close', primary: true, onClick: this.closeDialog })
      if (s.phase === 'done' && s.result && !s.result.ok) {
        actions.unshift({
          label: 'Use it anyway',
          onClick: async () => {
            await this.api.invoke('trainer:use')
            await this.refresh()
            this.closeDialog()
            this.renderAll()
            this.sync()
          }
        })
      }
      const box = $('dlg-actions')
      box.replaceChildren(...actions.map(a => h('button', { class: 'btn' + (a.primary ? ' primary' : ''), type: 'button', text: a.label, onclick: a.onClick })))
      if (s.phase === 'done') result.replaceChildren(...this.resultLines(s.result))
      if (s.phase === 'error') text.className = 'error'
    }
    this.view = update
    this.dialog({
      title: 'Training your voice model',
      body: [text, h('div', { class: 'progress' }, bar), detail, result, ...notes.map(n => h('p', { class: 'hint', text: n }))],
      actions: []
    })
    detail.textContent = 'You can hide this window. Training continues in the background at low priority.'
    update(this.status)
  }

  resultLines(result) {
    if (!result || !result.mine) return [h('p', { text: 'Your model is ready and switched on.' })]
    const line = (label, mine, base, unit) => h('p', { class: 'muted', text: `${label}: ${mine}${unit} (base model ${base}${unit})` })
    return [
      h('p', { class: result.ok ? 'ok' : 'error', text: result.ok ? 'Your model keeps your voice and is switched on.' : 'It is not better than the base model: ' + result.reasons.join('; ') + '.' }),
      line('Your voice cut in clean speech', result.mine.clean.cut_rate, result.base.clean.cut_rate, '%'),
      line('Your voice cut with noise', result.mine.noise10.cut_rate, result.base.noise10.cut_rate, '%'),
      line('Quiet speech cut', result.mine.quiet.cut_rate, result.base.quiet.cut_rate, '%'),
      line('Other voices reduced', result.mine.others_only.suppression_db, result.base.others_only.suppression_db, ' dB'),
      line('Background noise reduced', result.mine.noise_only.suppression_db, result.base.noise_only.suppression_db, ' dB')
    ]
  }

  async remove() {
    await this.api.invoke('trainer:remove')
    await this.refresh()
    this.renderAll()
    this.sync()
  }
}
