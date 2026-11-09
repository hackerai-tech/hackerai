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
export const BROWSER_OPEN_IDLE_ENV_VALUES = [
  "unset",
  "disabled",
  "lt_15m",
  "15m",
  "gt_15m",
  "unparsed",
] as const;

export const BROWSER_DAEMON_DEADLINE_PHASES = [
  "connecting",
  "awaiting_response",
  "partial_response",
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
// Socket progress only: a queued write is not a daemon acknowledgement.
let deadlinePhase = 'connecting';
/** Read only a bounded owned private file; never follow links or block on pipes. */
function readReceipt(filename) {
  let fd;
  try {
    const receiptPath = path.join(directory, filename);
    const entry = fs.lstatSync(receiptPath);
    if (!entry.isFile() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0 ||
        entry.size < 1 || entry.size > 512) throw new Error();
    fd = fs.openSync(receiptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
        info.size < 1 || info.size > 512) throw new Error();
    const bytes = Buffer.alloc(513);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 512) throw new Error();
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
function validReceipt(receipt) {
  return receipt?.v === 1 && typeof receipt.session_key === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.session_key) &&
    ['open', 'close', 'version', 'other'].includes(receipt.action) &&
    ['started', 'completed'].includes(receipt.phase) &&
    Number.isSafeInteger(receipt.at) && receipt.at >= 0;
}
function receiptAge(at) {
  const age = Date.now() - at;
  return age < 0 ? 'unknown' : age < 10000 ? 'lt10s' : age < 60000 ? 'lt60s' : age < 300000 ? 'lt5m' : 'older';
}
function receiptExit(receipt) {
  return receipt.phase === 'started' ? 'none' :
    Number.isInteger(receipt.exit) && receipt.exit >= 0 && receipt.exit <= 255 ? receipt.exit : 'other';
}
/** Return finite observations only; session keys and private paths stay local. */
function wrapperReceipt() {
  try {
    if (!argumentsValid || !rootInfo?.isDirectory() || rootInfo.uid !== process.getuid() ||
        (rootInfo.mode & 0o077) !== 0 || typeof fs.constants?.O_NOFOLLOW !== 'number' ||
        typeof fs.constants.O_NONBLOCK !== 'number') return {};
    const receipt = readReceipt('wrapper-receipt.json');
    if (!validReceipt(receipt)) return {};
    const sessionKey = createHash('sha256').update(name, 'utf8').digest('hex');
    let result = {
      wrapper_receipt_version: 1,
      wrapper_action: receipt.action,
      wrapper_phase: receipt.phase,
      wrapper_exit: receiptExit(receipt),
      wrapper_session_matches: receipt.session_key === sessionKey,
      wrapper_age: receiptAge(receipt.at),
      open_receipt_version: 1,
      // Older workers do not write the sticky receipt; absence is not no-open evidence.
      open_receipt_status: receipt.open_receipt_support === 1 ? 'not_observed' : 'unavailable',
    };
    const history = receipt.history;
    if (Array.isArray(history) && history.length === 3 && history[0] === 1 &&
        typeof history[1] === 'boolean' && typeof history[2] === 'boolean' &&
        (!history[2] || history[1])) result.history = history;
    let open;
    if (receipt.open_receipt_support === 1) {
      try {
        const candidate = readReceipt('open-receipt.json');
        if (!validReceipt(candidate) || candidate.action !== 'open') throw new Error();
        open = candidate;
        result = { ...result, open_receipt_status: 'recorded',
          open_phase: open.phase, open_exit: receiptExit(open),
          open_session_matches: open.session_key === sessionKey, open_age: receiptAge(open.at) };
      } catch (error) {
        // Missing/unreadable records are censored observations, never proof no CLI ran.
        result.open_receipt_status = error?.code === 'ENOENT' ? 'not_observed' : 'unreadable';
      }
    }
    // Compact internal tuple keeps combined failure JSON below the existing 512-byte cap.
    // [version, status, phase, exit, scope, age, close/open timestamp order].
    result.close_receipt = [1, 'unavailable'];
    if (receipt.close_receipt_support === 1) {
      try {
        const close = readReceipt('close-receipt.json');
        if (!validReceipt(close) || close.action !== 'close' || typeof close.close_all !== 'boolean') throw new Error();
        const scope = close.close_all ? 'all_sessions' : close.session_key === sessionKey ? 'selected_session' : 'other_session';
        const order = open?.session_key === sessionKey && scope !== 'other_session' ?
          close.at > open.at ? 'after' : close.at < open.at ? 'before' : 'same_time' : 'unavailable';
        result.close_receipt = [1, 'recorded', close.phase, receiptExit(close),
          scope, receiptAge(close.at), order];
      } catch (error) {
        result.close_receipt = [1, error?.code === 'ENOENT' ? 'not_observed' : 'unreadable'];
      }
    }
    // Sticky open declaration only; later version/status commands can have a
    // different environment. This is not an effective daemon policy or cause.
    if (open?.session_key === sessionKey && open.idle_env_version === 1 &&
        ['unset', 'disabled', 'lt_15m', '15m', 'gt_15m', 'unparsed'].includes(open.idle_env)) {
      result.open_idle = [1, open.idle_env];
    }
    return result;
  } catch { return {}; }
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
  timer = setTimeout(() => finish(3, { deadline: [1, deadlinePhase] }), 6000);
  socket = net.createConnection(address);
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    deadlinePhase = 'awaiting_response';
    socket.write(JSON.stringify({ ...request, id }) + '\n');
  });
  socket.on('data', chunk => {
    if (chunk.length > 0) deadlinePhase = 'partial_response';
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
