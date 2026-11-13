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

// Wire status codes correspond to these indexes; version1 measures the optional
// CLI check at root preparation, not the running daemon or its effective policy.
export const BROWSER_CLI_AT_PREPARE_STATUSES = [
  "unavailable",
  "measured",
  "not_checked",
  "unparsed",
  "check_failed",
] as const;

// Wire code w1 is the index. Procfs visibility of the started wrapper's exact
// PID/start-tick incarnation; not execution, daemon identity/health or a cause.
export const BROWSER_WRAPPER_PROCESS_VISIBILITIES = [
  "unavailable",
  "not_found",
  "incarnation_changed",
  "same_incarnation_visible",
  "same_incarnation_zombie",
  "permission",
  "other",
] as const;

// Wire code os1 is the index. One lstat of the selected socket when that same
// OPEN returned 0, not at capture time; not daemon health, idle state or a cause.
export const BROWSER_OPEN_SOCKET_RETURN_STATUSES = [
  "unavailable",
  "owned_socket",
  "missing",
  "invalid",
  "unreadable",
] as const;

// Wire code k1 is the index. The latest wrapped command's declared first verb
// token category; not its execution, the daemon's active command or a cause.
export const BROWSER_WRAPPER_COMMAND_CLASSES = [
  "wait",
  "snapshot",
  "screenshot",
  "open",
  "close",
  "version",
  "other",
  "unparsed",
] as const;

// Wire tuple dv status codes are the indexes. The selected daemon's .version
// sidecar declaration, distinct from the CLI-at-prepare check; not daemon identity or health.
export const BROWSER_DAEMON_VERSION_FILE_STATUSES = [
  "unavailable",
  "measured",
  "missing",
  "unreadable",
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
/** Read one selected PID sidecar; never scan processes, signal them, or export its value.
 * Visibility is only in this helper's procfs view, not PID-namespace or daemon identity/health.
 */
function daemonProcess() {
  let fd;
  try {
    const sockets = fs.lstatSync(path.join(directory, 'sockets'));
    if (!sockets.isDirectory() || sockets.uid !== process.getuid() || (sockets.mode & 0o077) !== 0)
      return [1, 2, 0];
    const filename = path.join(directory, 'sockets', name + '.pid');
    const valid = entry => entry.isFile() && entry.uid === process.getuid() &&
      (entry.mode & 0o022) === 0 && entry.size >= 1 && entry.size <= 32;
    const entry = fs.lstatSync(filename);
    if (!valid(entry)) return [1, 2, 0];
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!valid(fs.fstatSync(fd))) return [1, 2, 0];
    const bytes = Buffer.alloc(33);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 32) return [1, 2, 0];
    const text = bytes.subarray(0, size).toString('utf8').trim();
    if (!/^[1-9][0-9]{0,9}$/.test(text)) return [1, 1, 0];
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) return [1, 1, 0];
    if (process.platform !== 'linux') return [1, 3, 0];
    // An unavailable procfs view cannot establish an absent process entry.
    try { if (!fs.statSync('/proc').isDirectory()) return [1, 3, 0]; } catch { return [1, 3, 0]; }
    try {
      const info = fs.statSync('/proc/' + pid);
      return [1, 3, info.uid === process.getuid() ? 2 : 3];
    } catch (error) {
      return [1, 3, error?.code === 'ENOENT' ? 1 :
        error?.code === 'EACCES' || error?.code === 'EPERM' ? 4 : 5];
    }
  } catch (error) {
    return [1, error?.code === 'ENOENT' ? 0 : 2, 0];
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
/** Read the selected daemon's startup .version declaration beside its socket: one
 * bounded owned plaintext file, never a link or pipe. Returns [1, status(, packed
 * semver)] or undefined outside an owned private sockets directory. Not daemon identity.
 */
function daemonVersionFile() {
  let fd;
  try {
    const sockets = fs.lstatSync(path.join(directory, 'sockets'));
    if (!sockets.isDirectory() || sockets.uid !== process.getuid() || (sockets.mode & 0o077) !== 0) return;
  } catch { return; }
  try {
    const filename = path.join(directory, 'sockets', name + '.version');
    const valid = entry => entry.isFile() && entry.uid === process.getuid() &&
      (entry.mode & 0o022) === 0 && entry.size >= 0 && entry.size <= 32;
    if (!valid(fs.lstatSync(filename))) return [1, 3];
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!valid(fs.fstatSync(fd))) return [1, 3];
    const bytes = Buffer.alloc(33);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 32) return [1, 3];
    const version = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(
      bytes.subarray(0, size).toString('utf8').trim());
    if (!version) return [1, 4];
    return [1, 1, Number(version[1]) * 1000000 + Number(version[2]) * 1000 + Number(version[3])];
  } catch (error) {
    return [1, error?.code === 'ENOENT' ? 2 : typeof error?.code === 'string' ? 3 : 0];
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
const uint64 = text => /^(0|[1-9][0-9]{0,19})$/.test(text) && (text.length < 20 || text <= '18446744073709551615');
/** Compare the started wrapper's private [1, PID, start ticks] with one bounded
 * procfs stat read; never scan or signal processes or export the PID, ticks or name.
 */
function wrapperProcess(identity) {
  let fd;
  if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== 1 ||
      !Number.isSafeInteger(identity[1]) || identity[1] < 1 || identity[1] > 2147483647 ||
      typeof identity[2] !== 'string' || !uint64(identity[2])) return 0;
  // Without a verified procfs view an absent entry cannot establish an exit.
  try {
    if (process.platform !== 'linux' || typeof fs.statfsSync !== 'function' ||
        fs.statfsSync('/proc').type !== 0x9fa0) return 0;
  } catch { return 0; }
  try {
    fd = fs.openSync('/proc/' + identity[1] + '/stat',
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    // Only this UID's own regular stat file is read; another user's bytes never are.
    if (!info.isFile() || info.uid !== process.getuid()) return 6;
    const bytes = Buffer.alloc(4097);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 4096) return 6;
    // The command name can contain spaces and parentheses; fields follow the last ')'.
    const text = bytes.subarray(0, size).toString('latin1');
    const head = text.indexOf(' (');
    const close = text.lastIndexOf(')');
    const fields = close > head ? text.slice(close + 1).trim().split(' ') : [];
    if (head < 1 || text.slice(0, head) !== String(identity[1]) || fields.length < 20 ||
        !/^[A-Za-z]$/.test(fields[0]) || !uint64(fields[19])) return 6;
    if (fields[19] !== identity[2]) return 2;
    return fields[0] === 'Z' ? 4 : 3;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ESRCH' ? 1 :
      error?.code === 'EACCES' || error?.code === 'EPERM' ? 5 : 6;
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
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
    // Only the selected session's still-STARTED wrapper has a meaningful incarnation.
    if (receipt.phase === 'started' && receipt.session_key === sessionKey)
      result.w1 = wrapperProcess(receipt.process);
    // Declared first-verb category of this latest command; older writers omit it.
    if (Number.isInteger(receipt.k1) && receipt.k1 >= 0 && receipt.k1 <= 7) result.k1 = receipt.k1;
    const history = receipt.history;
    if (Array.isArray(history) && history.length === 3 && history[0] === 1 &&
        typeof history[1] === 'boolean' && typeof history[2] === 'boolean' &&
        (!history[2] || history[1])) {
      // Compact version1 history preserves the existing receipt-context budget.
      // Bit1: other CLI returned; bit2: an option-prefixed CLI returned (implies bit1).
      result.h1 = (history[1] ? 1 : 0) + (history[2] ? 2 : 0);
    }
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
    // Compact internal tuple leaves room for the process/CLI failure context.
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
    // Only a matching successful OPEN makes this the selected daemon's sidecar.
    // Compact tuple: v1, PID-file status, process visibility (finite codes only).
    if (open?.session_key === sessionKey && open.phase === 'completed' && open.exit === 0) {
      result.p1 = daemonProcess();
      // Recorded with this same OPEN's return; older writers omit it.
      if (Number.isInteger(open.os1) && open.os1 >= 0 && open.os1 <= 4) result.os1 = open.os1;
      const declared = daemonVersionFile();
      if (declared) result.dv = declared;
    }
    return result;
  } catch { return {}; }
}
/** Read the finite preparation tuple independently of optional wrapper history. */
function cliAtPrepare() {
  try {
    if (!argumentsValid || !rootInfo?.isDirectory() || rootInfo.uid !== process.getuid() ||
        (rootInfo.mode & 0o077) !== 0 || typeof fs.constants?.O_NOFOLLOW !== 'number' ||
        typeof fs.constants.O_NONBLOCK !== 'number') return;
    const r = readReceipt('cli-at-prepare.json');
    if (!Array.isArray(r) || r[0] !== 1 || !Number.isInteger(r[1]) || r[1] < 0 || r[1] > 4 ||
        (r[1] === 1 ? r.length !== 3 || !Number.isInteger(r[2]) || r[2] < 0 || r[2] > 999999999 : r.length !== 2)) throw new Error();
    return r;
  } catch { return [1, 0]; }
}
/** Read one bounded owned decimal sidecar beside the selected socket; never a link or pipe. */
function ownedInteger(filename, max) {
  let fd;
  try {
    const valid = entry => entry.isFile() && entry.uid === process.getuid() &&
      (entry.mode & 0o022) === 0 && entry.size >= 1 && entry.size <= 11;
    if (!valid(fs.lstatSync(filename))) return;
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!valid(fs.fstatSync(fd))) return;
    const bytes = Buffer.alloc(12);
    const text = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('latin1');
    const value = /^[1-9][0-9]{0,9}\n?$/.test(text) ? Number(text.trim()) : 0;
    return value <= max ? value : 0;
  } catch { return 0; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
/** Read one fixed procfs network table, refusing a truncated view beyond 256 KiB. */
function procTable(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return;
    const bytes = Buffer.alloc(262145);
    let size = 0;
    for (let count; (count = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0;)
      if ((size += count) > 262144) return;
    return bytes.subarray(0, size).toString('latin1').split('\n');
  } catch { return; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
/** Return the selected daemon's recorded preview port only when the same live PID
 * holds both the selected Unix listener and the loopback TCP listener on that port.
 * Any doubt returns 0 so the original daemon request runs. Paths, PIDs, inodes and
 * table rows stay local; this proves no connection, health or freshness.
 */
function ownedStreamPort(root, sockets, address) {
  try {
    if (process.platform !== 'linux' || typeof fs.constants?.O_NOFOLLOW !== 'number' ||
        typeof fs.constants.O_NONBLOCK !== 'number' || typeof fs.statfsSync !== 'function' ||
        [root, sockets].some(item => (item.mode & 0o077) !== 0) ||
        fs.statfsSync('/proc').type !== 0x9fa0) return 0;
    const port = ownedInteger(path.join(directory, 'sockets', name + '.stream'), 65535);
    const pid = ownedInteger(path.join(directory, 'sockets', name + '.pid'), 4194304);
    if (!port || !pid || fs.statSync('/proc/' + pid).uid !== process.getuid()) return 0;
    // Accepted connections inherit the listener's path; only listeners carry ACCEPTCON.
    // The path follows the inode and may contain spaces.
    const unix = procTable('/proc/net/unix')?.map(row =>
      /^[0-9a-fA-F]+: [0-9A-F]{8} [0-9A-F]{8} 00010000 0001 01 +([0-9]+) (.*)$/.exec(row))
      .filter(row => row?.[2] === address);
    // procfs prints IPv4 addresses in host byte order.
    const loopback = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? '0100007F' : '7F000001';
    const local = loopback + ':' + port.toString(16).toUpperCase().padStart(4, '0');
    const tcp = procTable('/proc/net/tcp')?.map(row => row.trim().split(/ +/))
      .filter(fields => /^[0-9]+:$/.test(fields[0]) && fields[1] === local && fields[3] === '0A');
    if (unix?.length !== 1 || tcp?.length !== 1 || !/^[0-9]+$/.test(tcp[0][9] ?? '')) return 0;
    const wanted = new Set(['socket:[' + unix[0][1] + ']', 'socket:[' + tcp[0][9] + ']']);
    let fds;
    try {
      fds = fs.opendirSync('/proc/' + pid + '/fd');
      for (let count = 0, entry; count < 256 && (entry = fds.readSync()); count++) {
        if (!/^[0-9]+$/.test(entry.name)) return 0;
        wanted.delete(fs.readlinkSync('/proc/' + pid + '/fd/' + entry.name));
        if (wanted.size === 0) return port;
      }
    } finally { if (fds) { try { fds.closeSync(); } catch {} } }
  } catch {}
  return 0;
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
    const cli = cliAtPrepare();
    if (cli) value = { ...value, cv: cli };
    // Optional codes never displace existing context at the parser cap; the
    // newest is dropped first.
    if (value?.dv !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.dv;
    if (value?.k1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.k1;
    if (value?.os1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.os1;
    if (value?.w1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.w1;
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
  // The internal opt-in never reaches the daemon.
  const { owned_port: ownedPort, ...request } = JSON.parse(payload);
  if (!['stream_status', 'screenshot', 'viewport'].includes(request.action)) throw new Error();
  const id = 'hackerai-preview';
  // A non-fresh preview may skip the serialized daemon queue only with listener proof.
  const port = ownedPort === true && request.action === 'stream_status' ?
    ownedStreamPort(root, sockets, address) : 0;
  if (port) finish(0, { id, success: true, data: { port } });
  else {
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
  }
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
  // owned_port lets the helper prove the port from the daemon's own listeners;
  // the helper strips it and falls back to this same daemon request otherwise.
  | { action: "stream_status"; owned_port?: true }
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
