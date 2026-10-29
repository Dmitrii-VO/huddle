// Viewer's tools over the other side's shared screen (annotations, remote control with keyboard)
// and the sharer's answer to a control request.
import { COLORS, createInk } from '/ink.js';

const $ = (id) => document.getElementById(id);

export function createTools({ sendData, toast, isSharing }) {
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

  // --- remote control. The viewer asks; the sharer's desktop app asks its user and does the clicking. ---
  $('mouse').onclick = () => {
    if (tool === 'control') {
      setTool(null);
      return sendData({ t: 'control-stop' });
    }
    if (sendData({ t: 'control-request' })) $('mouse').querySelector('span').textContent = 'Ждём ответа…';
  };

  function onControl({ on, reason }) {
    $('mouse').querySelector('span').textContent = 'Управление';
    if (on) {
      document.activeElement?.blur(); // keys are for the other computer now, not for our buttons
      return tool !== 'control' && setTool('control');
    }
    if (tool === 'control') setTool(null);
    const why = {
      noapp: 'Управление работает, только если собеседник зашёл через приложение Huddle',
      noshare: 'Сначала собеседник должен начать демонстрацию',
      denied: 'Собеседник отклонил управление',
      revoked: 'Собеседник отключил управление',
    }[reason];
    if (why) toast(why);
  }

  // The side that shares the screen.
  async function answerControl() {
    if (!window.huddle?.requestControl) return sendData({ t: 'control', on: false, reason: 'noapp' });
    if (!isSharing()) return sendData({ t: 'control', on: false, reason: 'noshare' });
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

  // Keyboard goes to the other computer while controlling it (arrows / space flip slides, letters type).
  const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Delete', 'Enter', 'Backspace', 'Tab', 'Escape', ' ']);
  addEventListener('keydown', (e) => {
    if (tool !== 'control' || e.target.closest('input, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // ponytail: no shortcuts (Ctrl+C, Cmd+Tab…) yet
    if (KEYS.has(e.key)) sendData({ t: 'mouse', a: 'key', k: e.key });
    else if ([...e.key].length === 1) sendData({ t: 'mouse', a: 'type', s: e.key });
    else return;
    e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    if (tool !== 'control' || !KEYS.has(e.key) || e.target.closest('input, textarea')) return;
    e.preventDefault(); // Space on a focused button would "click" it on keyup
    sendData({ t: 'mouse', a: 'keyup', k: e.key });
  });

  return { ink, setTool, fitInk, onControl, answerControl, releaseControl };
}
