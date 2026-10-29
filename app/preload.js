const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  ink: (msg) => ipcRenderer.send('ink', msg),
  shareEnded: () => ipcRenderer.send('share-ended'),
  onInk: (fn) => ipcRenderer.on('ink', (_e, msg) => fn(msg)),
  // remote control: the main process asks the student and keeps the decision
  requestControl: () => ipcRenderer.invoke('control-request'),
  stopControl: () => ipcRenderer.send('control-stop'),
  input: (msg) => ipcRenderer.send('input', msg),
  onControlOff: (fn) => ipcRenderer.on('control-off', () => fn()),
  onBanner: (fn) => ipcRenderer.on('banner', (_e, text) => fn(text)),
});
