// Video codec and screen-share quality.
// Auto: pick the codec this computer encodes in hardware, start sharp, and let a watchdog step quality
// down while the encoder is CPU-bound (and back up when it recovers). Manual: fixed presets.

export const PRESETS = {
  sharp: { w: 1920, fps: 15, hint: 'text' },   // slides, documents
  smooth: { w: 1280, fps: 30, hint: 'motion' }, // video, animations
  eco: { w: 1280, fps: 8, hint: 'text' },       // weak computer or network
};
// Auto mode ladder, best first.
const STEPS = [{ w: 1920, fps: 15 }, { w: 1280, fps: 15 }, { w: 1280, fps: 10 }, { w: 960, fps: 8 }];
export const CODECS = ['AV1', 'VP9', 'H264', 'VP8'];

// What this computer can encode, and whether in hardware ("powerEfficient").
export async function probeCodecs() {
  const have = new Set((RTCRtpSender.getCapabilities?.('video')?.codecs ?? []).map((c) => c.mimeType.split('/')[1].toUpperCase()));
  const caps = {};
  for (const name of CODECS) {
    if (!have.has(name)) continue;
    let info = { supported: true, smooth: true, powerEfficient: false }; // Safari < 17 has no 'webrtc' query
    try {
      info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: `video/${name}`, width: 1920, height: 1080, bitrate: 2_500_000, framerate: 15 },
      });
    } catch {}
    if (info.supported) caps[name] = { hw: !!info.powerEfficient, smooth: !!info.smooth };
  }
  return caps;
}

// AV1 only with a hardware encoder (best for text, too heavy in software); else hardware H.264; else VP8.
export function autoCodec(caps) {
  if (caps.AV1?.hw && caps.AV1.smooth) return 'AV1';
  if (caps.H264?.hw) return 'H264';
  if (caps.VP8) return 'VP8';
  return Object.keys(caps)[0] ?? null;
}

// Put the codec first for every video transceiver; takes effect on the next negotiation.
export function preferCodec(pc, name) {
  const all = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!pc || !name || !all) return;
  const isIt = (c) => c.mimeType.toUpperCase() === `VIDEO/${name}`;
  const order = [...all.filter(isIt), ...all.filter((c) => !isIt(c))];
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track?.kind !== 'video' || t.currentDirection === 'stopped') continue;
    try { t.setCodecPreferences?.(order); } catch {}
  }
}

// Size / frame rate / content hint for the screen sender. Retina and 4K captures are scaled down here.
export async function applyScreen(sender, { w, fps, hint }) {
  const track = sender?.track;
  if (!track) return;
  if (hint) track.contentHint = hint;
  // changing capture fps restarts the capturer (seconds of black): only when it actually differs
  if (Math.round(track.getSettings().frameRate ?? fps) !== fps) await track.applyConstraints({ frameRate: { max: fps } }).catch(() => {});
  const { width = 0, height = 0 } = track.getSettings();
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  Object.assign(params.encodings[0], {
    scaleResolutionDownBy: Math.max(1, width / w, height / Math.round((w * 9) / 16)),
    maxFramerate: fps,
    maxBitrate: 2_500_000,
  });
  // keep text sharp (drop frames) unless motion matters more
  params.degradationPreference = hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  try {
    await sender.setParameters(params);
  } catch {
    delete params.degradationPreference; // not supported everywhere
    await sender.setParameters(params).catch((e) => console.warn('setParameters', e));
  }
}

// Every 4 s: is the encoder keeping up? Two bad checks in a row -> one step down; ~30 s of headroom -> one step up.
// At the bottom step with a heavy codec (AV1/VP9) it asks to switch to a lighter one.
export function watchScreen({ getSender, getCodec, onStep, onCodecTooHeavy }) {
  let level = 0, bad = 0, good = 0, prev = null;
  setInterval(async () => {
    const sender = getSender();
    if (!sender) return void ((level = bad = good = 0), (prev = null));
    let r = null;
    (await sender.getStats()).forEach((s) => { if (s.type === 'outbound-rtp') r = s; });
    if (!r?.framesEncoded) return;
    const frames = r.framesEncoded - (prev?.framesEncoded ?? 0);
    const encMs = frames > 0 ? ((r.totalEncodeTime - (prev?.totalEncodeTime ?? 0)) / frames) * 1000 : 0;
    prev = r;
    const budget = 1000 / STEPS[level].fps;
    const cpu = r.qualityLimitationReason === 'cpu' || encMs > budget * 0.7;

    if (cpu) { bad++; good = 0; } else if (encMs < budget * 0.3) { good++; bad = 0; } else { bad = good = 0; }
    if (bad >= 2 && level < STEPS.length - 1) {
      level++;
      bad = 0;
      onStep(STEPS[level], { level, encMs: Math.round(encMs), reason: r.qualityLimitationReason });
    } else if (bad >= 2 && ['AV1', 'VP9'].includes(getCodec())) {
      bad = 0;
      onCodecTooHeavy();
    } else if (good >= 8 && level > 0) {
      level--;
      good = 0;
      onStep(STEPS[level], { level, encMs: Math.round(encMs), reason: 'recovered' });
    }
  }, 4000);
}

export const autoStart = () => STEPS[0];
