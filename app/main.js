// Student desktop app: the website in a window, plus what a browser can't do —
// a click-through overlay over the shared screen for the teacher's pointer and pen.
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, systemPreferences } = require('electron');
const path = require('node:path');

const SITE = process.env.HUDDLE_URL || 'https://176-108-255-4.sslip.io';
const preload = path.join(__dirname, 'preload.js');
let win = null, overlay = null;

function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 800, title: 'Huddle', autoHideMenuBar: true, webPreferences: { preload } });
  win.loadFile(path.join(__dirname, 'start.html'), { query: { site: SITE } });
  // Remote pages get the preload API, so never leave our site.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SITE + '/') && !url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { overlay?.destroy(); app.quit(); });
}

// ponytail: always the primary display; add a picker when a student has two monitors.
function showOverlay(display) {
  overlay?.destroy();
  overlay = new BrowserWindow({
    ...display.bounds,
    transparent: true, frame: false, focusable: false, skipTaskbar: true,
    hasShadow: false, resizable: false, movable: false,
    webPreferences: { preload },
  });
  overlay.setBounds(display.bounds); // Windows trims the initial size to the work area (above the taskbar)
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setContentProtection(true); // keep the marks out of the captured stream: the teacher already draws them locally
  overlay.loadURL(SITE + '/overlay.html');
  overlay.on('closed', () => (overlay = null));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(SITE + '/') && ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
  // "Показать экран" shares the whole primary screen — the overlay must match what the teacher sees.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'] }); // on macOS this also adds the app to the Screen Recording list
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Разрешите Huddle запись экрана',
        detail: 'Системные настройки → Конфиденциальность и безопасность → Запись экрана: включите Huddle, затем закройте и снова откройте приложение.',
        buttons: ['Открыть настройки', 'Отмена'],
      });
      if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return cb({});
    }
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source) return cb({});
    showOverlay(display);
    cb({ video: source });
  });

  ipcMain.on('ink', (e, msg) => {
    if (e.sender === win?.webContents) overlay?.webContents.send('ink', msg);
  });
  ipcMain.on('share-ended', (e) => {
    if (e.sender === win?.webContents) overlay?.destroy();
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
