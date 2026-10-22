const { contextBridge, ipcRenderer } = require('electron')

const invokes = new Set([
  'settings:get',
  'settings:set',
  'devices:list',
  'device:volume',
  'device:mute',
  'device:listen',
  'device:sysfx',
  'system:gpus',
  'driver:status',
  'driver:install',
  'driver:brand',
  'update:status',
  'update:act',
  'driver:uninstall',
  'sounds:add',
  'sounds:remove',
  'voice:save',
  'voice:load',
  'voice:clear',
  'app:relaunch',
  'app:settings',
  'system:restart',
  'model:ensure',
  'app:info',
  'app:repo',
  'app:quit',
  'app:log'
])

const events = new Set(['driver:progress', 'model:progress', 'app:shown', 'update:status', 'app:wake'])

contextBridge.exposeInMainWorld('vesper', {
  invoke: (channel, ...args) =>
    invokes.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('blocked channel ' + channel)),
  on: (channel, cb) => {
    if (!events.has(channel)) throw new Error('blocked channel ' + channel)
    const fn = (_, payload) => cb(payload)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.off(channel, fn)
  }
})
