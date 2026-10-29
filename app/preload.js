const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  ink: (msg) => ipcRenderer.send('ink', msg),
  shareEnded: () => ipcRenderer.send('share-ended'),
  onInk: (fn) => ipcRenderer.on('ink', (_e, msg) => fn(msg)),
});
