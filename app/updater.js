// Updates from GitHub Releases (tags vX.Y.Z).
// Windows (NSIS install): downloads in the background, offers a restart, else installs on quit.
// macOS: the app is unsigned, so Squirrel.Mac can't update it; instead the release's .zip is downloaded and
// unpacked in the background, and the bundle in "Программы" is swapped by a small script once the app quits.
// (Downloaded by the app itself, it carries no quarantine flag, so Gatekeeper doesn't stop the new version.)
const { app, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { autoUpdater } = require('electron-updater');

const REPO = 'Dmitrii-VO/huddle';
const EVERY = 6 * 3600 * 1000;

// "0.10.1" > "0.9.3"
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

module.exports = function initUpdates({ getWin, isBusy, site, log, ask }) {
  if (!app.isPackaged) return log({ update: 'skipped (dev build)' });
  let offered = null; // version already offered this session: ask once, not every 6 hours

  // Never pop a dialog in the middle of a demonstration; try again in a minute.
  const whenFree = (fn) => (isBusy() ? setTimeout(() => whenFree(fn), 60_000) : fn());

  if (process.platform === 'win32') {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => log({ update: 'checking' }));
    autoUpdater.on('update-not-available', () => log({ update: 'up to date' }));
    autoUpdater.on('update-available', ({ version }) => log({ update: 'downloading', version }));
    autoUpdater.on('update-downloaded', ({ version }) => {
      log({ update: 'downloaded', version });
      if (offered === version) return;
      offered = version;
      whenFree(async () => {
        const response = await ask({
          parent: getWin(),
          title: `Готова новая версия Huddle ${version}`,
          detail: `У вас ${app.getVersion()}. Обновление уже скачано, перезапуск займёт несколько секунд. Если выберете «Позже», оно установится при следующем закрытии приложения.`,
          buttons: ['Перезапустить и обновить', 'Позже'],
        });
        log({ update: response === 0 ? 'restart now' : 'later' });
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });
    autoUpdater.on('error', (e) => log({ update: 'error', msg: e.message }));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, EVERY);
    return;
  }

  // Huddle.app, if the app may replace it (not run from the disk image or a translocated copy, folder writable).
  const bundle = path.resolve(process.execPath, '../../..');
  const canSwap = () => {
    if (!bundle.endsWith('.app') || /AppTranslocation|^\/Volumes\//.test(bundle)) return false;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return true; } catch { return false; }
  };
  let ready = null; // unpacked new Huddle.app waiting for the swap

  // After this process exits: replace the bundle (the old one goes back if the new one can't be put in place),
  // and start it again if asked to.
  function swap(relaunch) {
    const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
rm -rf "$OLD.old"
if mv "$OLD" "$OLD.old"; then
  if mv "$NEW" "$OLD"; then rm -rf "$OLD.old"; else mv "$OLD.old" "$OLD"; fi
fi
${relaunch ? 'open "$OLD"' : ''}`;
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, OLD: bundle, NEW: ready } }).unref();
  }
  app.on('will-quit', () => { if (ready) { log({ update: 'install on quit' }); swap(false); ready = null; } });

  async function download(release) {
    const asset = release.assets?.find((a) => /mac.*\.zip$/.test(a.name));
    if (!asset) throw new Error('no mac zip in the release');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-update-'));
    const zip = path.join(dir, asset.name);
    // ~200 MB: progress on the Dock icon and in the journal; a stalled download gives up instead of hanging forever.
    log({ update: 'downloading', mb: Math.round(asset.size / 1e6) });
    const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const parts = [];
    let got = 0, logged = 0;
    try {
      for await (const chunk of res.body) {
        parts.push(chunk);
        got += chunk.length;
        getWin()?.setProgressBar(got / asset.size);
        if (got / asset.size >= logged + 0.25) log({ update: 'downloading', pct: (logged += 0.25) * 100 });
      }
    } finally { getWin()?.setProgressBar(-1); }
    const bytes = Buffer.concat(parts);
    // The checksum electron-builder publishes next to it (what the Windows updater checks too): no broken or
    // cut-short download gets installed. ponytail: same trust as the release itself; Developer ID signing is the real fix
    const yml = release.assets.find((a) => a.name === 'latest-mac.yml');
    const sums = yml && (await (await fetch(yml.browser_download_url)).text());
    const want = sums && new RegExp(`url: ${asset.name.replace(/\./g, '\\.')}\\s+sha512: (\\S+)`).exec(sums)?.[1];
    if (!want || require('node:crypto').createHash('sha512').update(bytes).digest('base64') !== want) throw new Error('checksum mismatch');
    fs.writeFileSync(zip, bytes);
    await new Promise((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', zip, dir], (e) => (e ? reject(e) : resolve())));
    fs.rmSync(zip);
    const app2 = fs.readdirSync(dir).find((f) => f.endsWith('.app'));
    if (!app2) throw new Error('no .app in the zip');
    const id = (p) => /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)/.exec(fs.readFileSync(path.join(p, 'Contents/Info.plist'), 'utf8'))?.[1];
    if (id(path.join(dir, app2)) !== id(bundle)) throw new Error('not a Huddle bundle');
    return path.join(dir, app2);
  }

  const offer = (latest, auto) => whenFree(async () => {
    const response = await ask({
      parent: getWin(),
      title: auto ? `Готова новая версия Huddle ${latest}` : `Доступна новая версия Huddle ${latest}`,
      detail: auto
        ? `У вас ${app.getVersion()}. Обновление уже скачано, перезапуск займёт несколько секунд. Если выберете «Позже», оно установится при следующем закрытии приложения.`
        : `У вас ${app.getVersion()}. Скачайте новую версию и замените приложение в папке «Программы», уроки и ссылки сохранятся.`,
      buttons: auto ? ['Перезапустить и обновить', 'Позже'] : ['Скачать', 'Позже'],
    });
    log({ update: response === 0 ? (auto ? 'restart now' : 'download') : 'later', version: latest });
    if (response !== 0) return;
    if (!auto) return shell.openExternal(`${site}/download`);
    swap(true);
    ready = null;
    app.quit();
  });

  let lastCheck = 0;
  const check = async () => {
    lastCheck = Date.now();
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
      const release = await res.json();
      const latest = release.tag_name?.replace(/^v/, '');
      log({ update: 'checked', latest });
      if (!latest || !newer(latest, app.getVersion()) || offered === latest) return;
      offered = latest;
      if (canSwap()) {
        try {
          ready = await download(release);
          log({ update: 'downloaded', version: latest });
          return offer(latest, true);
        } catch (e) {
          log({ update: 'error', msg: e.message }); // then the old way: the teacher downloads it
        }
      } else log({ update: 'manual', where: bundle });
      offer(latest, false);
    } catch (e) {
      log({ update: 'error', msg: e.message }); // offline: try next time
    }
  };
  check();
  setInterval(check, EVERY);
  // On a Mac closing the window leaves the app running for days: look again when the teacher comes back to it.
  app.on('browser-window-focus', () => { if (Date.now() - lastCheck > 30 * 60_000) check(); });
};

module.exports.newer = newer;
