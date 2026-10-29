const $ = (id) => document.getElementById(id);
const room = location.pathname.split('/')[2];
const status = (text) => ($('status').textContent = text);

const { iceServers } = await (await fetch('/config')).json();
const local = await getMedia();
$('local').srcObject = local;
$('local').hidden = !local.getVideoTracks().length;

let pc = null, dc = null, polite = false, makingOffer = false, ignoreOffer = false;
let screenStream = null, screenSenders = [];
const remoteStreams = new Map();
let remoteCamId = null, remoteScreenId = null;

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
    status(msg.peer ? 'Соединение…' : 'Ждём собеседника — отправьте ему ссылку');
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
  render();
}

function render() {
  const screen = remoteStreams.get(remoteScreenId) ?? null;
  const cam = remoteStreams.get(remoteCamId) ?? null;
  if ($('screen').srcObject !== screen) $('screen').srcObject = screen;
  if ($('remote').srcObject !== cam) $('remote').srcObject = cam;
  $('screen').hidden = !screen;
  $('stage').classList.toggle('has-screen', !!screen);
}

// --- data channel: stream labels + chat ---
function sendData(msg) {
  if (dc?.readyState !== 'open') return false;
  dc.send(JSON.stringify(msg));
  return true;
}

function onData(msg) {
  if (msg.t === 'cam') remoteCamId = msg.id;
  if (msg.t === 'screen') remoteScreenId = msg.id;
  if (msg.t === 'chat') addMessage(msg.text, false);
  render();
}

function addMessage(text, mine, delivered = true) {
  const p = document.createElement('p');
  p.className = mine ? 'me' : '';
  p.textContent = `${mine ? 'Вы' : 'Собеседник'}: ${text}${delivered ? '' : ' (не доставлено)'}`;
  $('messages').append(p);
  p.scrollIntoView();
  if (!mine) $('chat').hidden = false;
}

$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  addMessage(text, true, sendData({ t: 'chat', text }));
  $('chat-input').value = '';
};

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
  $('share').classList.remove('on');
  $('sharing').hidden = true;
}

$('share').onclick = async () => {
  if (screenStream) return stopShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 } });
  } catch {
    return; // user cancelled the picker
  }
  const track = screenStream.getVideoTracks()[0];
  track.contentHint = 'detail'; // keep text sharp rather than smooth motion
  track.onended = stopShare;    // browser's own "Stop sharing" button
  if (pc) addScreen();
  $('share').classList.add('on');
  $('sharing').hidden = false;
};

// --- buttons ---
function toggle(button, tracks) {
  if (!tracks.length) return (button.disabled = true);
  button.onclick = () => {
    const enabled = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = enabled));
    button.classList.toggle('off', !enabled);
  };
}
toggle($('mic'), local.getAudioTracks());
toggle($('cam'), local.getVideoTracks());

$('chat-toggle').onclick = () => ($('chat').hidden = !$('chat').hidden);
$('copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  $('copy').textContent = 'Скопировано';
  setTimeout(() => ($('copy').textContent = 'Скопировать ссылку'), 1500);
};
