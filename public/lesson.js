// A presentation opened in Huddle itself (desktop app builds it from a PPTX, app/lesson.js): the slide picture,
// its answer layers, and the click triggers that show / hide them — like PowerPoint's trigger animations.
const $ = (id) => document.getElementById(id);

export function createLesson({ onChange, toast }) {
  let L = null, urls = {}, n = 0, shown = new Set(), steps = new Map();
  const slide = $('lesson').querySelector('.slide');

  function open(files) {
    close();
    L = JSON.parse(new TextDecoder().decode(files['lesson.json']));
    for (const [name, bytes] of Object.entries(files)) {
      if (name !== 'lesson.json') urls[name] = URL.createObjectURL(new Blob([bytes], { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
    }
    slide.style.setProperty('--ar', L.w / L.h);
    $('lesson').hidden = false;
    show(0);
    onChange();
  }

  function close() {
    if (!L) return;
    Object.values(urls).forEach(URL.revokeObjectURL);
    urls = {};
    L = null;
    slide.replaceChildren();
    $('lesson').hidden = true;
    onChange();
  }

  const pct = (v, of) => `${(v / of) * 100}%`;
  function img(name, box) {
    const el = new Image();
    el.src = urls[name];
    el.draggable = false;
    if (box) Object.assign(el.style, { left: pct(box.x, L.w), top: pct(box.y, L.h), width: pct(box.w, L.w), height: pct(box.h, L.h) });
    return el;
  }

  // Like PowerPoint, a slide starts over each time it is shown.
  function show(i) {
    if (!L) return;
    n =Math.max(0, Math.min(L.slides.length - 1, i));
    const s = L.slides[n];
    shown = new Set(s.layers.filter((l) => l.show).map((l) => l.id));
    steps.clear();
    slide.replaceChildren(img(s.img), ...s.layers.filter((l) => l.img).map((l) => {
      const el = img(l.img, l);
      el.dataset.id = l.id;
      return el;
    }));
    paint();
    $('lesson-page').textContent = `${n + 1} / ${L.slides.length}`;
  }
  const paint = () => slide.querySelectorAll('[data-id]').forEach((el) => (el.hidden = !shown.has(el.dataset.id)));

  // Each click on a trigger runs its next step; after the last one it starts again from the first.
  function tap(id) {
    const t = L.slides[n].triggers.find((t) => t.id === id);
    if (!t) return;
    const k = steps.get(id) ?? 0;
    for (const [target, on] of t.steps[k % t.steps.length]) on ? shown.add(target) : shown.delete(target);
    steps.set(id, k + 1);
    paint();
  }

  // ponytail: a static shape covering a trigger doesn't block it (PowerPoint would); add if a lesson relies on that
  function triggerAt(e) {
    const r = slide.getBoundingClientRect(), s = L.slides[n];
    const x = ((e.clientX - r.left) / r.width) * L.w, y = ((e.clientY - r.top) / r.height) * L.h;
    const layer = new Set(s.layers.map((l) => l.id));
    return s.triggers
      .filter((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h && (!layer.has(t.id) || shown.has(t.id)))
      .sort((a, b) => b.z - a.z)[0];
  }
  slide.onpointerdown = (e) => { const t = L && triggerAt(e); if (t) tap(t.id); };
  slide.onpointermove = (e) => (slide.style.cursor = L && triggerAt(e) ? 'pointer' : '');

  $('lesson-prev').onclick = () => show(n - 1);
  $('lesson-next').onclick = () => show(n + 1);
  $('lesson-close').onclick = close;
  // Presentation clickers send PageDown / PageUp.
  addEventListener('keydown', (e) => {
    if (!L || e.target.closest?.('input, textarea, select')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) show(n + 1);
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) show(n - 1);
    else return;
    e.preventDefault();
  });

  // "Презентация" (desktop app only): it builds the lesson from a PPTX, progress comes as toasts.
  $('lesson-open').hidden = !window.huddle?.openLesson;
  $('lesson-open').onclick = async () => {
    const files = await window.huddle.openLesson();
    if (files) open(files);
  };
  window.huddle?.onLessonProgress?.(toast);

  return { open, close, isOpen: () => !!L };
}
