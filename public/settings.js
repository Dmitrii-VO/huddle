// Settings window: camera / microphone, screen-share quality, codec, low latency. Saved per computer.
const $ = (id) => document.getElementById(id);
const KEY = 'huddle.settings';
const DEFAULTS = { cam: '', mic: '', quality: 'auto', codec: 'auto', lowLatency: true };

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { ...DEFAULTS }; }
}
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

const CODEC_NAMES = { AV1: 'AV1', VP9: 'VP9', H264: 'H.264', VP8: 'VP8' };

// onChange(key, value) applies the change to the call; describe() returns the current state line.
export function initSettings({ settings, caps, autoCodec, onChange, describe }) {
  const option = (value, text, selected, disabled = false) => Object.assign(document.createElement('option'), { value, textContent: text, selected, disabled });

  async function fillDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    for (const [select, kind, key] of [[$('set-cam'), 'videoinput', 'cam'], [$('set-mic'), 'audioinput', 'mic']]) {
      const list = devices.filter((d) => d.kind === kind);
      select.replaceChildren(...(list.length
        ? list.map((d, i) => option(d.deviceId, d.label || `Устройство ${i + 1}`, d.deviceId === settings[key]))
        : [option('', 'Не найдено', true, true)]));
    }
  }

  function fillCodecs() {
    $('set-codec').replaceChildren(
      option('auto', `Автоматически (${CODEC_NAMES[autoCodec] ?? '—'})`, settings.codec === 'auto'),
      ...Object.keys(CODEC_NAMES).map((name) => option(
        name,
        `${CODEC_NAMES[name]}${caps[name]?.hw ? ' — аппаратно' : caps[name] ? '' : ' — не поддерживается'}`,
        settings.codec === name,
        !caps[name],
      )),
    );
  }

  const set = (key, value) => {
    settings[key] = value;
    save(settings);
    onChange(key, value);
    $('set-now').textContent = describe();
  };

  $('set-cam').onchange = (e) => set('cam', e.target.value);
  $('set-mic').onchange = (e) => set('mic', e.target.value);
  $('set-codec').onchange = (e) => set('codec', e.target.value);
  $('set-lowlat').onchange = (e) => set('lowLatency', e.target.checked);
  for (const r of document.querySelectorAll('[name="set-quality"]')) {
    r.checked = r.value === settings.quality;
    r.onchange = () => set('quality', r.value);
  }
  $('set-lowlat').checked = settings.lowLatency;

  $('settings-open').onclick = async () => {
    await fillDevices();
    fillCodecs();
    $('set-now').textContent = describe();
    $('settings').hidden = false;
  };
  const close = () => ($('settings').hidden = true);
  $('settings-close').onclick = close;
  $('settings').onclick = (e) => {
    if (e.target === $('settings')) close(); // click on the dim backdrop; no return value: `false` would cancel radio clicks
  };
  addEventListener('keydown', (e) => e.key === 'Escape' && close());
}
