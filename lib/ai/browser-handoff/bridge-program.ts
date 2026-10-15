// Executed inside the existing cloud sandbox. The stream WebSocket is bound to
// localhost there; only a single validated frame or input batch crosses the
// authenticated E2B command connection. Never send this port to a client.
export const BROWSER_BRIDGE_PROGRAM = String.raw`
const port = Number(process.argv[1]);
const mode = process.argv[2];
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    (mode !== 'frame' && mode !== 'input') || typeof WebSocket !== 'function') {
  process.exit(2);
}
let done = false;
const finish = (code, value) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (value !== undefined) process.stdout.write(JSON.stringify(value));
  try { socket.close(); } catch {}
  setTimeout(() => process.exit(code), 20);
};
const timer = setTimeout(() => finish(3), 6500);
let payload = '';
let socket;
if (mode === 'input') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    payload += chunk;
    if (payload.length > 8192) finish(4);
  });
  process.stdin.on('end', connect);
} else {
  connect();
}
function connect() {
  if (done) return;
  socket = new WebSocket('ws://127.0.0.1:' + port);
  socket.addEventListener('open', () => {
    if (mode !== 'input') return;
    try {
      const events = JSON.parse(payload);
      if (!Array.isArray(events) || events.length < 1 || events.length > 64) {
        finish(4); return;
      }
      for (const event of events) socket.send(JSON.stringify(event));
      setTimeout(() => finish(0, { ok: true }), 120);
    } catch { finish(4); }
  });
  socket.addEventListener('message', event => {
    if (mode !== 'frame') return;
    try {
      const message = JSON.parse(String(event.data));
      if (message.type !== 'frame') return;
      if (typeof message.data !== 'string' || message.data.length > 900000) {
        finish(5); return;
      }
      const metadata = message.metadata || {};
      finish(0, {
        data: message.data,
        width: Number(metadata.deviceWidth) || 0,
        height: Number(metadata.deviceHeight) || 0,
        capturedAt: Number(metadata.timestamp) || Date.now(),
      });
    } catch { finish(5); }
  });
  socket.addEventListener('error', () => finish(6));
  socket.addEventListener('close', () => { if (!done) finish(6); });
}
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function browserBridgeCommand(port: number, mode: "frame" | "input") {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid private browser stream port");
  return `node -e ${quote(BROWSER_BRIDGE_PROGRAM)} ${port} ${mode}`;
}
