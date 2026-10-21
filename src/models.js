const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const table = {
  speaker: {
    file: 'wespeaker_en_voxceleb_CAM++.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx',
    sha256: 'c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef'
  }
}

const dir = () => path.join(app.getPath('userData'), 'models')

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

async function ensure(name, emit) {
  const m = table[name]
  if (!m) throw new Error('unknown model ' + name)
  fs.mkdirSync(dir(), { recursive: true })
  const dest = path.join(dir(), m.file)
  if (fs.existsSync(dest) && (await sha256(dest)) === m.sha256) return `vesper://models/${m.file}`
  const res = await fetch(m.url, { headers: { 'User-Agent': 'vesper-audio' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`model download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let done = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', c => {
    done += c.length
    if (total) emit({ name, value: done / total })
  })
  const tmp = dest + '.part'
  await pipeline(body, fs.createWriteStream(tmp))
  if ((await sha256(tmp)) !== m.sha256) {
    fs.rmSync(tmp, { force: true })
    throw new Error('model checksum mismatch')
  }
  fs.renameSync(tmp, dest)
  emit({ name, value: 1 })
  return `vesper://models/${m.file}`
}

module.exports = { ensure, dir }
