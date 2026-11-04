// Signaling smoke test: node test.js
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createRequire } from 'node:module';

// PPTX trigger parsing (app/lesson.js): top-level shapes only, click steps, appear / disappear.
{
  const { shapes, triggers } = createRequire(import.meta.url)('./app/lesson.js');
  const sp = (id, x) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name=""/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="0"/><a:ext cx="10" cy="20"/></a:xfrm></p:spPr></p:sp>`;
  const set = (id, v) => `<p:set><p:cBhvr><p:tgtEl><p:spTgt spid="${id}"/></p:tgtEl></p:cBhvr><p:to><p:strVal val="${v}"/></p:to></p:set>`;
  const xml = `<p:spTree><p:grpSpPr/></p:grpSpPr>${sp(2, 5)}<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3"/></p:nvGrpSpPr>${sp(4, 7)}</p:grpSp>${sp(5, 9)}</p:spTree>` +
    `<p:timing><p:seq><p:cTn nodeType="interactiveSeq"><p:stCondLst><p:cond evt="onClick"><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cond></p:stCondLst>` +
    `<p:cTn nodeType="clickEffect">${set(5, 'visible')}</p:cTn><p:cTn nodeType="withEffect">${set(3, 'hidden')}</p:cTn><p:cTn nodeType="clickEffect">${set(5, 'hidden')}</p:cTn></p:cTn></p:seq></p:timing>`;
  assert.deepStrictEqual(shapes(xml).map((s) => [s.id, s.x, s.w]), [['2', 5, 10], ['3', 7, 10], ['5', 9, 10]]);
  assert.deepStrictEqual(triggers(xml), [{ id: '2', steps: [[['5', true], ['3', false]], [['5', false]]] }]);
}

const PORT = 3999;
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT } });
await new Promise((r) => server.stdout.once('data', r));

const url = `ws://localhost:${PORT}/?room=test1234`;
const open = (u = url) => {
  const ws = new WebSocket(u);
  ws.inbox = [];
  ws.on('message', (d) => ws.inbox.push(JSON.parse(d)));
  return new Promise((r) => ws.on('open', () => r(ws)));
};
const tick = () => new Promise((r) => setTimeout(r, 100));

try {
  const a = await open();
  await tick();
  assert.deepEqual(a.inbox.shift(), { type: 'joined', peer: false });

  const b = await open();
  await tick();
  assert.deepEqual(b.inbox.shift(), { type: 'joined', peer: true });
  assert.deepEqual(a.inbox.shift(), { type: 'peer-joined' });

  b.send(JSON.stringify({ hello: 1 }));
  await tick();
  assert.deepEqual(a.inbox.shift(), { hello: 1 });

  const c = new WebSocket(url);
  const code = await new Promise((r) => c.on('close', r));
  assert.equal(code, 4001);

  b.close();
  await tick();
  assert.deepEqual(a.inbox.shift(), { type: 'peer-left' });

  const res = await fetch(`http://localhost:${PORT}/config`).then((r) => r.json());
  assert.ok(res.iceServers.length >= 1);
  const page = await fetch(`http://localhost:${PORT}/r/abc`).then((r) => r.text());
  assert.ok(page.includes('app.js'));
  const traversal = await fetch(`http://localhost:${PORT}/..%2fserver.js`).then((r) => r.text());
  assert.ok(!traversal.includes('WebSocketServer'));

  a.close();
  console.log('ok');
} finally {
  server.kill();
}
