import { isInk } from '/ink.js';
import { createTools } from '/tools.js';
import { startDiag } from '/diag.js';
import { PRESETS, applyScreen, autoCodec, autoStart, preferCodec, probeCodecs, watchScreen } from '/quality.js';
import { initSettings, loadSettings } from '/settings.js';

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

const settings = loadSettings();
const { iceServers } = await (await fetch('/config')).json();
const local = await getMedia();
const caps = await probeCodecs();
let codec = settings.codec === 'auto' ? autoCodec(caps) : settings.codec;
let autoStep = autoStart(); // auto-quality ladder position, moved by the watchdog
$('local').srcObject = local;

let pc = null, dc = null, polite = false, makingOffer = false, ignoreOffer = false;
let screenStream = null, screenSenders = [];
const remoteStreams = new Map();
let remoteCamId = null, remoteScreenId = null, remoteState = { mic: true, cam: true };

// Camera may be missing or denied: fall back to audio, then to nothing. Saved devices are preferred, not required.
async function getMedia() {
  const pick = (id) => (id ? { deviceId: { ideal: id } } : true);
  for (const c of [{ video: pick(settings.cam), audio: pick(settings.mic) }, { audio: pick(settings.mic) }]) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch {}
  }
  return new MediaStream();
}

// --- signaling ---
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?room=${room}`);
const send = (msg) => ws.send(JSON.stringify(msg));
// One line per event in the server journal; never lesson content.
const log = (data) => ws.readyState === 1 && send({ type: 'log', ...data });
ws.onopen = async () => {
  log({ ev: 'join', ua: navigator.userAgent, app: window.huddle?.version ?? null });
  log({ ev: 'codecs', caps, chosen: codec, settings: { quality: settings.quality, codec: settings.codec, lowLatency: settings.lowLatency } });
  for (const m of (await window.huddle?.appLogs?.()) ?? []) log({ ev: 'app', ...m });
};
window.huddle?.onAppLog?.((m) => log({ ev: 'app', ...m }));
addEventListener('error', (e) => log({ ev: 'error', msg: String(e.message), at: `${e.filename}:${e.lineno}` }));
addEventListener('unhandledrejection', (e) => log({ ev: 'error', msg: String(e.reason?.message ?? e.reason) }));

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
  preferCodec(pc, codec); // before the first offer goes out
  if (screenStream) addScreen();

  dc = pc.createDataChannel('data', { negotiated: true, id: 0 });
  dc.onmessage = (e) => onData(JSON.parse(e.data));
  dc.onopen = () => {
    sendData({ t: 'cam', id: local.id });
    sendState();
    if (screenStream) sendData({ t: 'screen', id: screenStream.id });
  };

  pc.onnegotiationneeded = negotiate;
  pc.onicecandidate = ({ candidate }) => candidate && send({ candidate });
  pc.ontrack = ({ receiver, streams: [stream] }) => {
    setLatency(receiver);
    remoteStreams.set(stream.id, stream);
    stream.onremovetrack = () => {
      if (!stream.getTracks().length) remoteStreams.delete(stream.id);
      render();
    };
    render();
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log({ ev: 'conn', state: s });
    if (s === 'failed') pc.restartIce();
    status({ connecting: 'Соединение…', connected: 'На связи', disconnected: 'Связь прерывается…', failed: 'Переподключение…' }[s] ?? $('status').textContent);
  };
}

async function negotiate() {
  try {
    makingOffer = true;
    await pc.setLocalDescription();
    send({ description: pc.localDescription });
  } catch (e) {
    console.error(e);
  } finally {
    makingOffer = false;
  }
}

// Video only: a near-empty jitter buffer cuts ~50-200 ms; audio keeps its default to avoid crackle.
function setLatency(receiver) {
  if (receiver.track.kind !== 'video' || !('jitterBufferTarget' in receiver)) return;
  try { receiver.jitterBufferTarget = settings.lowLatency ? 0 : null; } catch {}
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
  if (msg.t.startsWith('control')) log({ ev: 'control', got: msg });
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
  preferCodec(pc, codec);
  applyScreen(screenVideo(), screenPreset());
}

// --- screen quality: preset or auto ladder (quality.js) ---
const screenVideo = () => screenSenders.find((s) => s.track?.kind === 'video');
const screenPreset = () => (settings.quality === 'auto' ? { ...autoStep, hint: 'text' } : PRESETS[settings.quality]);
watchScreen({
  getSender: () => (settings.quality === 'auto' ? screenVideo() : null),
  getCodec: () => codec,
  onStep: (step, why) => {
    autoStep = step;
    applyScreen(screenVideo(), screenPreset());
    log({ ev: 'quality', ...step, ...why });
  },
  onCodecTooHeavy: () => {
    const from = codec;
    codec = caps.H264 ? 'H264' : 'VP8';
    preferCodec(pc, codec);
    if (pc) negotiate();
    log({ ev: 'codec-fallback', from, to: codec });
  },
});

initSettings({
  settings,
  caps,
  autoCodec: autoCodec(caps),
  describe: () => `Сейчас: кодек ${codec ?? '—'}` + (screenStream ? `, демонстрация до ${screenPreset().w}px, ${screenPreset().fps} к/с` : ''),
  onChange: (key, value) => {
    log({ ev: 'setting', key, value });
    if (key === 'cam' || key === 'mic') return switchDevice(key === 'cam' ? 'video' : 'audio', value);
    if (key === 'quality') return screenStream && applyScreen(screenVideo(), screenPreset());
    if (key === 'lowLatency') return pc?.getReceivers().forEach(setLatency);
    if (key === 'codec') {
      codec = value === 'auto' ? autoCodec(caps) : value;
      preferCodec(pc, codec);
      if (pc) negotiate();
    }
  },
});

// Swap camera / microphone mid-call without renegotiating (replaceTrack).
async function switchDevice(kind, deviceId) {
  let track;
  try {
    [track] = (await navigator.mediaDevices.getUserMedia({ [kind]: { deviceId: { exact: deviceId } } })).getTracks();
  } catch (e) {
    return toast(`Не удалось включить устройство: ${e.message}`);
  }
  const old = kind === 'video' ? local.getVideoTracks()[0] : local.getAudioTracks()[0];
  const sender = old && pc?.getSenders().find((s) => s.track === old);
  if (old) {
    track.enabled = old.enabled;
    local.removeTrack(old);
    old.stop();
  }
  local.addTrack(track);
  if (sender) await sender.replaceTrack(track);
  else if (pc) pc.addTrack(track, local);
  $(kind === 'video' ? 'cam' : 'mic').disabled = false;
  $(kind === 'video' ? 'cam' : 'mic').classList.toggle('off', !track.enabled);
  $('local').srcObject = local;
  render();
}

function stopShare() {
  screenStream?.getTracks().forEach((t) => t.stop());
  for (const s of screenSenders) pc?.removeTrack(s);
  screenSenders = [];
  screenStream = null;
  sendData({ t: 'screen', id: null });
  log({ ev: 'share', on: false });
  window.huddle?.shareEnded();
  $('release').hidden = true;
  $('share').classList.remove('on');
  $('share').querySelector('span').textContent = 'Демонстрация';
  $('sharing').hidden = true;
}

async function toggleShare() {
  if (screenStream) return stopShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: screenPreset().fps } });
  } catch (e) {
    // In a browser NotAllowedError is usually just "cancelled the picker"; in the app it's a real failure.
    log({ ev: 'share-error', name: e.name, msg: e.message });
    if (window.huddle || e.name !== 'NotAllowedError') alert(`Не удалось показать экран: ${e.message}`);
    return;
  }
  const track = screenStream.getVideoTracks()[0];
  track.contentHint = 'detail'; // keep text sharp rather than smooth motion
  log({ ev: 'share', on: true, ...track.getSettings() });
  // Ask the capturer itself for less, where supported (Safari rejects size limits in getDisplayMedia).
  await track.applyConstraints({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: screenPreset().fps } }).catch(() => {}); // one call: each one restarts the capturer
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
function toggle(button, getTracks, labels) {
  const label = button.querySelector('span');
  if (!getTracks().length) {
    button.disabled = true; // a device chosen in settings re-enables it
    button.classList.add('off');
  }
  button.onclick = () => {
    const tracks = getTracks();
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enabled));
    button.classList.toggle('off', !enabled);
    label.textContent = labels[enabled ? 0 : 1];
    sendState();
    reportMic();
    render();
  };
}
toggle($('mic'), () => local.getAudioTracks(), ['Выкл. звук', 'Вкл. звук']);
toggle($('cam'), () => local.getVideoTracks(), ['Остановить видео', 'Включить видео']);

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

// --- diagnostics: 'Связь' indicator + stats/events in the server log (diag.js) ---
startDiag({ getPc: () => pc, log, toast });

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

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  toast('Ссылка скопирована — отправьте её ученику');
};

render();
