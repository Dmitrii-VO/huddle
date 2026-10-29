// One bridge for the page, the overlay and the bar; main.js checks which window each message comes from.
const { contextBridge, ipcRenderer } = require('electron');
const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('huddle', {
  // page
  ink: (msg) => ipcRenderer.send('ink', msg),
  shareEnded: () => ipcRenderer.send('share-ended'),
  requestControl: () => ipcRenderer.invoke('control-request'),
  stopControl: () => ipcRenderer.send('control-stop'),
  input: (msg) => ipcRenderer.send('input', msg),
  onControlOff: on('control-off'),
  barState: (s) => ipcRenderer.send('bar-state', s),
  onBarAction: on('bar-action'),
  onInkOut: on('ink-out'),
  // overlay
  onInk: on('ink'),
  onBanner: on('banner'),
  onTool: on('tool'),
  onCmd: on('cmd'),
  inkOut: (msg) => ipcRenderer.send('ink-out', msg),
  // bar
  bar: (action) => ipcRenderer.send('bar', action),
  onState: on('state'),
});
