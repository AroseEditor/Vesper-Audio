const { app } = require('electron')
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vesper-helper.exe')
    : path.join(__dirname, '..', 'helper', 'target', 'release', 'vesper-helper.exe')
}

function run(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      helperPath(),
      args,
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()))
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error('helper returned invalid output'))
        }
      }
    )
  })
}

function runElevated(args, timeout = 300000) {
  const out = path.join(os.tmpdir(), `vesper-${process.pid}-${Date.now()}.json`)
  const quote = a => `'"${String(a).replace(/'/g, "''")}"'`
  const exe = helperPath().replace(/'/g, "''")
  const list = [...args, '--out', out].map(quote).join(',')
  const script = `Start-Process -FilePath '${exe}' -ArgumentList ${list} -Verb RunAs -Wait -WindowStyle Hidden`
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout },
      (err, _o, stderr) => {
        let result = null
        try {
          result = JSON.parse(fs.readFileSync(out, 'utf8'))
        } catch {}
        fs.rm(out, { force: true }, () => {})
        if (result) return resolve(result)
        reject(new Error(/cancel/i.test(stderr || '') ? 'Administrator approval was declined' : (stderr || (err && err.message) || 'elevated helper failed').trim()))
      }
    )
  })
}

function runSetup(exe) {
  const quote = a => `'${String(a).replace(/'/g, "''")}'`
  const script = `Start-Process -FilePath ${quote(exe)} -WorkingDirectory ${quote(path.dirname(exe))} -Verb RunAs -Wait`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 1800000 }, (err, _o, stderr) => {
      if (!err) return resolve()
      reject(new Error(/cancel/i.test(stderr || '') ? 'Administrator approval was declined' : (stderr || err.message).trim()))
    })
  })
}

module.exports = {
  helperPath,
  list: () => run(['list']),
  setVolume: (id, percent) => run(['volume', id, String(Math.round(percent))]),
  setMute: (id, muted) => run(['mute', id, muted ? '1' : '0']),
  setListen: (id, on) => run(['listen', id, on ? '1' : '0']).catch(() => runElevated(['listen', id, on ? '1' : '0'])),
  setSysFx: (id, on) => run(['sysfx', id, on ? '1' : '0']),
  gpus: () => run(['gpus']),
  driverStatus: () => run(['driver-status']),
  driverVerify: file => run(['driver-verify', file]),
  brand: icon => run(['brand', icon]).catch(() => runElevated(['brand', icon])),
  runSetup,
  driverInstall: dir => runElevated(['driver-install', dir]),
  driverUninstall: () => runElevated(['driver-uninstall'])
}
