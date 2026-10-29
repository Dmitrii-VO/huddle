// Teacher's annotations in normalized (0..1) coordinates. Used on the teacher's
// canvas over the video and on the student's transparent overlay window.
export const COLORS = ['#ff2d55', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111'];
const TYPES = new Set(['ptr', 'line', 'arrow', 'text', 'erase', 'undo', 'clear']);
export const isInk = (m) => TYPES.has(m.t);

const num = (v) => typeof v === 'number' && v >= 0 && v <= 1;

export function createInk(canvas) {
  const ctx = canvas.getContext('2d');
  const items = new Map(); // id -> { k: 'line'|'arrow'|'text', c, ... }; insertion order = z-order
  let pointer = null, hideTimer;

  function redraw() {
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = Math.max(2, h / 270);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const it of items.values()) {
      ctx.strokeStyle = ctx.fillStyle = it.c;
      if (it.k === 'line') {
        ctx.beginPath();
        it.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
        ctx.stroke();
      } else if (it.k === 'arrow') {
        const [x1, y1, x2, y2] = [it.a[0] * w, it.a[1] * h, it.a[2] * w, it.a[3] * h];
        const ang = Math.atan2(y2 - y1, x2 - x1), head = ctx.lineWidth * 4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.moveTo(x2 - head * Math.cos(ang - 0.5), y2 - head * Math.sin(ang - 0.5));
        ctx.lineTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang + 0.5), y2 - head * Math.sin(ang + 0.5));
        ctx.stroke();
      } else if (it.k === 'text') {
        ctx.font = `600 ${Math.round(h * 0.035)}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(it.s, it.x * w, it.y * h);
      }
    }
    if (pointer) {
      ctx.beginPath();
      ctx.arc(pointer[0] * w, pointer[1] * h, h / 100, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255, 45, 85, 0.85)';
      ctx.fill();
    }
  }

  // ponytail: full redraw per message, O(total points); fine until a lesson piles up thousands of strokes without "clear".
  function apply(m) {
    const id = String(m.id).slice(0, 40);
    const c = COLORS[m.c] ?? COLORS[0];
    if (m.t === 'ptr') {
      pointer = num(m.x) && num(m.y) ? [m.x, m.y] : null;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { pointer = null; redraw(); }, 3000);
    } else if (m.t === 'line' && num(m.x) && num(m.y)) {
      if (!items.has(id)) items.set(id, { k: 'line', c, pts: [] });
      items.get(id).pts.push([m.x, m.y]);
    } else if (m.t === 'arrow' && [m.x1, m.y1, m.x2, m.y2].every(num)) {
      items.set(id, { k: 'arrow', c, a: [m.x1, m.y1, m.x2, m.y2] });
    } else if (m.t === 'text' && num(m.x) && num(m.y) && m.s) {
      items.set(id, { k: 'text', c, x: m.x, y: m.y, s: String(m.s).slice(0, 200) });
    } else if (m.t === 'erase') {
      items.delete(id);
    } else if (m.t === 'undo') {
      items.delete([...items.keys()].pop());
    } else if (m.t === 'clear') {
      items.clear();
      pointer = null;
    } else {
      return;
    }
    redraw();
  }

  // Topmost item near a point, for the eraser. Distances in canvas pixels.
  function hit(x, y) {
    const { width: w, height: h } = canvas, px = x * w, py = y * h, tol = h * 0.02;
    const near = (ax, ay, bx, by) => {
      ax *= w; ay *= h; bx *= w; by *= h;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      return Math.hypot(px - ax - t * dx, py - ay - t * dy) < tol;
    };
    for (const [id, it] of [...items].reverse()) {
      if (it.k === 'line' && it.pts.some((p, i) => near(...p, ...(it.pts[i + 1] ?? p)))) return id;
      if (it.k === 'arrow' && near(...it.a)) return id;
      if (it.k === 'text') {
        ctx.font = `600 ${Math.round(h * 0.035)}px system-ui, sans-serif`;
        const tw = ctx.measureText(it.s).width, th = h * 0.035;
        if (px >= it.x * w && px <= it.x * w + tw && Math.abs(py - it.y * h) < th / 2 + tol) return id;
      }
    }
    return null;
  }

  function resize(w, h) {
    canvas.width = Math.round(w * devicePixelRatio);
    canvas.height = Math.round(h * devicePixelRatio);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    redraw();
  }

  return { apply, resize, hit };
}
