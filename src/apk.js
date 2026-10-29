const { app } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const NAME = 'Vesper-Audio-Connector.apk'
const OPEN_MS = 10 * 60 * 1000

let server = null
let timer = null
let info = null

function apkPath() {
  if (process.env.VESPER_APK) return process.env.VESPER_APK
  if (app.isPackaged) return path.join(process.resourcesPath, 'connector.apk')
  return path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
}

function addresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) out.push(item.address)
    }
  }
  return out
}

function stop() {
  clearTimeout(timer)
  timer = null
  if (server) {
    server.close()
    server = null
  }
  info = null
}

function start() {
  const file = apkPath()
  if (!fs.existsSync(file)) return Promise.resolve({ available: false })
  if (server && info) {
    clearTimeout(timer)
    timer = setTimeout(stop, OPEN_MS)
    return Promise.resolve(info)
  }
  const bytes = fs.readFileSync(file)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url && req.url.split('?')[0] === '/' + NAME) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${NAME}"` })
        res.end(bytes)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    server.on('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port
      info = { available: true, urls: addresses().map(ip => `http://${ip}:${port}/${NAME}`), sha256, size: bytes.length }
      timer = setTimeout(stop, OPEN_MS)
      resolve(info)
    })
  })
}

module.exports = { start, stop, apkPath }
