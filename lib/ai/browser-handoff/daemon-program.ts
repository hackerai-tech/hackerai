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

export const BROWSER_WRAPPER_ACTIONS = [
  "open",
  "close",
  "version",
  "other",
] as const;
export const BROWSER_WRAPPER_AGES = [
  "lt10s",
  "lt60s",
  "lt5m",
  "older",
  "unknown",
] as const;

export const BROWSER_DAEMON_PROGRAM = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [directory, name, payload] = process.argv.slice(1);
let socket;
let timer;
let done = false;
let precondition = 'arguments';
let argumentsValid = false;
let rootInfo;
/** Read only a bounded private receipt and return finite observations, never its session key. */
function wrapperReceipt() {
  let fd;
  try {
    if (!argumentsValid || !rootInfo?.isDirectory() || rootInfo.uid !== process.getuid() ||
        (rootInfo.mode & 0o077) !== 0 || typeof fs.constants?.O_NOFOLLOW !== 'number' ||
        typeof fs.constants.O_NONBLOCK !== 'number') return {};
    const receiptPath = path.join(directory, 'wrapper-receipt.json');
    const entry = fs.lstatSync(receiptPath);
    if (!entry.isFile() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0 ||
        entry.size < 1 || entry.size > 512) return {};
    fd = fs.openSync(receiptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
        info.size < 1 || info.size > 512) return {};
    const bytes = Buffer.alloc(513);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 512) return {};
    const receipt = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    if (receipt?.v !== 1 || typeof receipt.session_key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.session_key) ||
        !['open', 'close', 'version', 'other'].includes(receipt.action) ||
        !['started', 'completed'].includes(receipt.phase) ||
        !Number.isSafeInteger(receipt.at) || receipt.at < 0) return {};
    const age = Date.now() - receipt.at;
    return {
      wrapper_receipt_version: 1,
      wrapper_action: receipt.action,
      wrapper_phase: receipt.phase,
      wrapper_exit: receipt.phase === 'started' ? 'none' :
        Number.isInteger(receipt.exit) && receipt.exit >= 0 && receipt.exit <= 255 ? receipt.exit : 'other',
      wrapper_session_matches: receipt.session_key === createHash('sha256').update(name, 'utf8').digest('hex'),
      wrapper_age: age < 0 ? 'unknown' : age < 10000 ? 'lt10s' : age < 60000 ? 'lt60s' : age < 300000 ? 'lt5m' : 'older',
    };
  } catch { return {}; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
/** Finish with the original daemon status even when optional diagnostics cannot be written. */
function finish(code, value) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (socket) socket.destroy();
  if (code !== 0) {
    const receipt = wrapperReceipt();
    if (receipt.wrapper_receipt_version === 1) value = { ...value, ...receipt };
  }
  if (value !== undefined) {
    if (code === 0) process.stdout.write(JSON.stringify(value));
    else { try { process.stdout.write(JSON.stringify(value)); } catch {} }
  }
  process.exit(code);
}
try {
  if (!directory || path.dirname(directory) !== '/dev/shm' ||
      !/^hackerai-browser-[a-zA-Z0-9-]+$/.test(path.basename(directory)) ||
      typeof name !== 'string' || !name || name.length > 80 || /[/\x00\r\n]/.test(name)) {
    throw new Error();
  }
  argumentsValid = true;
  precondition = 'root_stat';
  const root = fs.lstatSync(directory);
  rootInfo = root;
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
