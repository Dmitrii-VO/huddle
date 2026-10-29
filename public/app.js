import { isInk } from '/ink.js';
import { createTools } from '/tools.js';

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
  // Marks: over my real screen if I'm the one sharing (desktop app only), else over the picture I'm watching.
  if (isInk(msg)) return screenStream ? window.huddle?.ink(msg) : ink.apply(msg);
  if (msg.t === 'mouse') return window.huddle?.input(msg);
  if (msg.t === 'control-request') return answerControl();
  if (msg.t === 'control-stop') return releaseControl(false);
  if (msg.t === 'control') return onControl(msg);
  render();
}

// --- annotation + remote control tools (tools.js) ---
const { ink, setTool, fitInk, onControl, answerControl, releaseControl } = createTools({ sendData, toast, isSharing: () => !!screenStream });

// Desktop app while I share: the floating bar's buttons and my own marks.
window.huddle?.onBarAction?.((a) => {
  if (a === 'mic') $('mic').click();
  if (a === 'stop') stopShare();
});
window.huddle?.onInkOut?.((m) => sendData(m));
const reportMic = () => window.huddle?.barState?.({ mic: !!local.getAudioTracks()[0]?.enabled });
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
  for (const s of screenSenders) limitScreen(s);
}

// Retina / 4K screens at full size choke the encoder (seconds of lag). Send at most ~1080p.
async function limitScreen(sender) {
  const { width = 0, height = 0 } = sender.track.getSettings();
  const scale = Math.max(1, width / 1920, height / 1080);
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].scaleResolutionDownBy = scale;
  params.encodings[0].maxBitrate = 2_500_000;
  try { await sender.setParameters(params); } catch (e) { console.warn('setParameters', e); }
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
  // Ask the capturer itself for less, where supported (Safari rejects size limits in getDisplayMedia).
  await track.applyConstraints({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } }).catch(() => {});
  track.onended = stopShare;    // browser's own "Stop sharing" button
  if (pc) addScreen();
  reportMic();
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
    reportMic();
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

// --- connection quality (like Zoom's statistics): path, round trip, incoming fps ---
let netInfo = '';
setInterval(async () => {
  if (pc?.connectionState !== 'connected') return ($('net').hidden = true);
  const stats = await pc.getStats();
  let pair = null, fps = 0;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair ??= r;
    if (r.type === 'inbound-rtp' && r.kind === 'video') fps = Math.max(fps, r.framesPerSecond ?? 0);
  });
  if (!pair) return;
  const rtt = Math.round((pair.currentRoundTripTime ?? 0) * 1000);
  const relay = stats.get(pair.localCandidateId)?.candidateType === 'relay' || stats.get(pair.remoteCandidateId)?.candidateType === 'relay';
  $('net').hidden = false;
  $('net').className = `tb ${rtt < 150 ? 'good' : rtt < 300 ? 'fair' : 'poor'}`;
  $('net').querySelector('span').textContent = `${rtt} мс`;
  netInfo = `${relay ? 'Через сервер' : 'Напрямую'} · задержка сети ${rtt} мс · входящее видео ${Math.round(fps)} к/с`;
}, 2000);
$('net').onclick = () => toast(netInfo);

// In a desktop browser, point to the app (phones can't install it).
$('get-app').hidden = !!window.huddle || /iPhone|iPad|Android/.test(navigator.userAgent);

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  toast('Ссылка скопирована — отправьте её ученику');
};

render();
