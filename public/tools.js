// Viewer's tools over the other side's shared screen: annotations, and taps that the sharer's desktop app
// clicks into their PowerPoint slide show once the sharer allows it.
import { COLORS, createInk } from '/ink.js';

const $ = (id) => document.getElementById(id);

export function createTools({ sendData, toast }) {
  const ink = createInk($('ink'));
  let tool = null, color = 0, current = null; // current: id + start point of the stroke/arrow being drawn
  let clicks = false; // the sharer lets my taps through (only when no tool is picked)

  function setTool(name) {
    tool = tool === name ? null : name;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    $('ink').className = tool ? `active tool-${tool}` : clicks ? 'clicks' : '';
    $('text-input').hidden = true;
  }

  function setClicks(on) {
    if (clicks === on) return;
    clicks = on;
    if (!tool) setTool(null);
    toast(on ? 'Можно нажимать на картинки в презентации' : 'Нажимать на презентацию больше нельзя');
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
  const newId = () => Math.random().toString(36).slice(2);

  $('ink').onpointerdown = (e) => {
    const p = at(e);
    if (!tool) {
      // tap right away (not on release) and show it at once: the slide answers only after a video round trip
      if (clicks && e.button === 0 && sendData({ t: 'click', ...p })) ink.apply({ t: 'ptr', ...p });
      return;
    }
    if (tool === 'text') return startText(e, p);
    $('ink').setPointerCapture(e.pointerId);
    if (tool === 'eraser') return erase(p);
    current = { id: newId(), ...p };
    if (tool === 'pen') mark({ t: 'line', id: current.id, c: color, ...p });
  };
  $('ink').onpointermove = (e) => {
    const p = at(e);
    if (tool === 'pointer') mark({ t: 'ptr', ...p });
    if (tool === 'eraser' && e.buttons) erase(p);
    if (!current) return;
    if (tool === 'pen') mark({ t: 'line', id: current.id, c: color, ...p });
    if (tool === 'arrow') mark({ t: 'arrow', id: current.id, c: color, x1: current.x, y1: current.y, x2: p.x, y2: p.y });
  };
  $('ink').onpointerup = () => (current = null);
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

  for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('undo').onclick = () => mark({ t: 'undo' });
  $('clear').onclick = () => mark({ t: 'clear' });

  return { ink, setTool, fitInk, setClicks };
}
