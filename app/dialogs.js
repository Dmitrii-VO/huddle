// App-styled question windows instead of native message boxes (which look foreign on Windows
// and can hide behind full-screen slides). Resolves with the button index; the last button is "cancel".
const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

// safe: for consent questions — focus starts on cancel, the window doesn't steal focus from what the
// user is typing into, and clicks/keys in the first moments are ignored (no accidental "Allow").
function ask({ parent, title, detail = '', buttons, kind = 'info', onTop = false, safe = false }) {
  return new Promise((resolve) => {
    const cancel = buttons.length - 1;
    const w = new BrowserWindow({
      parent: onTop ? undefined : parent, modal: !!parent && !onTop,
      width: 480, height: 200, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      skipTaskbar: !!parent, backgroundColor: '#1c1c1c', title,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    if (onTop) w.setAlwaysOnTop(true, 'screen-saver', 2); // above the share overlay and bar

    let done = false;
    const finish = (i) => {
      if (done) return;
      done = true;
      ipcMain.off('prompt-answer', onAnswer);
      ipcMain.off('prompt-size', onSize);
      resolve(i);
      if (!w.isDestroyed()) w.destroy();
    };
    const onAnswer = (e, i) => e.sender === w.webContents && finish(Number.isInteger(i) && i >= 0 && i <= cancel ? i : cancel);
    const onSize = (e, h) => {
      if (e.sender !== w.webContents) return;
      w.setContentSize(480, Math.min(600, Math.ceil(h)));
      w.center();
      if (safe) return w.showInactive();
      w.show();
      w.focus();
    };
    ipcMain.on('prompt-answer', onAnswer);
    ipcMain.on('prompt-size', onSize);
    w.on('closed', () => finish(cancel));
    w.loadFile(path.join(__dirname, 'prompt.html'), { query: { data: JSON.stringify({ title, detail, buttons, kind, safe }) } });
  });
}

// "What to show": whole screens first, then windows, with thumbnails. Resolves with a source or null.
function pick({ parent, sources, hint }) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      parent, modal: true, width: 760, height: 560, show: false, frame: false, resizable: false,
      minimizable: false, maximizable: false, backgroundColor: '#1c1c1c', title: 'Что показать',
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    let done = false;
    const finish = (i) => {
      if (done) return;
      done = true;
      ipcMain.off('picker-answer', onAnswer);
      resolve(sources[i] ?? null);
      if (!w.isDestroyed()) w.destroy();
    };
    const onAnswer = (e, i) => e.sender === w.webContents && finish(i);
    ipcMain.on('picker-answer', onAnswer);
    w.on('closed', () => finish(-1));
    w.webContents.on('did-finish-load', () => {
      w.webContents.send('picker', {
        hint,
        items: sources.map((s) => ({ name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL() })),
      });
      w.show();
    });
    w.loadFile(path.join(__dirname, 'picker.html'));
  });
}

module.exports = { ask, pick };
