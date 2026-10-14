// Relay + static file server. `npm start`, then open http://localhost:8080 in two tabs.
//   PORT          listen port (default 8080)
//   HOST          bind address (default 127.0.0.1; use 0.0.0.0 to expose on your LAN)
//   ALLOWED_ORIGINS  comma-separated Origin allowlist for WebSocket upgrades (default: any)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub, LIMITS } from './hub.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
// Mirrors the GitHub Pages layout: web/ at the root, src/ next to it.
const MOUNTS = [['/src/', resolve(ROOT, 'src')], ['/', resolve(ROOT, 'web')]];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; worker-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [prefix, dir] = MOUNTS.find(([p]) => path.startsWith(p));
  let file = resolve(dir, '.' + path.slice(prefix.length - 1));
  if (!file.startsWith(dir + sep) && file !== dir) return send(res, 403, 'forbidden'); // path traversal
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    res.end(await readFile(file));
  } catch {
    send(res, 404, 'not found');
  }
}

const send = (res, code, text) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(text); };

export function startRelay({ port = 8080, host = '127.0.0.1', allowedOrigins = null, limits } = {}) {
  const hub = new Hub(limits);
  const http = createServer((req, res) => {
    if (req.url === '/health') return send(res, 200, JSON.stringify(hub.stats));
    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    serveStatic(req, res).catch(() => send(res, 500, 'error'));
  });

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: hub.limits.maxFrame,
    perMessageDeflate: false, // ciphertext doesn't compress; deflate would only burn CPU
    verifyClient: ({ origin }) => !allowedOrigins || allowedOrigins.includes(origin),
  });

  wss.on('connection', (ws) => {
    const conn = {
      send: (b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }),
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() { return ws.bufferedAmount; },
    };
    const client = hub.connect(conn);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close(1003, 'binary only');
      client.receive(data);
    });
    ws.on('close', () => client.close());
    ws.on('error', () => ws.terminate());
  });

  // Reap dead sockets so rooms don't fill with ghosts.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  return new Promise((ok) => http.listen(port, host, () => {
    const close = () => new Promise((done) => { clearInterval(beat); for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => done()); });
    ok({ port: http.address().port, hub, close });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const { port: bound } = await startRelay({ port, host, allowedOrigins });
  console.log(`parley relay on http://${host}:${bound}  (ws at /ws, max frame ${LIMITS.maxFrame} B)`);
}
