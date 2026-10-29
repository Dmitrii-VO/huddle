// Updates from GitHub Releases (tags vX.Y.Z).
// Windows (NSIS install): downloads in the background, offers a restart, else installs on quit.
// macOS: an unsigned app can't replace itself, so we only offer to download the new version.
const { app, shell } = require('electron');
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

  const check = async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
      const latest = (await res.json()).tag_name?.replace(/^v/, '');
      log({ update: 'checked', latest });
      if (!latest || !newer(latest, app.getVersion()) || offered === latest) return;
      offered = latest;
      whenFree(async () => {
        const response = await ask({
          parent: getWin(),
          title: `Доступна новая версия Huddle ${latest}`,
          detail: `У вас ${app.getVersion()}. Скачайте новую версию и замените приложение в папке «Программы», уроки и ссылки сохранятся.`,
          buttons: ['Скачать', 'Позже'],
        });
        log({ update: response === 0 ? 'download' : 'later', version: latest });
        if (response === 0) shell.openExternal(`${site}/download`);
      });
    } catch (e) {
      log({ update: 'error', msg: e.message }); // offline: try next time
    }
  };
  check();
  setInterval(check, EVERY);
};

module.exports.newer = newer;
