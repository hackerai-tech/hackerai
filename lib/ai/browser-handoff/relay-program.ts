import { createBrowserInputNormalizer } from "./input";

// A run-owned HTTP relay, not a public CDP/WebSocket proxy. Only validated
// viewport input and image frames cross this boundary. All credentials arrive
// over stdin and live only in the private memory-backed run directory.
export const BROWSER_RELAY_PROGRAM = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const directory = process.argv[1];
fs.writeFileSync(directory + '/pid', String(process.pid), {mode: 0o600});
const config = JSON.parse(fs.readFileSync(directory + '/config', 'utf8'));
const { normalizeBrowserInputBatch } = NORMALIZER_FACTORY();
let stopped = false;
let viewer;
let latest;
let sequence = 0;
let expectedInput = 1;
let lastInputBody = '';
let lastSent = 0;
let heldMouse;
const socket = new WebSocket('ws://127.0.0.1:' + config.port);
const root = config.root;
function valid() {
  try {
    const lease = Number(fs.readFileSync(directory + '/lease', 'utf8'));
    return !stopped && Date.now() < Math.min(lease, config.expiresAt) &&
      !fs.existsSync(directory + '/revoked') && fs.existsSync(root + '/paused') &&
      fs.readFileSync(root + '/active-session', 'utf8').trim() === config.browserSessionName;
  } catch { return false; }
}
function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  if (viewer) viewer.end();
  server.close();
  if (heldMouse && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({type: 'input_mouse', eventType: 'mouseReleased',
      x: heldMouse.x, y: heldMouse.y, button: 'left'}));
    heldMouse = undefined;
  }
  // The close handshake follows accepted input on the same ordered socket.
  // Resume waits for this acknowledgement before capturing/unpausing.
  socket.close();
  setTimeout(() => process.exit(1), 5000).unref();
}
socket.addEventListener('close', () => {
  try { fs.writeFileSync(directory + '/closed', '1', {mode: 0o600}); } catch {}
  process.exit(0);
});
socket.addEventListener('error', stop);
socket.addEventListener('message', event => {
  if (!valid()) { stop(); return; }
  try {
    const message = JSON.parse(String(event.data));
    if (message.type === 'status' && message.connected === false) { stop(); return; }
    if (message.type !== 'frame') return;
    const meta = message.metadata || {};
    if (typeof message.data !== 'string' || message.data.length > 900000 ||
        !(meta.deviceWidth > 0 && meta.deviceWidth <= 8192) ||
        !(meta.deviceHeight > 0 && meta.deviceHeight <= 8192)) return;
    const bytes = Buffer.from(message.data, 'base64');
    const mime = bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' :
      bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : null;
    if (!mime || bytes.length > 675000) return;
    latest = { type: 'frame', sequence: ++sequence, frame: {
      image: 'data:' + mime + ';base64,' + message.data,
      width: meta.deviceWidth, height: meta.deviceHeight,
      capturedAt: Number(meta.timestamp) || 0, browserSessionName: config.browserSessionName,
    }};
  } catch { stop(); }
});
function reply(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Vary', 'Origin');
  if (req.headers.origin !== config.origin) { reply(res, 403, {}); return; }
  res.setHeader('Access-Control-Allow-Origin', config.origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204); res.end(); return;
  }
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from('Bearer ' + config.grant);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected) || !valid()) {
    reply(res, 403, {}); return;
  }
  if (req.method === 'GET' && req.url === '/frames') {
    if (viewer) viewer.end();
    viewer = res;
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no'});
    res.write('data: {"type":"ready"}\n\n');
    if (latest) res.write('data: ' + JSON.stringify(latest) + '\n\n');
    res.on('close', () => { if (viewer === res) viewer = undefined; });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/input') { reply(res, 404, {}); return; }
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) { reply(res, 413, {}); return; }
    }
    const parsed = JSON.parse(body);
    const events = normalizeBrowserInputBatch(parsed.inputs);
    if (!events || !Number.isSafeInteger(parsed.sequence)) { reply(res, 400, {}); return; }
    if (!valid() || socket.readyState !== WebSocket.OPEN) { reply(res, 409, {}); return; }
    if (parsed.sequence === expectedInput - 1 && body === lastInputBody) {
      reply(res, 200, {ok: true}); return;
    }
    if (parsed.sequence !== expectedInput || socket.bufferedAmount > 65536) {
      reply(res, 409, {}); return;
    }
    for (const event of events) {
      socket.send(JSON.stringify(event));
      if (event.type === 'input_mouse') {
        if (event.eventType === 'mousePressed' ||
            (event.eventType === 'mouseMoved' && event.button === 'left')) {
          heldMouse = {x: event.x, y: event.y};
        } else if (event.eventType === 'mouseReleased' || event.eventType === 'mouseMoved') {
          heldMouse = undefined;
        }
      }
    }
    expectedInput++;
    lastInputBody = body;
    reply(res, 200, {ok: true});
  } catch { reply(res, 400, {}); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.maxConnections = 16;
let tick = 0;
const timer = setInterval(() => {
  if (!valid()) { stop(); return; }
  if (!viewer || socket.readyState !== WebSocket.OPEN) return;
  // Skip intermediate frames under backpressure. Do not build an old-frame queue.
  if (viewer.writableLength > 1000000) { viewer.destroy(); viewer = undefined; return; }
  if (latest && latest.sequence !== lastSent && viewer.writableLength === 0) {
    viewer.write('data: ' + JSON.stringify(latest) + '\n\n'); lastSent = latest.sequence;
  }
  if (++tick % 20 === 0) viewer.write('data: {"type":"ready"}\n\n');
}, 50);
socket.addEventListener('open', () => {
  if (!valid()) { stop(); return; }
  server.listen(0, '0.0.0.0', () => {
    fs.writeFileSync(directory + '/port.next', String(server.address().port), {mode: 0o600});
    fs.renameSync(directory + '/port.next', directory + '/port');
  });
});
`;

export function browserRelayProgram() {
  return BROWSER_RELAY_PROGRAM.replace(
    "NORMALIZER_FACTORY",
    `(${createBrowserInputNormalizer.toString()})`,
  );
}

// Requests can finish out of order, including after an HTTP timeout. Serialize
// the read/max/replace so an older deadline cannot undo a successful renewal.
export const RELAY_RENEW_PROGRAM = String.raw`
const fs = require('node:fs');
const d = process.argv[1], deadline = Number(process.argv[2]);
(async () => {
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Invalid lease');
  let locked = false;
  for (let i = 0; i < 100; i++) {
    try { fs.mkdirSync(d + '/lease.lock', {mode: 0o700}); locked = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!locked) throw new Error('Renewal busy');
  const next = d + '/lease.next-' + process.pid;
  try {
    if (fs.existsSync(d + '/revoked') || fs.existsSync(d + '/closed')) throw new Error('Revoked');
    const previous = Number(fs.readFileSync(d + '/lease', 'utf8'));
    if (!Number.isFinite(previous) || previous <= Date.now()) throw new Error('Expired');
    fs.writeFileSync(next, String(Math.max(previous, deadline)), {mode: 0o600});
    fs.renameSync(next, d + '/lease');
  } finally {
    fs.rmSync(next, {force: true});
    fs.rmdirSync(d + '/lease.lock');
  }
})().catch(() => { process.exitCode = 1; });
`;

export const RELAY_START_PROGRAM = String.raw`
const fs = require('node:fs');
const {spawn} = require('node:child_process');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; if (data.length > 100000) process.exit(1); });
process.stdin.on('end', async () => {
  const {directory, config, program, lease} = JSON.parse(data);
  fs.mkdirSync(directory, {mode: 0o700});
  fs.writeFileSync(directory + '/config', JSON.stringify(config), {mode: 0o600});
  fs.writeFileSync(directory + '/lease', String(lease), {mode: 0o600});
  const child = spawn(process.execPath, ['--experimental-websocket', '-e', program, directory], {detached: true, stdio: 'ignore'});
  if (child.pid) fs.writeFileSync(directory + '/pid', String(child.pid), {mode: 0o600});
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; fs.writeFileSync(directory + '/closed', '1', {mode: 0o600}); });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (exited) break;
    try {
      const port = Number(fs.readFileSync(directory + '/port', 'utf8'));
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        process.stdout.write(String(port));
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fs.writeFileSync(directory + '/revoked', '1', {mode: 0o600});
  child.kill();
  process.exitCode = 1;
});
`;

// Live relays must acknowledge their ordered socket close. A confirmed dead
// process cannot accept more input and must not permanently block recovery.
export const RELAY_STOP_PROGRAM = String.raw`
const fs = require('node:fs');
const root = process.argv[1], only = process.argv[2];
function alive(directory) {
  let pid;
  try { pid = Number(fs.readFileSync(directory + '/pid', 'utf8')); } catch { return true; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  if (process.platform === 'linux') {
    // A reused PID belongs to a different process, not this relay.
    try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').includes(directory); }
    catch (error) { return error.code !== 'ENOENT'; }
  }
  return true;
}
(async () => {
  const dirs = only ? [only] : fs.readdirSync(root).filter(n => /^relay-[a-f0-9]{24}$/.test(n)).map(n => root + '/' + n);
  await Promise.all(dirs.map(async directory => {
    if (!fs.existsSync(directory)) return;
    fs.writeFileSync(directory + '/revoked', '1', {mode: 0o600});
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(directory + '/closed')) return;
      if (!alive(directory)) {
        fs.writeFileSync(directory + '/closed', '1', {mode: 0o600});
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    process.exitCode = 1;
  }));
})().catch(() => { process.exitCode = 1; });
`;
