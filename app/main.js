// Huddle desktop app: the website in a window, plus what a browser can't do while sharing the screen —
// a click-through overlay for annotations, a floating control bar over full-screen slides,
// and the other side's taps landing on my PowerPoint slides when I switch that on.
const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell, systemPreferences } = require('electron');
const path = require('node:path');
const os = require('node:os');
const initUpdates = require('./updater');
const { ask, pick } = require('./dialogs');
const recent = require('./recent');
const lessons = require('./lesson');

const SITE = process.env.HUDDLE_URL || 'https://huddle.runterra.ru';
const preload = path.join(__dirname, 'preload.js');
const isMac = process.platform === 'darwin';

let win = null, overlay = null, bar = null;
let sharedDisplay = null; // set while sharing: the display the bar and the camera window go on
// What the child sees, in DIP: the screen, or the shared window as it is right now (null: unknown, e.g. a window
// on macOS — then no overlay and no taps). Windows only: the shared window's handle, and PowerPoint's editor window
// when the picture should follow its slide show.
let sharedRect = null, sharedHwnd = 0, pickedHwnd = 0, pptEditor = 0, trackTimer = null, reshareTo = null;
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
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url.startsWith(SITE + '/download')) shell.openExternal(url); // update link from the page
    // The child's camera over my full-screen slides (app.js fills this blank same-origin window).
    if (url === 'about:blank' && frameName === 'huddle-cam' && sharedDisplay) {
      const wa = sharedDisplay.workArea, width = 240, height = 180;
      return { action: 'allow', overrideBrowserWindowOptions: {
        x: wa.x + wa.width - width - 16, y: wa.y + wa.height - height - 16, width, height,
        frame: false, skipTaskbar: true, focusable: false, minWidth: 120, minHeight: 90, backgroundColor: '#000' } };
    }
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (w) => {
    w.setAlwaysOnTop(true, 'screen-saver'); // above the slide show, like the bar
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.setContentProtection(true); // not in my shared picture: the child must not see themselves
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

function showOverlay(rect) {
  overlay?.destroy();
  overlay = floating({ ...rect, focusable: false, movable: false });
  overlay.setBounds(rect); // Windows trims the initial size to the work area (above the taskbar)
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

const hwndOf = (id) => Number(/^window:(\d+):/.exec(id)?.[1] ?? 0);
const toDip = (r) => r && screen.screenToDipRect(null, r);

function startShare(source) {
  clearInterval(trackTimer);
  const primary = screen.getPrimaryDisplay();
  sharedHwnd = pickedHwnd = hwndOf(source.id);
  pptEditor = 0;
  if (!sharedHwnd) {
    sharedDisplay = screen.getAllDisplays().find((d) => String(d.id) === source.display_id) ?? primary;
    sharedRect = sharedDisplay.bounds;
  } else if (process.platform === 'win32') {
    input ??= require('./input');
    const cls = input.className(sharedHwnd);
    pptEditor = cls === 'PPTFrameClass' ? sharedHwnd : cls === 'screenClass' ? input.editor() : 0;
    sharedRect = toDip(input.rect(sharedHwnd));
    sharedDisplay = screen.getDisplayMatching(sharedRect ?? primary.bounds);
    trackTimer = setInterval(trackWindow, 500);
  } else {
    sharedRect = null; // ponytail: no window geometry on macOS yet (CGWindowListCopyWindowInfo) — no overlay, no taps
    sharedDisplay = primary;
  }
  appLog({ share: sharedHwnd ? 'window' : 'screen', powerpoint: !!pptEditor });
  if (sharedRect) showOverlay(sharedRect);
  showBar(sharedDisplay);
}

// Twice a second while a window is shared: keep the overlay on it, and with PowerPoint show the slide show
// while it runs and the editor otherwise (they are separate windows, a capture sticks to one).
function trackWindow() {
  const r = toDip(input.rect(sharedHwnd));
  if (JSON.stringify(r) !== JSON.stringify(sharedRect)) {
    sharedRect = r;
    if (!r) overlay?.hide();
    else if (overlay) { overlay.setBounds(r); overlay.showInactive(); }
    else showOverlay(r);
  }
  if (!pptEditor || reshareTo) return;
  const show = input.slideShow();
  // only this PowerPoint's own slide show, never another program's window that happens to use the class name
  const want = (show && input.process(show) === input.process(pptEditor) ? show : 0) || (input.rect(pptEditor) ? pptEditor : 0);
  if (want && want !== sharedHwnd) switchTo(want);
}

async function switchTo(hwnd) {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((s) => hwndOf(s.id) === hwnd);
  if (!source || !sharedDisplay || reshareTo) return;
  reshareTo = source; // the page asks again (getDisplayMedia) and gets this one without the picker
  sharedHwnd = hwnd;
  appLog({ share: 'follow', to: input.className(hwnd) });
  win?.webContents.send('reshare');
}

function endShare() {
  setClicks(false);
  clearInterval(trackTimer);
  sharedDisplay = sharedRect = reshareTo = null;
  sharedHwnd = pickedHwnd = pptEditor = 0;
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
  tapLogged = false;
  pushBar();
  win?.webContents.send('clicks', on);
}

// Normalized (0..1) point on the shared display -> screen point (DIP) -> what the OS input API expects.
function toPoint(x, y) {
  const b = sharedRect;
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
let lastClick = 0, tapLogged = false;

async function applyClick(m) {
  if (!shareState.clicks || !sharedRect || !unit(m?.x) || !unit(m?.y)) return appLog({ tap: 'ignored', clicks: shareState.clicks, sharing: !!sharedDisplay, where: !!sharedRect });
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
  if (!(await input.accepts(to, pickedHwnd))) { // a window the app switched to by itself gets no taps (slide show aside)
    appLog({ tap: 'rejected', under: input.under?.(to) ?? null }); // which window was there instead
    return flash(sharedHwnd ? 'Нажатие ученика не прошло: показываемое окно закрыто другим' : 'Нажатие ученика не прошло: на экране не показ PowerPoint');
  }
  if (!shareState.clicks || !sharedRect) return; // switched off (or the window went away) while we looked
  input.click(to, toOS(screen.getCursorScreenPoint())); // my cursor jumps there and straight back
  if (!tapLogged) { tapLogged = true; appLog({ tap: 'ok' }); } // first one per switch-on is enough
  overlay?.webContents.send('ink', { t: 'ptr', x: m.x, y: m.y }); // I see where the child tapped
}

// "Презентация": the teacher picks a PPTX; built once (PowerPoint / ONLYOFFICE renders it, minutes), then cached by content.
async function openLesson() {
  const { canceled, filePaths: [file] } = await dialog.showOpenDialog(win, { title: 'Презентация для урока', filters: [{ name: 'PowerPoint', extensions: ['pptx'] }], properties: ['openFile'] });
  if (canceled || !file) return null;
  const fs = require('node:fs');
  const bytes = fs.readFileSync(file);
  const dir = path.join(app.getPath('userData'), 'lessons');
  const id = require('node:crypto').createHash('sha1').update(bytes).digest('hex');
  const cached = path.join(dir, id + '.zip');
  let zip;
  if (fs.existsSync(cached)) zip = fs.readFileSync(cached);
  else {
    const why = lessons.missing();
    if (why) {
      await ask({ parent: win, kind: 'warn', title: 'Не получится подготовить презентацию', detail: why, buttons: ['Понятно'] });
      return null;
    }
    const t = Date.now();
    try {
      zip = await lessons.build(file, nativeImage, (text) => win?.webContents.send('lesson-progress', text));
    } catch (e) {
      appLog({ lesson: 'build-error', msg: String(e.message).slice(0, 600) });
      await ask({ parent: win, kind: 'warn', title: 'Не удалось подготовить презентацию', detail: String(e.message).slice(0, 600), buttons: ['Понятно'] });
      return null;
    }
    appLog({ lesson: 'built', s: Math.round((Date.now() - t) / 1000), mb: +(zip.length / 1e6).toFixed(1) });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cached, zip);
  }
  return { id, files: require('fflate').unzipSync(zip) }; // files: { 'lesson.json': bytes, 's1.jpg': bytes, ... }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'; // dark title bar and system UI on Windows / macOS
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith(SITE + '/') && ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  // "Демонстрация": the teacher picks a screen or a window; overlay, bar and taps follow what the other side sees.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    if (reshareTo) {
      const source = reshareTo;
      reshareTo = null;
      return cb({ video: source });
    }
    // on macOS this also adds the app to the Screen Recording list
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
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
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const source = await pick({
      parent: win,
      sources: sources.filter((s) => s.name && !own.has(s.id)),
      hint: process.platform === 'win32' ? 'Окно PowerPoint: когда вы запустите показ слайдов, ученик сразу увидит его.' : '',
    });
    if (!source) return cb({});
    startShare(source);
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
  ipcMain.on('home', (e) => fromWin(e) && win.loadFile(path.join(__dirname, 'start.html'), { query: { site: SITE } }));
  ipcMain.on('clicks-off', (e) => fromWin(e) && setClicks(false));
  ipcMain.handle('lesson-open', (e) => (fromWin(e) ? openLesson() : null));

  ipcMain.on('version', (e) => (e.returnValue = app.getVersion()));
  createWindow();
  // hand over once: a rejoin must not replay them
  ipcMain.handle('app-logs', (e) => (fromWin(e) ? appLogs.splice(0) : []));
  // start screen only (a local file): the remote site has no business editing this list
  const fromStart = (e) => fromWin(e) && e.sender.getURL().startsWith('file:');
  ipcMain.handle('recent', (e) => (fromStart(e) ? recent.load() : []));
  ipcMain.on('recent-rename', (e, code, name) => fromStart(e) && recent.rename(code, name));
  ipcMain.on('recent-remove', (e, code) => fromStart(e) && recent.remove(code));
  appLog({ start: app.getVersion(), os: `${process.platform} ${os.release()} ${process.arch}`, packaged: app.isPackaged });
  initUpdates({ getWin: () => win, isBusy: () => !!sharedDisplay, site: SITE, log: appLog, ask });
});

app.on('window-all-closed', () => app.quit());
