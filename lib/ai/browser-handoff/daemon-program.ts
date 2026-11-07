// Talk to the already-running owned daemon. Invoking the CLI here can restart
// agent-browser 0.39 when the server lacks the Agent's launch configuration.
export const BROWSER_DAEMON_PRECONDITION_REASONS = [
  "arguments",
  "root_stat",
  "sockets_stat",
  "socket_stat",
  "root_type",
  "sockets_type",
  "socket_type",
  "owner_mismatch",
  "request_invalid",
] as const;

export const BROWSER_DAEMON_PROGRAM = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const [directory, name, payload] = process.argv.slice(1);
let socket;
let timer;
let done = false;
let precondition = 'arguments';
function finish(code, value) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (socket) socket.destroy();
  if (value !== undefined) process.stdout.write(JSON.stringify(value));
  process.exit(code);
}
try {
  if (!directory || path.dirname(directory) !== '/dev/shm' ||
      !/^hackerai-browser-[a-zA-Z0-9-]+$/.test(path.basename(directory)) ||
      typeof name !== 'string' || !name || name.length > 80 || /[/\x00\r\n]/.test(name)) {
    throw new Error();
  }
  precondition = 'root_stat';
  const root = fs.lstatSync(directory);
  precondition = 'sockets_stat';
  const sockets = fs.lstatSync(path.join(directory, 'sockets'));
  const address = path.join(directory, 'sockets', name + '.sock');
  precondition = 'socket_stat';
  const info = fs.lstatSync(address);
  precondition = 'root_type';
  if (!root.isDirectory()) throw new Error();
  precondition = 'sockets_type';
  if (!sockets.isDirectory()) throw new Error();
  precondition = 'socket_type';
  if (!info.isSocket()) throw new Error();
  precondition = 'owner_mismatch';
  if ([root, sockets, info].some(item => item.uid !== process.getuid())) throw new Error();
  precondition = 'request_invalid';
  const request = JSON.parse(payload);
  if (!['stream_status', 'screenshot', 'viewport'].includes(request.action)) throw new Error();
  const id = 'hackerai-preview';
  let buffer = '';
  timer = setTimeout(() => finish(3), 6000);
  socket = net.createConnection(address);
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(JSON.stringify({ ...request, id }) + '\n'));
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2 * 1024 * 1024) return finish(4);
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    try {
      const response = JSON.parse(buffer.slice(0, newline));
      if (response.id !== id || response.success !== true) return finish(5);
      finish(0, response);
    } catch { finish(5); }
  });
  socket.on('error', () => finish(6));
  socket.on('close', () => { if (!done) finish(6); });
} catch (error) {
  const value = { diagnostic_reason: precondition };
  if (['root_stat', 'sockets_stat', 'socket_stat'].includes(precondition)) {
    let code;
    try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch {}
    value.diagnostic_error = code === 'ENOENT' ? 'missing' :
      code === 'EACCES' || code === 'EPERM' ? 'permission' :
      code === 'ENOTDIR' ? 'not_directory' : 'other';
  }
  finish(2, value);
}
`;

type BrowserDaemonRequest =
  | { action: "stream_status" }
  | { action: "screenshot"; path: string; format: "jpeg"; quality: 65 }
  | {
      action: "viewport";
      width: number;
      height: number;
      deviceScaleFactor: 1;
    };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function browserDaemonCommand(
  directory: string,
  sessionName: string,
  request: BrowserDaemonRequest,
): string {
  return `node -e ${[BROWSER_DAEMON_PROGRAM, directory, sessionName, JSON.stringify(request)].map(quote).join(" ")}`;
}
