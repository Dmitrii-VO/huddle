import { COLORS, createInk, isInk } from '/ink.js';

const $ = (id) => document.getElementById(id);
const room = location.pathname.split('/')[2];
// Like Zoom, say nothing while all is well; only waiting / trouble shows up.
function status(text) {
  $('status').textContent = text;
  $('status').hidden = text === 'На связи';
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
}

const { iceServers } = await (await fetch('/config')).json();
const local = await getMedia();
$('local').srcObject = local;

let pc = null, dc = null, polite = false, makingOffer = false, ignoreOffer = false;
let screenStream = null, screenSenders = [];
const remoteStreams = new Map();
let remoteCamId = null, remoteScreenId = null, remoteState = { mic: true, cam: true };

// Camera may be missing or denied: fall back to audio, then to nothing.
async function getMedia() {
  for (const c of [{ video: true, audio: true }, { audio: true }]) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch {}
  }
  return new MediaStream();
}

// --- signaling ---
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?room=${room}`);
const send = (msg) => ws.send(JSON.stringify(msg));

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === 'joined') {
    status(msg.peer ? 'Соединение…' : 'Ждём собеседника — нажмите «Пригласить»');
    polite = msg.peer; // the joiner waits for the first offer instead of racing its own
  } else if (msg.type === 'peer-joined') {
    polite = false; start();
  } else if (msg.type === 'peer-left') {
    stop(); status('Собеседник вышел. Ждём…');
  } else {
    // Handle one at a time: a candidate must not race ahead of its description.
    signals = signals.then(() => onSignal(msg)).catch(console.error);
  }
};
let signals = Promise.resolve();
ws.onclose = (e) => status(e.code === 4001 ? 'В комнате уже двое' : 'Нет связи с сервером — обновите страницу');

// "Perfect negotiation" (MDN): both sides may offer; the polite one yields on collision.
async function onSignal({ description, candidate }) {
  if (!pc && polite) start();
  if (!pc) return;
  if (description) {
    const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
    ignoreOffer = !polite && collision;
    if (ignoreOffer) return;
    await pc.setRemoteDescription(description);
    if (description.type === 'offer') {
      await pc.setLocalDescription();
      send({ description: pc.localDescription });
    }
  } else if (candidate) {
    try { await pc.addIceCandidate(candidate); } catch (e) { if (!ignoreOffer) console.error(e); }
  }
}

function start() {
  pc = new RTCPeerConnection({ iceServers });
  for (const t of local.getTracks()) pc.addTrack(t, local);
  if (screenStream) addScreen();

  dc = pc.createDataChannel('data', { negotiated: true, id: 0 });
  dc.onmessage = (e) => onData(JSON.parse(e.data));
  dc.onopen = () => {
    sendData({ t: 'cam', id: local.id });
    sendState();
    if (screenStream) sendData({ t: 'screen', id: screenStream.id });
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      send({ description: pc.localDescription });
    } catch (e) {
      console.error(e);
    } finally {
      makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => candidate && send({ candidate });
  pc.ontrack = ({ streams: [stream] }) => {
    remoteStreams.set(stream.id, stream);
    stream.onremovetrack = () => {
      if (!stream.getTracks().length) remoteStreams.delete(stream.id);
      render();
    };
    render();
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed') pc.restartIce();
    status({ connecting: 'Соединение…', connected: 'На связи', disconnected: 'Связь прерывается…', failed: 'Переподключение…' }[s] ?? $('status').textContent);
  };
}

function stop() {
  pc?.close();
  pc = dc = null;
  screenSenders = [];
  remoteStreams.clear();
  remoteCamId = remoteScreenId = null;
  remoteState = { mic: true, cam: true };
  window.huddle?.ink({ t: 'clear' });
  releaseControl(false);
  render();
}

function render() {
  const screen = remoteStreams.get(remoteScreenId) ?? null;
  const cam = remoteStreams.get(remoteCamId) ?? null;
  if ($('screen').srcObject !== screen) $('screen').srcObject = screen;
  if ($('remote').srcObject !== cam) $('remote').srcObject = cam;
  $('screen-wrap').hidden = !screen;
  $('stage').classList.toggle('has-screen', !!screen);
  $('remote-tile').classList.toggle('nocam', !cam?.getVideoTracks().length || !remoteState.cam);
  $('remote-tile').querySelector('.muted').toggleAttribute('hidden', remoteState.mic); // <svg> has no .hidden property
  $('local-tile').classList.toggle('nocam', !local.getVideoTracks()[0]?.enabled);
  if (!screen) { setTool(null); ink.apply({ t: 'clear' }); }
  fitInk();
}

// --- data channel ---
function sendData(msg) {
  if (dc?.readyState !== 'open') return false;
  dc.send(JSON.stringify(msg));
  return true;
}

const sendState = () => sendData({
  t: 'state',
  mic: !!local.getAudioTracks()[0]?.enabled,
  cam: !!local.getVideoTracks()[0]?.enabled,
});

function onData(msg) {
  if (msg.t === 'cam') remoteCamId = msg.id;
  if (msg.t === 'screen') remoteScreenId = msg.id;
  if (msg.t === 'state') remoteState = { mic: !!msg.mic, cam: !!msg.cam };
  if (msg.t === 'chat') addMessage(msg.text, false);
  // Teacher's marks on my shared screen: only the desktop app can draw them over the real screen.
  if (isInk(msg)) return window.huddle?.ink(msg);
  if (msg.t === 'mouse') return window.huddle?.input(msg);
  if (msg.t === 'control-request') return answerControl();
  if (msg.t === 'control-stop') return releaseControl(false);
  if (msg.t === 'control') return onControl(msg);
  render();
}

// --- annotation tools over the remote screen (Zoom-style bar) ---
const ink = createInk($('ink'));
let tool = null, color = 0, current = null; // current: id + start point of the stroke/arrow being drawn

function setTool(name) {
  tool = tool === name ? null : name;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  $('ink').className = tool ? `active tool-${tool}` : '';
  $('text-input').hidden = true;
}

COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.style.background = c;
  b.title = 'Цвет';
  b.classList.toggle('on', i === color);
  b.onclick = () => {
    color = i;
    for (const s of $('colors').children) s.classList.toggle('on', s === b);
  };
  $('colors').append(b);
});

// Canvas covers exactly the video picture (object-fit: contain leaves letterbox bars).
function fitInk() {
  const v = $('screen');
  if ($('screen-wrap').hidden || !v.videoWidth) return ink.resize(0, 0);
  const box = v.getBoundingClientRect(), wrap = $('screen-wrap').getBoundingClientRect();
  const scale = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
  const w = v.videoWidth * scale, h = v.videoHeight * scale;
  $('ink').style.left = box.left - wrap.left + (box.width - w) / 2 + 'px';
  $('ink').style.top = box.top - wrap.top + (box.height - h) / 2 + 'px';
  ink.resize(w, h);
}
$('screen').addEventListener('resize', fitInk);
new ResizeObserver(fitInk).observe($('screen-wrap'));

function mark(msg) {
  ink.apply(msg);
  sendData(msg);
}
const clamp = (v) => Math.min(1, Math.max(0, v));
const at = (e) => ({ x: clamp(e.offsetX / $('ink').clientWidth), y: clamp(e.offsetY / $('ink').clientHeight) });
const mouseButton = (e) => (e.button === 2 ? 'right' : 'left');
const newId = () => Math.random().toString(36).slice(2);

$('ink').onpointerdown = (e) => {
  const p = at(e);
  if (tool === 'text') return startText(e, p);
  $('ink').setPointerCapture(e.pointerId);
  if (tool === 'control') return sendData({ t: 'mouse', a: 'down', b: mouseButton(e), ...p });
  if (tool === 'eraser') return erase(p);
  current = { id: newId(), ...p };
  if (tool === 'pen') mark({ t: 'line', id: current.id, c: color, ...p });
};
$('ink').onpointermove = (e) => {
  const p = at(e);
  if (tool === 'control') sendData({ t: 'mouse', a: 'move', ...p });
  if (tool === 'pointer') mark({ t: 'ptr', ...p });
  if (tool === 'eraser' && e.buttons) erase(p);
  if (!current) return;
  if (tool === 'pen') mark({ t: 'line', id: current.id, c: color, ...p });
  if (tool === 'arrow') mark({ t: 'arrow', id: current.id, c: color, x1: current.x, y1: current.y, x2: p.x, y2: p.y });
};
$('ink').onpointerup = (e) => {
  if (tool === 'control') sendData({ t: 'mouse', a: 'up', b: mouseButton(e), ...at(e) });
  current = null;
};
$('ink').addEventListener('wheel', (e) => {
  if (tool !== 'control') return;
  e.preventDefault();
  sendData({ t: 'mouse', a: 'wheel', dy: e.deltaY, ...at(e) });
}, { passive: false });
$('ink').oncontextmenu = (e) => tool === 'control' && e.preventDefault();
$('ink').onpointerleave = () => tool === 'pointer' && mark({ t: 'ptr', x: null, y: null });

function erase(p) {
  const id = ink.hit(p.x, p.y);
  if (id) mark({ t: 'erase', id });
}

function startText(e, p) {
  e.preventDefault();
  const input = $('text-input');
  input.value = '';
  input.style.left = $('ink').offsetLeft + e.offsetX + 'px';
  input.style.top = $('ink').offsetTop + e.offsetY - 16 + 'px';
  input.style.color = COLORS[color];
  input.hidden = false;
  input.dataset.x = p.x;
  input.dataset.y = p.y;
  setTimeout(() => input.focus());
}
function commitText() {
  const input = $('text-input');
  if (input.hidden) return;
  input.hidden = true;
  const s = input.value.trim();
  if (s) mark({ t: 'text', id: newId(), c: color, x: +input.dataset.x, y: +input.dataset.y, s });
}
$('text-input').onkeydown = (e) => {
  if (e.key === 'Enter') commitText();
  if (e.key === 'Escape') $('text-input').hidden = true;
};
$('text-input').onblur = commitText;

for (const b of document.querySelectorAll('[data-tool]')) {
  if (b.dataset.tool !== 'control') b.onclick = () => setTool(b.dataset.tool);
}
$('undo').onclick = () => mark({ t: 'undo' });
$('clear').onclick = () => mark({ t: 'clear' });

// --- remote mouse. Teacher asks; the student's desktop app asks the student and does the clicking. ---
$('mouse').onclick = () => {
  if (tool === 'control') {
    setTool(null);
    return sendData({ t: 'control-stop' });
  }
  if (sendData({ t: 'control-request' })) $('mouse').querySelector('span').textContent = 'Ждём ученика…';
};

function onControl({ on, reason }) {
  $('mouse').querySelector('span').textContent = 'Управление';
  if (on) return tool !== 'control' && setTool('control');
  if (tool === 'control') setTool(null);
  const why = {
    noapp: 'Управление работает, только если ученик зашёл через приложение Huddle',
    noshare: 'Сначала ученик должен показать экран',
    denied: 'Ученик отклонил управление',
    revoked: 'Ученик отключил управление',
  }[reason];
  if (why) toast(why);
}

// Student side.
async function answerControl() {
  if (!window.huddle?.requestControl) return sendData({ t: 'control', on: false, reason: 'noapp' });
  if (!screenStream) return sendData({ t: 'control', on: false, reason: 'noshare' });
  const on = await window.huddle.requestControl();
  $('release').hidden = !on;
  sendData({ t: 'control', on, reason: on ? undefined : 'denied' });
}

function releaseControl(tellTeacher) {
  window.huddle?.stopControl?.();
  $('release').hidden = true;
  if (tellTeacher) sendData({ t: 'control', on: false, reason: 'revoked' });
}
$('release').onclick = () => releaseControl(true);
window.huddle?.onControlOff?.(() => { $('release').hidden = true; sendData({ t: 'control', on: false, reason: 'revoked' }); });

// --- chat ---
function addMessage(text, mine, delivered = true) {
  const p = document.createElement('p');
  p.className = mine ? 'me' : '';
  const who = document.createElement('b');
  who.textContent = mine ? 'Вы' : 'Собеседник';
  p.append(who, text + (delivered ? '' : ' (не доставлено)'));
  $('messages').append(p);
  p.scrollIntoView();
  if (!mine && $('chat').hidden) {
    $('unread').hidden = false;
    toast(`Собеседник: ${text}`);
  }
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  addMessage(text, true, sendData({ t: 'chat', text }));
  $('chat-input').value = '';
};
function toggleChat() {
  $('chat').hidden = !$('chat').hidden;
  $('unread').hidden = true;
  if (!$('chat').hidden) $('chat-input').focus();
  fitInk();
}
$('chat-toggle').onclick = toggleChat;
$('chat-close').onclick = toggleChat;

// --- screen share ---
function addScreen() {
  sendData({ t: 'screen', id: screenStream.id });
  screenSenders = screenStream.getTracks().map((t) => pc.addTrack(t, screenStream));
}

function stopShare() {
  screenStream?.getTracks().forEach((t) => t.stop());
  for (const s of screenSenders) pc?.removeTrack(s);
  screenSenders = [];
  screenStream = null;
  sendData({ t: 'screen', id: null });
  window.huddle?.shareEnded();
  $('release').hidden = true;
  $('share').classList.remove('on');
  $('share').querySelector('span').textContent = 'Демонстрация';
  $('sharing').hidden = true;
}

async function toggleShare() {
  if (screenStream) return stopShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 } });
  } catch (e) {
    // In a browser NotAllowedError is usually just "cancelled the picker"; in the app it's a real failure.
    if (window.huddle || e.name !== 'NotAllowedError') alert(`Не удалось показать экран: ${e.message}`);
    return;
  }
  const track = screenStream.getVideoTracks()[0];
  track.contentHint = 'detail'; // keep text sharp rather than smooth motion
  track.onended = stopShare;    // browser's own "Stop sharing" button
  if (pc) addScreen();
  $('share').classList.add('on');
  $('share').querySelector('span').textContent = 'Остановить';
  $('sharing').hidden = false;
}
$('share').onclick = toggleShare;
$('stop-share').onclick = stopShare;

// --- mic / camera ---
function toggle(button, tracks, labels) {
  const label = button.querySelector('span');
  if (!tracks.length) {
    button.disabled = true;
    button.classList.add('off');
    return;
  }
  button.onclick = () => {
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enabled));
    button.classList.toggle('off', !enabled);
    label.textContent = labels[enabled ? 0 : 1];
    sendState();
    render();
  };
}
toggle($('mic'), local.getAudioTracks(), ['Выкл. звук', 'Вкл. звук']);
toggle($('cam'), local.getVideoTracks(), ['Остановить видео', 'Включить видео']);

// --- view: speaker / gallery, self view, fullscreen, leave ---
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

$('leave').onclick = () => {
  if (screenStream) stopShare();
  stop();
  ws.onclose = null;
  ws.close();
  local.getTracks().forEach((t) => t.stop());
  document.body.innerHTML = '<div class="left-screen"><h2>Вы вышли из урока</h2><button onclick="location.reload()">Вернуться</button></div>';
};

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  toast('Ссылка скопирована — отправьте её ученику');
};

render();
