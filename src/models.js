const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const DPDFNET = 'https://huggingface.co/Ceva-IP/DPDFNet/resolve/dd6818d00f50c836fed43a6243ebe49116de5964/onnx/'

const table = {
  denoiser: {
    file: 'dpdfnet_baseline.onnx',
    url: DPDFNET + 'baseline.onnx',
    sha256: '371d26182aff0e1e0d31354e24c81f79cd57458f5a7dd003fc10a7ebf64255e0'
  }
}

const dir = () => path.join(app.getPath('userData'), 'models')

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', c => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

const inflight = new Map()

function ensure(name, emit) {
  if (!inflight.has(name)) inflight.set(name, download(name, emit).finally(() => inflight.delete(name)))
  return inflight.get(name)
}

async function download(name, emit) {
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
