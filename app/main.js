// Huddle desktop app: the website in a window, plus what a browser can't do while sharing the screen —
// a click-through overlay for annotations, a floating control bar over full-screen slides,
// and the other side's taps landing on my PowerPoint slides when I switch that on.
const { app, BrowserWindow, desktopCapturer, ipcMain, nativeTheme, screen, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const os = require('node:os');
const initUpdates = require('./updater');
const { ask } = require('./dialogs');
const recent = require('./recent');

const SITE = process.env.HUDDLE_URL || 'https://huddle.runterra.ru';
const preload = path.join(__dirname, 'preload.js');
const isMac = process.platform === 'darwin';

let win = null, overlay = null, bar = null;
let sharedDisplay = null; // set while the screen is shared
let input = null;         // native module, loaded on first use
// my own annotation tool while I share; clicks: the other side may tap my slides (lives here, never in the remote page)
const shareState = { tool: null, color: 0, mic: true, clicks: false };

// App events for the server journal: buffered until the page joins a lesson (it has the socket).
const appLogs = [];
function appLog(m) {
  const entry = { at: new Date().toISOString(), ...m };
  appLogs.push(entry);
  if (appLogs.length > 50) appLogs.shift();
  win?.webContents.send('app-log', entry);
}

function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 800, minWidth: 640, minHeight: 480, title: 'Huddle', autoHideMenuBar: true, backgroundColor: '#111111', webPreferences: { preload } });
  win.loadFile(path.join(__dirname, 'start.html'), { query: { site: SITE } });
  // Remote pages get the preload API, so never leave our site.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SITE + '/') && !url.startsWith('file:')) e.preventDefault();
  });
  win.webContents.on('did-navigate', (_e, url) => {
    setClicks(false);
    const code = url.startsWith(SITE + '/r/') && url.slice(SITE.length + 3).split(/[?#]/)[0];
    if (code) recent.visit(code);
  });
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
  const wa = display.workArea, width = Math.min(1000, wa.width - 16), height = 56;
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
  setClicks(false);
  sharedDisplay = null;
  shareState.tool = null;
  overlay?.destroy();
  bar?.destroy();
}

// The teacher's switch on the bar: the child may tap the slides (PowerPoint triggers). Only single left clicks,
// only on the shared display, only while the PowerPoint slide show is in front — see applyClick.
async function setClicks(on) {
  if (on && isMac && !systemPreferences.isTrustedAccessibilityClient(true)) {
    await ask({
      parent: win, onTop: true, kind: 'warn', // onTop: a window-attached dialog would hide behind the slides
      title: 'Разрешите Huddle нажимать за ученика',
      detail: 'Системные настройки → Конфиденциальность и безопасность → Универсальный доступ: включите Huddle, затем закройте и снова откройте приложение.',
      buttons: ['Понятно'],
    });
    on = false;
  }
  on = on && !!sharedDisplay;
  if (shareState.clicks === on) return;
  shareState.clicks = on;
  pushBar();
  win?.webContents.send('clicks', on);
}

// Normalized (0..1) point on the shared display -> screen point (DIP) -> what the OS input API expects.
function toPoint(x, y) {
  const b = sharedDisplay.bounds;
  return { x: Math.round(b.x + x * b.width), y: Math.round(b.y + y * b.height) };
}
const toOS = (p) => (isMac ? p : screen.dipToScreenPoint(p)); // Windows SetCursorPos takes physical pixels
const inside = (p, r) => r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

let bannerTimer;
function flash(text) {
  overlay?.webContents.send('banner', text);
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => overlay?.webContents.send('banner', ''), 3000);
}

const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
let lastClick = 0;

async function applyClick(m) {
  if (!shareState.clicks || !sharedDisplay || !unit(m?.x) || !unit(m?.y)) return;
  const now = Date.now();
  if (now - lastClick < 150) return; // a child hammering the screen
  lastClick = now;
  const p = toPoint(m.x, m.y);
  if (inside(p, bar?.getBounds())) return; // never press my own bar ("Остановить")
  input ??= require('./input');
  if (shareState.tool) {
    // ponytail: timed pass-through while I'm drawing; races if the OS delivers the click later than 300 ms
    overlay?.setIgnoreMouseEvents(true);
    setTimeout(() => overlay?.setIgnoreMouseEvents(!shareState.tool), 300);
  }
  const to = toOS(p);
  if (!(await input.accepts(to))) return flash('Нажатие ученика не прошло: на экране не показ PowerPoint');
  if (!shareState.clicks || !sharedDisplay) return; // switched off while we looked
  input.click(to, toOS(screen.getCursorScreenPoint())); // my cursor jumps there and straight back
  overlay?.webContents.send('ink', { t: 'ptr', x: m.x, y: m.y }); // I see where the child tapped
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'; // dark title bar and system UI on Windows / macOS
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(SITE + '/') && ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
  // "Демонстрация" shares the whole primary screen — overlay and bar must match what the other side sees.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'] }); // on macOS this also adds the app to the Screen Recording list
    if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      const response = await ask({
        parent: win, kind: 'warn',
        title: 'Разрешите Huddle запись экрана',
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
    if (action === 'clicks') return setClicks(!shareState.clicks);
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
  ipcMain.on('click', (e, m) => fromWin(e) && applyClick(m));
  ipcMain.on('clicks-off', (e) => fromWin(e) && setClicks(false));

  ipcMain.on('version', (e) => (e.returnValue = app.getVersion()));
  createWindow();
  ipcMain.handle('app-logs', (e) => (fromWin(e) ? appLogs : []));
  // start screen only (a local file): the remote site has no business editing this list
  const fromStart = (e) => fromWin(e) && e.sender.getURL().startsWith('file:');
  ipcMain.handle('recent', (e) => (fromStart(e) ? recent.load() : []));
  ipcMain.on('recent-rename', (e, code, name) => fromStart(e) && recent.rename(code, name));
  ipcMain.on('recent-remove', (e, code) => fromStart(e) && recent.remove(code));
  appLog({ start: app.getVersion(), os: `${process.platform} ${os.release()} ${process.arch}`, packaged: app.isPackaged });
  initUpdates({ getWin: () => win, isBusy: () => !!sharedDisplay, site: SITE, log: appLog, ask });
});

app.on('window-all-closed', () => app.quit());
