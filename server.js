// Static site + WebSocket signaling for 1:1 rooms + short-lived TURN credentials.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const TURN_HOST = process.env.TURN_HOST;     // e.g. 1-2-3-4.sslip.io; unset = STUN only
const TURN_SECRET = process.env.TURN_SECRET; // same as static-auth-secret in turnserver.conf

const PUBLIC = path.join(import.meta.dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
// Whitelist of servable files: no path traversal to worry about.
const FILES = new Set(fs.readdirSync(PUBLIC));

function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_HOST && TURN_SECRET) {
    // coturn "use-auth-secret" scheme: username = expiry timestamp, password = HMAC of it.
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:huddle`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({ urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`], username, credential });
  }
  return list;
}

const server = http.createServer((req, res) => {
  const url = URL.parse(req.url, 'http://x');
  if (!url) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/r/' + crypto.randomBytes(16).toString('base64url') });
    return res.end();
  }
  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: iceServers() }));
  }
  const name = path.basename(url.pathname);
  const file = url.pathname.startsWith('/r/') || !FILES.has(name) ? 'index.html' : name;
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
});

// ponytail: rooms live in memory; a server restart drops active calls (clients reconnect on reload).
const rooms = new Map(); // code -> Set<ws>

new WebSocketServer({ server, maxPayload: 64 * 1024 }).on('connection', (ws, req) => {
  ws.on('error', () => ws.terminate()); // bad frames must not crash the process
  const code = URL.parse(req.url, 'http://x')?.searchParams.get('room');
  if (!code || !/^[\w-]{4,32}$/.test(code)) return ws.close(4000, 'bad room');
  const room = rooms.get(code) ?? new Set();
  if (room.size >= 2) return ws.close(4001, 'full');
  rooms.set(code, room);

  const peer = [...room][0];
  room.add(ws);
  ws.send(JSON.stringify({ type: 'joined', peer: !!peer }));
  peer?.send(JSON.stringify({ type: 'peer-joined' }));

  ws.on('message', (data) => {
    for (const other of room) if (other !== ws) other.send(data.toString());
  });
  ws.on('close', () => {
    room.delete(ws);
    if (room.size === 0) rooms.delete(code);
    for (const other of room) other.send(JSON.stringify({ type: 'peer-left' }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Huddle on http://localhost:${PORT}`));
