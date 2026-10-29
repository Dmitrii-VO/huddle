// Student desktop app: the website in a window, plus what a browser can't do —
// a click-through overlay over the shared screen for the teacher's pointer and pen,
// and letting the teacher drive the mouse after the student agrees.
const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell, systemPreferences } = require('electron');
const path = require('node:path');

const SITE = process.env.HUDDLE_URL || 'https://176-108-255-4.sslip.io';
const preload = path.join(__dirname, 'preload.js');
const STOP_KEY = 'CommandOrControl+Alt+X';
const STOP_LABEL = process.platform === 'darwin' ? '⌘⌥X' : 'Ctrl+Alt+X';
const isMac = process.platform === 'darwin';

let win = null, overlay = null;
let sharedDisplay = null; // set while the screen is shared
let control = false;      // consent lives here, never in the (remote) page
let consentGen = 0;       // bumped on navigation / share end: a pending "Разрешить" must not outlive them
let input = null;         // native module, loaded on first use
const held = new Set();   // synthetic buttons currently down

function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 800, title: 'Huddle', autoHideMenuBar: true, webPreferences: { preload } });
  win.loadFile(path.join(__dirname, 'start.html'), { query: { site: SITE } });
  // Remote pages get the preload API, so never leave our site.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SITE + '/') && !url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.on('did-navigate', () => { consentGen++; setControl(false); });
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

function setControl(on) {
  if (control === on) return;
  control = on;
  if (on) {
    globalShortcut.register(STOP_KEY, () => {
      setControl(false);
      win?.webContents.send('control-off');
    });
  } else {
    globalShortcut.unregister(STOP_KEY);
    for (const b of held) input.button(b, false); // don't leave a drag hanging
    held.clear();
  }
  overlay?.webContents.send('banner', on ? `Мышью управляет преподаватель · ${STOP_LABEL} — отключить` : '');
}

// Normalized (0..1) point on the shared display -> what the OS input API expects.
function toScreen(x, y) {
  const b = sharedDisplay.bounds;
  const p = { x: Math.round(b.x + x * b.width), y: Math.round(b.y + y * b.height) };
  return isMac ? p : screen.dipToScreenPoint(p); // Windows SetCursorPos takes physical pixels
}

async function askControl() {
  if (!sharedDisplay) return false;
  const gen = consentGen;
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(true)) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Разрешите Huddle управление компьютером',
      detail: 'Системные настройки → Конфиденциальность и безопасность → Универсальный доступ: включите Huddle, затем закройте и снова откройте приложение.',
    });
    return false;
  }
  const { response } = process.env.HUDDLE_TEST_ALLOW_CONTROL
    ? { response: 0 }
    : await dialog.showMessageBox(win, {
        type: 'question',
        message: 'Преподаватель просит управление мышью',
        detail: `Отключить можно в любой момент: ${STOP_LABEL}, кнопка в окне Huddle или остановка показа экрана.`,
        buttons: ['Разрешить', 'Отклонить'],
        defaultId: 1,
        cancelId: 1,
      });
  setControl(response === 0 && !!sharedDisplay && gen === consentGen);
  return control;
}

const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;

function applyInput(m) {
  if (!control || !sharedDisplay || !m || !unit(m.x) || !unit(m.y)) return;
  input ??= require('./input');
  const p = toScreen(m.x, m.y);
  input.move(p.x, p.y);
  if ((m.a === 'down' || m.a === 'up') && (m.b === 'left' || m.b === 'right')) {
    input.button(m.b, m.a === 'down');
    m.a === 'down' ? held.add(m.b) : held.delete(m.b);
  }
  if (m.a === 'wheel' && Number.isFinite(m.dy)) input.wheel(Math.max(-1000, Math.min(1000, m.dy)));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(SITE + '/') && ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
  // "Показать экран" shares the whole primary screen — the overlay must match what the teacher sees.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'] }); // on macOS this also adds the app to the Screen Recording list
    if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
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
    sharedDisplay = display;
    showOverlay(display);
    cb({ video: source });
  });

  const fromWin = (e) => e.sender === win?.webContents;
  ipcMain.on('ink', (e, msg) => fromWin(e) && overlay?.webContents.send('ink', msg));
  ipcMain.on('share-ended', (e) => {
    if (!fromWin(e)) return;
    consentGen++;
    setControl(false);
    sharedDisplay = null;
    overlay?.destroy();
  });
  ipcMain.handle('control-request', (e) => (fromWin(e) ? askControl() : false));
  ipcMain.on('control-stop', (e) => fromWin(e) && setControl(false));
  ipcMain.on('input', (e, m) => fromWin(e) && applyInput(m));

  createWindow();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
