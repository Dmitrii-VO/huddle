// Huddle desktop app: the website in a window, plus what a browser can't do while sharing the screen —
// a click-through overlay for annotations, a floating control bar over full-screen slides,
// and letting the other side drive mouse and keyboard after the user agrees.
const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const os = require('node:os');
const initUpdates = require('./updater');

const SITE = process.env.HUDDLE_URL || 'https://huddle.runterra.ru';
const preload = path.join(__dirname, 'preload.js');
const STOP_KEY = 'CommandOrControl+Alt+X';
const STOP_LABEL = process.platform === 'darwin' ? '⌘⌥X' : 'Ctrl+Alt+X';
const isMac = process.platform === 'darwin';
const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Delete', 'Enter', 'Backspace', 'Tab', 'Escape', ' ']);

let win = null, overlay = null, bar = null;
let sharedDisplay = null; // set while the screen is shared
let control = false;      // consent lives here, never in the (remote) page
let consentGen = 0;       // bumped on navigation / share end: a pending "Разрешить" must not outlive them
let input = null;         // native module, loaded on first use
const held = new Set();   // synthetic mouse buttons currently down
const heldKeys = new Set();
const shareState = { tool: null, color: 0, mic: true }; // my own annotation tool while I share

// App events for the server journal: buffered until the page joins a lesson (it has the socket).
const appLogs = [];
function appLog(m) {
  const entry = { at: new Date().toISOString(), ...m };
  appLogs.push(entry);
  if (appLogs.length > 50) appLogs.shift();
  win?.webContents.send('app-log', entry);
}

function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 800, title: 'Huddle', autoHideMenuBar: true, webPreferences: { preload } });
  win.loadFile(path.join(__dirname, 'start.html'), { query: { site: SITE } });
  // Remote pages get the preload API, so never leave our site.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SITE + '/') && !url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.on('did-navigate', () => { consentGen++; setControl(false); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SITE + '/download')) shell.openExternal(url); // update link from the page
    return { action: 'deny' };
  });
  win.on('closed', () => { overlay?.destroy(); bar?.destroy(); app.quit(); });
}

// Windows shown over everything on the shared display, kept out of the captured picture.
function floating(opts) {
  const w = new BrowserWindow({ frame: false, transparent: true, skipTaskbar: true, hasShadow: false, resizable: false, ...opts, webPreferences: { preload } });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setContentProtection(true);
  return w;
}

// ponytail: always the primary display; add a picker when someone shares with two monitors.
function showOverlay(display) {
  overlay?.destroy();
  overlay = floating({ ...display.bounds, focusable: false, movable: false });
  overlay.setBounds(display.bounds); // Windows trims the initial size to the work area (above the taskbar)
  overlay.setIgnoreMouseEvents(true);
  overlay.loadURL(SITE + '/overlay.html');
  overlay.on('closed', () => (overlay = null));
}

// Zoom-like control bar at the top of the shared screen: mic, pen, pointer, stop.
function showBar(display) {
  bar?.destroy();
  const wa = display.workArea, width = Math.min(880, wa.width - 16), height = 56;
  bar = floating({ x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y + 6, width, height, focusable: false });
  bar.setAlwaysOnTop(true, 'screen-saver', 1); // above the overlay
  bar.loadFile(path.join(__dirname, 'bar.html'));
  bar.webContents.on('did-finish-load', pushBar);
  bar.on('closed', () => (bar = null));
}

function pushBar() {
  bar?.webContents.send('state', shareState);
  overlay?.webContents.send('tool', shareState);
}

function setShareTool(tool) {
  shareState.tool = tool;
  overlay?.setIgnoreMouseEvents(!tool); // drawing needs the clicks; otherwise everything passes through
  pushBar();
}

function endShare() {
  consentGen++;
  setControl(false);
  sharedDisplay = null;
  shareState.tool = null;
  overlay?.destroy();
  bar?.destroy();
}

function setControl(on) {
  if (control === on) return;
  control = on;
  if (on) {
    setShareTool(null); // remote clicks must reach the apps, not my drawing layer
    globalShortcut.register(STOP_KEY, () => {
      setControl(false);
      win?.webContents.send('control-off');
    });
  } else {
    globalShortcut.unregister(STOP_KEY);
    for (const b of held) input.button(b, false); // don't leave a drag or a key hanging
    for (const k of heldKeys) input.key(k, false);
    held.clear();
    heldKeys.clear();
  }
  overlay?.webContents.send('banner', on ? `Компьютером управляет собеседник · ${STOP_LABEL} — отключить` : '');
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
        message: 'Собеседник просит управление компьютером',
        detail: `Он сможет двигать мышь, нажимать и печатать. Отключить можно в любой момент: ${STOP_LABEL}, кнопка в окне Huddle или остановка демонстрации.`,
        buttons: ['Разрешить', 'Отклонить'],
        defaultId: 1,
        cancelId: 1,
      });
  setControl(response === 0 && !!sharedDisplay && gen === consentGen);
  return control;
}

const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;

function applyInput(m) {
  if (!control || !sharedDisplay || !m) return;
  input ??= require('./input');
  if ((m.a === 'key' || m.a === 'keyup') && KEYS.has(m.k)) {
    input.key(m.k, m.a === 'key');
    m.a === 'key' ? heldKeys.add(m.k) : heldKeys.delete(m.k);
    return;
  }
  if (m.a === 'type' && typeof m.s === 'string' && [...m.s].length === 1) return input.type(m.s);
  if (!unit(m.x) || !unit(m.y)) return;
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
  // "Демонстрация" shares the whole primary screen — overlay and bar must match what the other side sees.
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
    showBar(display);
    cb({ video: source });
  });

  const fromWin = (e) => e.sender === win?.webContents;
  const fromOverlay = (e) => e.sender === overlay?.webContents;
  const fromBar = (e) => e.sender === bar?.webContents;

  // the page -> overlay: the other side's marks on my screen
  ipcMain.on('ink', (e, msg) => fromWin(e) && overlay?.webContents.send('ink', msg));
  // overlay -> the page -> the other side: my own marks
  ipcMain.on('ink-out', (e, msg) => fromOverlay(e) && win?.webContents.send('ink-out', msg));
  ipcMain.on('share-ended', (e) => fromWin(e) && endShare());
  ipcMain.on('bar-state', (e, s) => {
    if (!fromWin(e)) return;
    shareState.mic = !!s?.mic;
    pushBar();
  });
  ipcMain.on('bar', (e, action) => {
    if (!fromBar(e)) return;
    if (action === 'mic' || action === 'stop') return win?.webContents.send('bar-action', action);
    if (['pen', 'pointer', 'eraser'].includes(action)) return setShareTool(shareState.tool === action ? null : action);
    if (action === 'undo' || action === 'clear') return overlay?.webContents.send('cmd', action);
    const color = /^color:(\d)$/.exec(action)?.[1];
    if (color) {
      shareState.color = +color;
      if (!shareState.tool) shareState.tool = 'pen';
      setShareTool(shareState.tool);
    }
  });
  ipcMain.handle('control-request', (e) => (fromWin(e) ? askControl() : false));
  ipcMain.on('control-stop', (e) => fromWin(e) && setControl(false));
  ipcMain.on('input', (e, m) => fromWin(e) && applyInput(m));

  ipcMain.on('version', (e) => (e.returnValue = app.getVersion()));
  createWindow();
  ipcMain.handle('app-logs', (e) => (fromWin(e) ? appLogs : []));
  appLog({ start: app.getVersion(), os: `${process.platform} ${os.release()} ${process.arch}`, packaged: app.isPackaged });
  initUpdates({ getWin: () => win, isBusy: () => !!sharedDisplay || control, site: SITE, log: appLog });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
