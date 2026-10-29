// One bridge for the page, the overlay and the bar; main.js checks which window each message comes from.
const { contextBridge, ipcRenderer } = require('electron');
const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('huddle', {
  version: ipcRenderer.sendSync('version'),
  // page
  ink: (msg) => ipcRenderer.send('ink', msg),
  shareEnded: () => ipcRenderer.send('share-ended'),
  requestControl: () => ipcRenderer.invoke('control-request'),
  stopControl: () => ipcRenderer.send('control-stop'),
  input: (msg) => ipcRenderer.send('input', msg),
  onControlOff: on('control-off'),
  appLogs: () => ipcRenderer.invoke('app-logs'),
  onAppLog: on('app-log'),
  barState: (s) => ipcRenderer.send('bar-state', s),
  onBarAction: on('bar-action'),
  onInkOut: on('ink-out'),
  // overlay
  onInk: on('ink'),
  onBanner: on('banner'),
  onTool: on('tool'),
  onCmd: on('cmd'),
  inkOut: (msg) => ipcRenderer.send('ink-out', msg),
  // start screen
  recent: () => ipcRenderer.invoke('recent'),
  renameRecent: (code, name) => ipcRenderer.send('recent-rename', code, name),
  removeRecent: (code) => ipcRenderer.send('recent-remove', code),
  // prompt window
  promptAnswer: (i) => ipcRenderer.send('prompt-answer', i),
  promptSize: (h) => ipcRenderer.send('prompt-size', h),
  // bar
  bar: (action) => ipcRenderer.send('bar', action),
  onState: on('state'),
});
