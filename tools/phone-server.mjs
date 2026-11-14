#!/usr/bin/env node
// Phone server [Role 2]: serves web/ to the phones and relays channel messages between devices.
// No dependencies. One port, so one firewall rule.
//
//   node tools/phone-server.mjs [--port 8000] [--host 0.0.0.0]
//   then on each phone (same Wi-Fi / the laptop's hotspot):  http://<laptop-ip>:8000/phone-check.html
//
// The relay is the "air": a dumb broadcast medium. Each message published on a channel goes to
// every OTHER connection subscribed to that channel name (BroadcastChannel semantics across
// devices). It holds no musical logic, never inspects payloads and never decides anything;
// message LOSS is still applied by each agent's own transport (web/transport.js), as on one laptop.
// It also answers clock pings, so every device can agree on one time base (web/clock.js), and
// remembers the session the Stage announced, so phones can join the current run.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const PORT = Number(arg('--port', 8000));
const HOST = arg('--host', '0.0.0.0'); // 127.0.0.1 = this laptop only (no firewall prompt, no phones)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/plain' };
const now = () => performance.timeOrigin + performance.now();

// ---- static files (no caching: the browser always gets the JS you just saved) ----
// The laptop's addresses on the network, so the Stage (opened as localhost) can print QR codes
// that phones can actually reach (best guess first; the Stage's QR panel can switch).
function lanAddresses() {
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  // Most likely network for phones first: a phone's hotspot, then the laptop's own hotspot, then
  // other Wi-Fi; big venue networks (10.x, e.g. eduroam) last, since they usually isolate devices.
  const rank = (ip) => (ip.startsWith('172.20.10.') || ip.startsWith('192.168.43.') ? 0 : ip.startsWith('192.168.137.') ? 1 : ip.startsWith('10.') ? 3 : 2);
  return ips.sort((a, b) => rank(a) - rank(b));
}

const server = createServer(async (req, res) => {
  const from = req.socket.remoteAddress?.replace('::ffff:', '');
  if (from && from !== '127.0.0.1' && from !== '::1') console.log(`[http] ${from} ${req.url}`); // phones show up here
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/ip') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ips: lanAddresses(), port: PORT, servingNetwork: HOST !== '127.0.0.1' && HOST !== 'localhost' }));
      return;
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT + sep) && file !== ROOT) throw Object.assign(new Error('forbidden'), { code: 403 });
    const st = await stat(file);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 404 });
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (err) {
    res.writeHead(err.code === 403 ? 403 : 404, { 'Content-Type': 'text/plain' });
    res.end(err.code === 403 ? 'forbidden' : 'not found');
  }
});

// ---- minimal WebSocket (RFC 6455): text frames, ping/pong, close ----
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

const subs = new Map(); // channel -> Set(conn)
let announcedSession = null;
let nextId = 1;

function send(conn, obj) {
  if (!conn.closed) conn.socket.write(frame(JSON.stringify(obj)));
}

function onMessage(conn, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  switch (m.op) {
    case 'sub': (subs.get(m.ch) ?? subs.set(m.ch, new Set()).get(m.ch)).add(conn); conn.chans.add(m.ch); break;
    case 'unsub': subs.get(m.ch)?.delete(conn); conn.chans.delete(m.ch); break;
    case 'pub': for (const c of subs.get(m.ch) ?? []) if (c !== conn) send(c, { op: 'msg', ch: m.ch, data: m.data }); break;
    case 'time': send(conn, { op: 'time', id: m.id, t1: m.t1, ts: now() }); break;
    case 'announce': if (announcedSession !== m.session) console.log(`[relay] Stage session: ${m.session}`); announcedSession = m.session; break;
    case 'session?': send(conn, { op: 'session', session: announcedSession }); break;
    case 'hello': conn.label = String(m.label ?? '').slice(0, 40); console.log(`[relay] #${conn.id} is ${conn.label}`); break;
    default:
  }
}

server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/relay') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const conn = { id: nextId++, socket, chans: new Set(), closed: false, label: '', buf: Buffer.alloc(0), parts: [] };
  console.log(`[relay] #${conn.id} connected from ${req.socket.remoteAddress}`);
  const close = () => {
    if (conn.closed) return;
    conn.closed = true;
    for (const ch of conn.chans) subs.get(ch)?.delete(conn);
    console.log(`[relay] #${conn.id} ${conn.label} disconnected`);
  };
  socket.on('close', close);
  socket.on('error', close);
  socket.on('data', (chunk) => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    for (;;) {
      const b = conn.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const masked = b[1] & 0x80;
      if (b.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? b.subarray(off, off + 4) : null;
      off += masked ? 4 : 0;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      conn.buf = b.subarray(off + len);
      if (op === 0x8) { socket.end(Buffer.from([0x88, 0])); close(); return; }
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0x1 || op === 0x0) {
        conn.parts.push(payload);
        if (fin) { const text = Buffer.concat(conn.parts).toString('utf8'); conn.parts = []; onMessage(conn, text); }
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`EÄ phone server: serving ${ROOT} on port ${PORT} (no-cache), relay at /relay`);
  console.log(`  laptop Stage:  http://localhost:${PORT}/?phones`);
  if (HOST === '127.0.0.1' || HOST === 'localhost') console.log('  (bound to this laptop only: phones cannot connect. Drop --host to serve the network.)');
  else for (const ip of ips) console.log(`  phones:        http://${ip}:${PORT}/phone-check.html   (then /phone.html)`);
  if (!ips.length) console.log('  (no network address found: join the hotspot / Wi-Fi first)');
});
