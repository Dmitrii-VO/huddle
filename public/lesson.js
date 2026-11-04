// A presentation opened in Huddle itself (desktop app builds it from a PPTX, app/lesson.js): the slide picture,
// its answer layers, and the click triggers that show / hide them — like PowerPoint's trigger animations.
// The teacher's side sends the whole lesson to the child once, then only the state: which slide, what is shown.
// The teacher turns the slides; both may tap. Everything goes over its own data channel, so the state always
// arrives after the files, and the call's own channel never waits behind megabytes of pictures.
const $ = (id) => document.getElementById(id);
const CHUNK = 64 * 1024;

export function createLesson({ onChange, toast, log }) {
  let L = null, id = null, mine = false, files = null, urls = {}, n = 0, shown = new Set(), steps = new Map();
  let fc = null, sending = 0, got = null; // got: the lesson being received
  const slide = $('lesson').querySelector('.slide');

  // files: { 'lesson.json': bytes, 's1.jpg': bytes, ... }; mine: I opened it (the teacher), so I turn the slides
  function open(lessonId, lessonFiles, own) {
    close(false);
    L = JSON.parse(new TextDecoder().decode(lessonFiles['lesson.json']));
    [id, files, mine] = [lessonId, lessonFiles, own];
    for (const [name, bytes] of Object.entries(files)) {
      if (name !== 'lesson.json') urls[name] = URL.createObjectURL(new Blob([bytes], { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
    }
    slide.style.setProperty('--ar', L.w / L.h);
    $('lesson').classList.toggle('remote', !mine);
    $('lesson').hidden = false;
    show(0);
    onChange();
  }

  function close(tell = true) {
    if (!L) return;
    if (tell && mine) { sending++; post({ t: 'lesson', id: null }); }
    Object.values(urls).forEach(URL.revokeObjectURL);
    [L, id, files, urls] = [null, null, null, {}];
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
    n = Math.max(0, Math.min(L.slides.length - 1, i));
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
  const turn = (i) => { show(i); post(state()); };

  // Each click on a trigger runs its next step; after the last one it starts again from the first.
  function tap(trigger) {
    const t = L.slides[n].triggers.find((t) => t.id === trigger);
    if (!t) return;
    const k = steps.get(trigger) ?? 0;
    for (const [target, on] of t.steps[k % t.steps.length]) on ? shown.add(target) : shown.delete(target);
    steps.set(trigger, k + 1);
    paint();
    post(state());
  }

  // The whole state, not the tap: two taps crossing on the wire can't leave the sides different for long.
  const state = () => ({ t: 'lesson', id, slide: n, shown: [...shown], steps: [...steps] });
  // Only the teacher turns slides: on the teacher's side a state for another slide is a stale tap, dropped.
  function apply(m) {
    if (m.id !== id || !L || !Number.isInteger(m.slide) || !Array.isArray(m.shown) || !Array.isArray(m.steps)) return;
    if (m.slide !== n) { if (mine) return; show(m.slide); }
    const s = L.slides[n], layers = new Set(s.layers.map((l) => l.id)), triggers = new Set(s.triggers.map((t) => t.id));
    shown = new Set(m.shown.filter((x) => layers.has(x)));
    steps = new Map(m.steps.filter((e) => Array.isArray(e) && triggers.has(e[0]) && Number.isInteger(e[1])));
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

  $('lesson-prev').onclick = () => turn(n - 1);
  $('lesson-next').onclick = () => turn(n + 1);
  $('lesson-close').onclick = () => close();
  // Presentation clickers send PageDown / PageUp. The child's side never turns slides.
  addEventListener('keydown', (e) => {
    if (!L || !mine || e.target.closest?.('input, textarea, select')) return;
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) turn(n + 1);
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) turn(n - 1);
    else return;
    e.preventDefault();
  });

  // "Презентация" (desktop app only): it builds the lesson from a PPTX, progress comes as toasts.
  $('lesson-open').hidden = !window.huddle?.openLesson;
  $('lesson-open').onclick = async () => {
    const lesson = await window.huddle.openLesson();
    if (!lesson) return;
    open(lesson.id, lesson.files, true);
    sendFiles();
  };
  window.huddle?.onLessonProgress?.(toast);

  // --- the wire ---
  const post = (m) => fc?.readyState === 'open' && (fc.send(JSON.stringify(m)), true);

  // Each file: a JSON header, then its bytes in chunks; then the current state.
  async function sendFiles() {
    if (fc?.readyState !== 'open' || !mine) return;
    const token = ++sending, t0 = Date.now(), list = Object.entries(files);
    const drained = () => new Promise((r) => fc.addEventListener('bufferedamountlow', r, { once: true }));
    let bytes = 0;
    for (const [name, data] of list) {
      if (!post({ t: 'lesson-file', id, name, size: data.length, count: list.length })) return;
      for (let off = 0; off < data.length; off += CHUNK) {
        if (fc.bufferedAmount > 1 << 20) await drained();
        if (token !== sending || fc?.readyState !== 'open') return; // another lesson, closed, or the call ended
        fc.send(data.subarray(off, off + CHUNK));
      }
      bytes += data.length;
    }
    post(state());
    log({ ev: 'lesson-sent', mb: +(bytes / 1e6).toFixed(1), s: Math.round((Date.now() - t0) / 1000) });
  }

  function receive(data) {
    if (typeof data !== 'string') {
      const f = got?.file;
      if (!f) return;
      f.buf.set(new Uint8Array(data), f.at);
      f.at += data.byteLength;
      if (f.at < f.buf.length) return;
      got.files[f.name] = f.buf;
      got.file = null;
      const done = Object.keys(got.files).length;
      const pctDone = Math.floor((done / got.count) * 10);
      if (pctDone > got.shown) { got.shown = pctDone; toast(`Загружается презентация… ${pctDone * 10}%`); }
      if (done < got.count) return;
      log({ ev: 'lesson-got', s: Math.round((Date.now() - got.t0) / 1000) });
      open(got.id, got.files, false);
      post({ t: 'lesson-ready', id: got.id });
      got = null;
      return;
    }
    const m = JSON.parse(data);
    if (m.t === 'lesson-file') {
      if (mine || !(m.size >= 0 && m.count > 0)) return; // lessons go teacher → child only
      if (got?.id !== m.id) got = { id: m.id, count: m.count, files: {}, shown: 0, t0: Date.now() };
      got.file = { name: m.name, buf: new Uint8Array(m.size), at: 0 };
      if (!m.size) receive(new ArrayBuffer(0));
    } else if (m.t === 'lesson-ready' && m.id === id) toast('Ученик получил презентацию');
    else if (m.t === 'lesson' && m.id === null) { got = null; if (!mine) close(false); }
    else if (m.t === 'lesson') apply(m);
  }

  // The call's peer connection: a new one (the other side joined) gets the lesson again.
  function attach(pc) {
    fc = pc.createDataChannel('lesson', { negotiated: true, id: 1 });
    fc.binaryType = 'arraybuffer';
    fc.bufferedAmountLowThreshold = 256 * 1024;
    fc.onopen = sendFiles;
    fc.onmessage = (e) => receive(e.data);
  }
  // The other side left: the teacher keeps the lesson, the child's goes away with the teacher.
  function detach() {
    fc = got = null;
    sending++;
    if (L && !mine) close(false);
  }

  return { attach, detach, isOpen: () => !!L };
}
