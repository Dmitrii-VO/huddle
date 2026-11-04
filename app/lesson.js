// PPTX → Huddle lesson: each slide's static picture plus every click-animated shape as its own transparent layer,
// and the click triggers that show / hide those layers. Rendering is ONLYOFFICE's converter (x2t), so the teacher
// needs ONLYOFFICE Desktop Editors installed. Only appear / disappear is kept: any other effect becomes a plain appear.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');

const isMac = process.platform === 'darwin';
const X2T = isMac ? '/Applications/ONLYOFFICE.app/Contents/Resources/converter/x2t'
  : path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ONLYOFFICE', 'DesktopEditors', 'converter', 'x2t.exe');
// The font list the desktop editors build on first run; without it x2t fails with "error code=open".
const FONTS = isMac ? path.join(os.homedir(), 'Library/Containers/asc.onlyoffice.ONLYOFFICE/Data/Library/Application Support/asc.onlyoffice.ONLYOFFICE/data/fonts/AllFonts.js')
  : path.join(process.env.LOCALAPPDATA || '', 'ONLYOFFICE', 'DesktopEditors', 'data', 'fonts', 'AllFonts.js');
const FONT_DIR = isMac ? '/Library/Fonts' : 'C:/Windows/Fonts';
const WIDTH = 1920;

const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1];

// Top-level shapes of <p:spTree>: [{ id, start, end, x, y, w, h }] in EMU, in z-order (first = bottom).
function shapes(xml) {
  const tree = xml.indexOf('</p:grpSpPr>') + '</p:grpSpPr>'.length;
  const out = [];
  const tag = /<(\/?)p:(sp|pic|cxnSp|graphicFrame|grpSp)\b[^>]*?(\/?)>/g;
  tag.lastIndex = tree;
  let depth = 0, start = 0, m;
  while ((m = tag.exec(xml))) {
    if (m[3]) continue; // self-closing: not a shape
    if (!m[1]) { if (depth++ === 0) start = m.index; continue; }
    if (--depth) continue; // closing a shape nested in a group
    const s = xml.slice(start, tag.lastIndex);
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(s), ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(s);
    out.push({ id: attr(s, 'id'), start, end: tag.lastIndex, x: +off?.[1] || 0, y: +off?.[2] || 0, w: +ext?.[1] || 0, h: +ext?.[2] || 0 });
  }
  return out;
}

// Click triggers: [{ id, steps: [[[shapeId, show], ...], ...] }]. Each click on the trigger runs the next step.
function triggers(xml) {
  const out = [];
  for (const [seq] of xml.matchAll(/<p:seq\b[\s\S]*?<\/p:seq>/g)) {
    if (!seq.includes('nodeType="interactiveSeq"')) continue; // ponytail: mainSeq (plain click-to-advance) not handled; add when a lesson uses it
    const id = /<p:spTgt spid="(\d+)"/.exec(seq)?.[1];
    const steps = [];
    for (const m of seq.matchAll(/nodeType="(clickEffect|withEffect|afterEffect)"|<p:set>[\s\S]*?<p:spTgt spid="(\d+)"[\s\S]*?<p:strVal val="(visible|hidden)"/g)) {
      if (m[1] === 'clickEffect' || (m[1] && !steps.length)) steps.push([]);
      else if (m[2]) steps.at(-1).push([m[2], m[3] === 'visible']);
    }
    if (id && steps.length) out.push({ id, steps });
  }
  return out;
}

const noTiming = (xml) => xml.replace(/<p:timing>[\s\S]*?<\/p:timing>/, '').replace(/<p:bldLst>[\s\S]*?<\/p:bldLst>/, '');

// The slide with only this shape, on a solid background, no layout / master decoration.
function layerXml(xml, shape, color) {
  const tree = xml.indexOf('</p:grpSpPr>') + '</p:grpSpPr>'.length;
  const end = xml.lastIndexOf('</p:spTree>');
  const one = xml.slice(0, tree) + xml.slice(shape.start, shape.end) + xml.slice(end);
  return noTiming(one)
    .replace(/<p:bg>[\s\S]*?<\/p:bg>/, '')
    .replace(/<p:cSld\b[^>]*>/, (m) => `${m}<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`)
    .replace(/<p:sld\b/, '<p:sld showMasterSp="0"')
    .replace(/(<p:sld\b[^>]*?) showMasterSp="[01]"([^>]*showMasterSp)/, '$1$2'); // one attribute if the slide had its own
}

function x2t(from, to, height, tmp) {
  const params = path.join(tmp, 'params.xml');
  fs.writeFileSync(params, `<?xml version="1.0" encoding="utf-8"?>
<TaskQueueDataConvert><m_sFileFrom>${from}</m_sFileFrom><m_sFileTo>${to}</m_sFileTo><m_nFormatTo>1029</m_nFormatTo>
<m_oThumbnail><format>4</format><aspect>1</aspect><first>false</first><width>${WIDTH}</width><height>${height}</height></m_oThumbnail>
<m_sAllFontsPath>${FONTS}</m_sAllFontsPath><m_sFontDir>${FONT_DIR}</m_sFontDir><m_sTempDir>${tmp}</m_sTempDir></TaskQueueDataConvert>`);
  return new Promise((resolve, reject) => execFile(X2T, [params], { cwd: path.dirname(X2T), maxBuffer: 1 << 24 },
    (err, stdout, stderr) => (err ? reject(new Error(`x2t: ${stderr || stdout || err.message}`)) : resolve())));
}

// The same shape on white and on black gives its exact alpha: white − black = (1 − α)·255, and the black render
// is already the colour premultiplied by α. Cropped to what is not fully transparent.
function unblend(white, black, nativeImage) {
  const w = nativeImage.createFromBuffer(white), b = nativeImage.createFromBuffer(black);
  const { width, height } = w.getSize();
  const W = w.toBitmap(), B = b.toBitmap();
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const a = 255 - Math.round(((W[i] - B[i]) + (W[i + 1] - B[i + 1]) + (W[i + 2] - B[i + 2])) / 3);
    B[i + 3] = Math.max(0, Math.min(255, a));
    if (B[i + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null; // nothing visible
  const full = nativeImage.createFromBitmap(B, { width, height });
  const rect = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  return { rect, png: full.crop(rect).toPNG() };
}

// → zip bytes: lesson.json + images. onProgress(text) for the teacher.
async function build(file, nativeImage, onProgress = () => {}) {
  const z = unzipSync(fs.readFileSync(file));
  const text = (n) => strFromU8(z[n]);
  const pres = text('ppt/presentation.xml');
  const [cx, cy] = [+attr(/<p:sldSz[^>]*>/.exec(pres)[0], 'cx'), +attr(/<p:sldSz[^>]*>/.exec(pres)[0], 'cy')];
  const height = Math.round(WIDTH * cy / cx), k = WIDTH / cx;
  const rels = text('ppt/_rels/presentation.xml.rels');
  const target = (rid) => attr(new RegExp(`<Relationship [^>]*Id="${rid}"[^>]*>`).exec(rels)[0], 'Target');
  const order = [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => 'ppt/' + target(m[1]).replace(/^\//, '').replace(/^ppt\//, ''));

  // One render deck: per slide its base, then each layer on white and on black.
  const lesson = { v: 1, title: path.basename(file, path.extname(file)), w: WIDTH, h: height, slides: [] };
  const deck = []; // [kind, slideIndex, layerIndex]
  const parts = [];
  order.forEach((name, si) => {
    const xml = text(name);
    const relName = name.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const slideRels = (z[relName] ? text(relName) : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
      .replace(/<Relationship [^>]*relationships\/notesSlide"[^>]*\/>/, ''); // copies must not claim the notes page
    const all = shapes(xml), byId = new Map(all.map((s, z) => [s.id, { ...s, z }]));
    const trig = triggers(xml);
    // A layer starts visible when its first animation hides it (an exit), hidden when it first appears.
    const first = new Map();
    for (const t of trig) for (const step of t.steps) for (const [id, show] of step) if (!first.has(id) && byId.has(id)) first.set(id, show);
    const layers = [...first.keys()].map((id) => byId.get(id)).sort((a, b) => a.z - b.z);
    let base = xml;
    for (const s of [...layers].sort((a, b) => b.start - a.start)) base = base.slice(0, s.start) + base.slice(s.end);
    const add = (xmlText, kind, li) => { parts.push([strToU8(noTiming(xmlText)), slideRels]); deck.push([kind, si, li]); };
    add(base, 'base');
    layers.forEach((s, li) => { add(layerXml(xml, s, 'FFFFFF'), 'white', li); add(layerXml(xml, s, '000000'), 'black', li); });
    const px = (s) => ({ x: Math.round(s.x * k), y: Math.round(s.y * k), w: Math.round(s.w * k), h: Math.round(s.h * k) });
    lesson.slides.push({
      img: `s${si + 1}.jpg`,
      layers: layers.map((s) => ({ id: s.id, show: !first.get(s.id) })),
      triggers: trig.filter((t) => byId.has(t.id)).map((t) => ({ id: t.id, z: byId.get(t.id).z, ...px(byId.get(t.id)), steps: t.steps })),
    });
  });

  // New slide parts replace the slide list; the originals stay in the package, unlisted.
  let types = text('[Content_Types].xml'), list = '', prels = rels;
  parts.forEach(([xml, r], i) => {
    z[`ppt/slides/hd${i}.xml`] = xml;
    z[`ppt/slides/_rels/hd${i}.xml.rels`] = strToU8(r);
    types = types.replace('</Types>', `<Override PartName="/ppt/slides/hd${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
    prels = prels.replace('</Relationships>', `<Relationship Id="rIdHd${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/hd${i}.xml"/></Relationships>`);
    list += `<p:sldId id="${256 + i}" r:id="rIdHd${i}"/>`;
  });
  z['[Content_Types].xml'] = strToU8(types);
  z['ppt/_rels/presentation.xml.rels'] = strToU8(prels);
  z['ppt/presentation.xml'] = strToU8(pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${list}</p:sldIdLst>`));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-')); // ASCII path: x2t fails on some non-latin ones
  try {
    const src = path.join(tmp, 'deck.pptx'), out = path.join(tmp, 'out.zip');
    fs.writeFileSync(src, zipSync(z, { level: 0 }));
    onProgress(`Готовлю ${order.length} слайдов, ${(deck.length - order.length) / 2} картинок-ответов…`);
    await x2t(src, out, height, tmp);
    const imgs = unzipSync(fs.readFileSync(out));
    const png = (i) => imgs[`image${i + 1}.png`];
    const files = {};
    for (let i = 0; i < deck.length; i++) {
      const [kind, si, li] = deck[i], slide = lesson.slides[si];
      if (kind === 'base') files[slide.img] = nativeImage.createFromBuffer(Buffer.from(png(i))).toJPEG(90);
      if (kind !== 'white') continue;
      const cut = unblend(Buffer.from(png(i)), Buffer.from(png(i + 1)), nativeImage), layer = slide.layers[li];
      layer.img = `s${si + 1}_${layer.id}.png`;
      if (cut) { files[layer.img] = cut.png; Object.assign(layer, { x: cut.rect.x, y: cut.rect.y, w: cut.rect.width, h: cut.rect.height }); }
      else Object.assign(layer, { img: null, x: 0, y: 0, w: 0, h: 0 }); // an empty shape (e.g. a transparent hit area)
      if (li % 20 === 0) onProgress(`Слайд ${si + 1} из ${order.length}…`);
    }
    files['lesson.json'] = strToU8(JSON.stringify(lesson));
    return zipSync(files, { level: 0 }); // jpg / png don't compress further
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { build, shapes, triggers, X2T, FONTS };
