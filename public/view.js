// Layout controls that only touch the page: speaker / gallery, my own tile, fullscreen.
const $ = (id) => document.getElementById(id);

$('view').onclick = () => {
  const gallery = $('stage').classList.toggle('gallery');
  $('view').querySelector('span').textContent = gallery ? 'Докладчик' : 'Галерея';
};
$('hide-self').onclick = () => { $('local-tile').hidden = true; $('show-self').hidden = false; };
$('show-self').onclick = () => { $('local-tile').hidden = false; $('show-self').hidden = true; };

// Drag my floating video around the stage (speaker view only).
$('local-tile').onpointerdown = (e) => {
  const tile = $('local-tile'), stage = $('stage');
  if (e.target.id === 'hide-self' || getComputedStyle(tile).position !== 'absolute') return;
  tile.setPointerCapture(e.pointerId);
  const start = { x: e.clientX - tile.offsetLeft, y: e.clientY - tile.offsetTop };
  tile.onpointermove = (m) => {
    tile.style.left = Math.max(0, Math.min(stage.clientWidth - tile.offsetWidth, m.clientX - start.x)) + 'px';
    tile.style.top = Math.max(0, Math.min(stage.clientHeight - tile.offsetHeight, m.clientY - start.y)) + 'px';
    tile.style.right = 'auto';
  };
  tile.onpointerup = () => (tile.onpointermove = null);
};

$('fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
};
document.onfullscreenchange = () => {
  $('fullscreen').querySelector('span').textContent = document.fullscreenElement ? 'Обычный экран' : 'Во весь экран';
};

// Desktop app too old for this page (missing bridge features): ask to update.
const MIN_APP = '0.2.0';
const olderThan = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i !== -1 && x[i] < y[i];
};
if (window.huddle && olderThan(window.huddle.version ?? '0.1.0', MIN_APP)) $('old-app').hidden = false; // 0.1.x had no version

// In a desktop browser, point to the app (phones can't install it).
$('get-app').hidden = !!window.huddle || /iPhone|iPad|Android/.test(navigator.userAgent);
