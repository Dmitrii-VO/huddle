// Signaling smoke test: node test.js
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { WebSocket } from 'ws';

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
