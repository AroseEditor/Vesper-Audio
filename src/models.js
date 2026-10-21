const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/'
const DPDFNET = 'https://huggingface.co/Ceva-IP/DPDFNet/resolve/dd6818d00f50c836fed43a6243ebe49116de5964/onnx/'

const table = {
  speakerSmall: {
    file: 'vesper-speaker-small.onnx',
    url: 'https://github.com/AroseEditor/Vesper-Audio/releases/download/models-v1/vesper-speaker-small.onnx',
    sha256: '9c6c85d71d0718e62d765387375a10830d4dab03084fe44eb04868d6957484a0'
  },
  denoiserHeavy: {
    file: 'dpdfnet2_48khz_hr.onnx',
    url: DPDFNET + 'dpdfnet2_48khz_hr.onnx',
    sha256: '7f0575a5cec0ba4ffd8f8bd657e06d007e4ccdd955d76faab922b9d3291dc14b'
  },
  speakerHeavy: {
    file: 'wespeaker_en_voxceleb_resnet293_LM.onnx',
    url: SHERPA + 'wespeaker_en_voxceleb_resnet293_LM.onnx',
    sha256: 'f65dbc820e534eef64ae12d1e289e20244d60e60f7f00d7b092092b1c458be2e'
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

module.exports = { ensure, dir, table }
