// Pointer + pen strokes in normalized (0..1) coordinates. Used on the teacher's
// canvas over the video and on the student's transparent overlay window.
export function createInk(canvas) {
  const ctx = canvas.getContext('2d');
  const strokes = new Map(); // id -> [[x, y], ...]
  let pointer = null, hideTimer;

  function redraw() {
    const { width: w, height: h } = canvas;
    const dpr = devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#ff2d55';
    ctx.lineWidth = 4 * dpr;
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const pts of strokes.values()) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
      ctx.stroke();
    }
    if (pointer) {
      ctx.beginPath();
      ctx.arc(pointer[0] * w, pointer[1] * h, 10 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 45, 85, 0.85)';
      ctx.fill();
    }
  }

  // ponytail: full redraw per message, O(total points); fine until a lesson piles up thousands of strokes without "clear".
  function apply(m) {
    const num = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    if (m.t === 'ptr') {
      pointer = num(m.x) && num(m.y) ? [m.x, m.y] : null;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { pointer = null; redraw(); }, 3000);
    } else if (m.t === 'line' && num(m.x) && num(m.y)) {
      const id = String(m.id);
      if (!strokes.has(id)) strokes.set(id, []);
      strokes.get(id).push([m.x, m.y]);
    } else if (m.t === 'clear') {
      strokes.clear();
      pointer = null;
    } else {
      return;
    }
    redraw();
  }

  function resize(w, h) {
    canvas.width = Math.round(w * devicePixelRatio);
    canvas.height = Math.round(h * devicePixelRatio);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    redraw();
  }

  return { apply, resize };
}

export const isInk = (m) => m.t === 'ptr' || m.t === 'line' || m.t === 'clear';
