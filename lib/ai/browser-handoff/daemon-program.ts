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

// Wire code o1 is the index (bit1 help, bit2 version). Exact informational tokens
// declared in that same OPEN's arguments; not its effective CLI result or daemon state.
export const BROWSER_OPEN_INFO_FLAGS = [
  "none",
  "help",
  "version",
  "help_and_version",
] as const;

// Wire code sd1 is the index. That same plain OPEN's own AGENT_BROWSER_SOCKET_DIR
// declaration, recorded only when its selected socket was missing at return:
// exactly this root's managed directory, unset/empty, or any other value. Not the
// value, where the CLI or daemon actually routed, or whether a daemon ran.
export const BROWSER_OPEN_SOCKET_DIRECTORY_DECLARATIONS = [
  "managed_directory",
  "unset_or_empty",
  "different_directory",
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

// Wire tuple l1 codes are the indexes. The selected session's latest returned
// wrapped CLI process and its wrapper-measured elapsed time: its own when the
// receipt is COMPLETED, the immediately preceding wrapper's when STARTED. Not a
// compound shell result, daemon/CDP state or a capture cause.
export const BROWSER_WRAPPER_RESULTS = [
  "exit_zero",
  "exit_nonzero",
  "signal",
  "verification_gate",
] as const;
export const BROWSER_WRAPPER_RESULT_ELAPSED = [
  "lt1s",
  "lt10s",
  "lt30s",
  "lt60s",
  "lt5m",
  "older",
] as const;

// Wire code cp1 is the index. Only an opted-in recognize_closed status without
// owned_port whose selected socket lstat found no entry (exit2 socket_stat
// missing): the first check of the existing close-proof verification that
// refused it, in that one call. Absent proof includes older wrappers and closes
// that earned none; superseded means the selection is no longer the proof's
// linked private inode; out_of_scope means the root or sockets directory is
// not owned and private. Not whether a close ran, a cause, or any path, name or
// inode. Absent is unmeasured (older helper, budget or an unclassified error).
export const BROWSER_CLOSE_PROOF_FAILURES = [
  "proof_absent",
  "proof_invalid",
  "proof_mismatch",
  "socket_reappeared",
  "selection_missing",
  "selection_superseded",
  "unreadable",
  "out_of_scope",
  "selection_invalid",
] as const;

export const BROWSER_DAEMON_DEADLINE_PHASES = [
  "connecting",
  "awaiting_response",
  "partial_response",
] as const;

// Wire tuple r1 code is the index. Which check refused the daemon's first
// response line at exit5; never its data, error, body or ID, and not a cause.
export const BROWSER_DAEMON_RESPONSE_VALIDATIONS = [
  "invalid_json",
  "invalid_envelope",
  "id_mismatch",
  "success_false",
  "success_other",
] as const;

// Wire tuple s1 code is the index. The screenshot action's success_false error
// matched against fixed agent-browser literals/prefixes: the upstream message
// family, not a transport, errno or cause. Never the error text or its suffix.
export const BROWSER_DAEMON_SCREENSHOT_REFUSALS = [
  "browser_not_launched",
  "no_active_page",
  "decode_failed",
  "save_failed",
  "other_or_unavailable",
] as const;

/**
 * Opt-in status progress on stderr: only a stream_status request carrying the
 * internal observe_progress flag writes fixed frames "hp1:<letter>\n", each at
 * most once and in this order: e entered the helper, c initialized its socket
 * path with its own 6s deadline armed, w reached the local write-attempt
 * boundary (not daemon receipt), then the helper-selected disposition (not
 * actual exit delivery) immediately before its unchanged stdout and exit:
 * s exit0 (including an open deferral at its deadline), d its own deadline
 * (exit3), o any other exit. These are the only
 * complete sequences the helper can write, keyed by their letters. Frames are
 * dropped under backpressure, so a missing frame was not delivered, not
 * proven absent.
 */
export const BROWSER_DAEMON_PROGRESS_FRAMES = /^(?:hp1:[ecwsdo]\n){0,4}$/;
export const BROWSER_DAEMON_PROGRESS_SEQUENCES = {
  "": "none_delivered",
  e: "entered",
  ec: "connecting",
  ecw: "write_attempted",
  es: "entered_success",
  eo: "entered_other",
  ecd: "connecting_deadline",
  eco: "connecting_other",
  ecws: "write_success",
  ecwd: "write_deadline",
  ecwo: "write_other",
} as const;

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
let socketsInfo;
// Socket progress only: a queued write is not a daemon acknowledgement.
let deadlinePhase = 'connecting';
// Only a stream_status request whose selected socket lstat found no entry.
let statusSocketMissing = false;
// The selected socket's lstat at start, for listener-queue drift checks.
let selectedSocketInfo;
// Only a connected status/screenshot request at its original deadline.
let queueSnapshot = false;
// Only an opted-in fresh stream_status (never a screenshot or owned-port lookup).
let deferOpen = false;
// Only that opted-in status beside the selected still-running plain OPEN: one bounded
// sample taken before this helper connects, compared once at its own deadline. Local only.
let preconnect;
// Only a recognize_closed screenshot: this guest's wall-clock ms just before its
// one local write attempt (not daemon receipt). Compared locally, never exported.
let screenshotWriteAt;
// Only the internal opted-in status request writes progress frames: constant
// bytes, never caller data. A write to fd 2 blocks on a full Linux pipe, so
// frames go only to this helper's own O_NONBLOCK open of that same stderr FIFO;
// fd 2 and its shared flags stay untouched. A TTY, regular file or socket gets
// no frames, and a full pipe (EAGAIN), absent reader or any failure drops the
// frame. Never flushed or awaited, so the helper's schedule is unchanged.
let progressFd;
try {
  const opted = JSON.parse(payload);
  if (opted?.observe_progress === true && opted.action === 'stream_status' &&
      process.platform === 'linux' && typeof fs.constants?.O_WRONLY === 'number' &&
      typeof fs.constants.O_NONBLOCK === 'number') {
    const target = fs.fstatSync(2);
    if (target.isFIFO()) {
      // A nonblocking FIFO open never waits for a reader (ENXIO instead).
      const fd = fs.openSync('/proc/self/fd/2', fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      const own = fs.fstatSync(fd);
      if (own.isFIFO() && own.dev === target.dev && own.ino === target.ino) progressFd = fd;
      else fs.closeSync(fd);
    }
  }
} catch {}
function mark(letter) {
  if (progressFd === undefined) return;
  // Six bytes, under PIPE_BUF: a nonblocking pipe write is whole or EAGAIN, never partial.
  try { fs.writeSync(progressFd, 'hp1:' + letter + '\n'); } catch {}
}
mark('e');
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
/** After a queue sample beside a STARTED plain OPEN, reread each bounded receipt once.
 * True only when both still show that same selected STARTED invocation (action, timestamp,
 * the wrapper's PID/start identity, the sticky plain flag) and its exact incarnation is
 * still visible. The wrapper records completion before its process exits, so liveness
 * alone cannot show the OPEN was still running. These are consistent observations before
 * and after the sample, not an always-unique timestamp or a cause. Any doubt is false.
 */
function openStillStarted(before, sessionKey) {
  try {
    const latest = readReceipt('wrapper-receipt.json');
    const sticky = readReceipt('open-receipt.json');
    const identity = latest?.process;
    return validReceipt(latest) && latest.action === 'open' && latest.phase === 'started' &&
      latest.session_key === sessionKey && latest.at === before.at &&
      Array.isArray(identity) && Array.isArray(before.process) && identity.length === 3 &&
      before.process.length === 3 && identity.every((value, index) => value === before.process[index]) &&
      validReceipt(sticky) && sticky.action === 'open' && sticky.phase === 'started' &&
      sticky.session_key === sessionKey && sticky.at === before.at && sticky.o1 === 0 &&
      wrapperProcess(identity) === 3;
  } catch { return false; }
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
    // Selected session only: [1, result, elapsed] of its latest returned wrapper.
    // Older writers omit it; it is unmeasured, never a failure or completion.
    const last = receipt.lr;
    if (receipt.session_key === sessionKey && Array.isArray(last) && last.length === 3 && last[0] === 1 &&
        Number.isInteger(last[1]) && last[1] >= 0 && last[1] <= 3 &&
        Number.isInteger(last[2]) && last[2] >= 0 && last[2] <= 5) result.l1 = [1, last[1], last[2]];
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
      // That OPEN's declared help(1)/version(2) tokens; not its effective result.
      if (Number.isInteger(open.o1) && open.o1 >= 0 && open.o1 <= 3) result.o1 = open.o1;
      // That plain OPEN's socket-directory declaration, beside this current missing socket only.
      if (statusSocketMissing && open.os1 === 2 && open.o1 === 0 &&
          Number.isInteger(open.sd1) && open.sd1 >= 0 && open.sd1 <= 2) result.sd1 = open.sd1;
      const declared = daemonVersionFile();
      if (declared) result.dv = declared;
      if (queueSnapshot) {
        const queue = listenerQueue();
        if (queue) {
          result.q1 = queueTuple(queue);
          // e1: an opted-in status's deadline with none pending and at least two held, beside
          // the selected session's live STARTED other wrapper that declared a plain eval
          // (k1 6). One reread after the sample must still show that same record and exact
          // incarnation live; a completed, replaced or foreign receipt omits it. A declaration,
          // not the daemon's active command, its progress or a cause; never the argument.
          if (deferOpen && queue.pending === 0 && queue.held.size >= 2 && receipt.action === 'other' &&
              receipt.phase === 'started' && receipt.session_key === sessionKey && result.w1 === 3 &&
              receipt.k1 === 6 && receipt.e1 === 1) {
            try {
              const latest = readReceipt('wrapper-receipt.json');
              const identity = latest?.process;
              if (validReceipt(latest) && latest.action === 'other' && latest.phase === 'started' &&
                  latest.session_key === sessionKey && latest.at === receipt.at && latest.k1 === 6 &&
                  latest.e1 === 1 && Array.isArray(identity) && identity.length === 3 &&
                  identity.every((value, index) => value === receipt.process[index]) &&
                  wrapperProcess(identity) === 3) result.e1 = 1;
            } catch {}
          }
        }
      }
    } else if (queueSnapshot && receipt.action === 'open' && receipt.phase === 'started' &&
        receipt.session_key === sessionKey && result.w1 === 3 && open?.session_key === sessionKey &&
        open.phase === 'started' && open.at === receipt.at && open.o1 === 0) {
      // The selected plain OPEN observed STARTED before and after the sample, never a
      // cause or navigation. q1 is dropped first at the cap, so the fields scoping it remain.
      const queue = listenerQueue();
      if (queue && openStillStarted(receipt, sessionKey)) {
        result.q1 = queueTuple(queue);
        // ph1: an opted-in status's sole held connection here, beside at least one pending,
        // was already held (1) or not (2) at the pre-connect sample. Both samples matched the
        // selected socket's start lstat and share the daemon PID, listener and this exact
        // STARTED OPEN invocation. Not which client it is, request acceptance or a cause;
        // never the inodes. Any unverified sample omits it.
        const before = preconnect;
        if (deferOpen && before && queue.held.size === 1 && queue.pending >= 1 &&
            before.queue.pid === queue.pid && before.queue.listener === queue.listener &&
            before.receipt.at === receipt.at &&
            before.receipt.process.every((value, index) => value === receipt.process[index]))
          result.ph1 = before.queue.held.has([...queue.held][0]) ? 1 : 2;
        // ot1: that exact OPEN's wrapper STARTED record (truncated ms, same guest clock)
        // relative to this screenshot's local write attempt: 1 before, 2 after. A tie is
        // omitted. Not daemon receipt or order, file state or a cause; never the values.
        if (Number.isSafeInteger(screenshotWriteAt) && receipt.at !== screenshotWriteAt)
          result.ot1 = receipt.at < screenshotWriteAt ? 1 : 2;
      }
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
/** Wire tuple q1 [1, pending, held], each saturated at 15, beside the selected session's
 * completed successful OPEN or its same still-running plain OPEN wrapper: rows on the selected
 * path besides its listener, sampled once after the original deadline, before this
 * helper closes its own connection, so the counts may include it. Pending: an unaccepted
 * stream connection (flags 0, state 02, no inode). Held: an accepted connection
 * (flags 0, state 03) whose exact inode the selected daemon PID holds; a client
 * may already have closed it. Visible sockets only, not request acceptance, the
 * lock holder, Chromium state or a cause. Requires the same daemon PID to hold the
 * one selected listener; a bound, other-state, unowned, truncated, slow or drifting
 * view returns undefined. Returns the local PID, listener inode, pending count and held
 * inode set; only queueTuple's counts leave. Paths, PIDs, inodes and rows stay local.
 */
function listenerQueue(budget = 200000000n) {
  try {
    const started = process.hrtime.bigint();
    const late = () => process.hrtime.bigint() - started > budget;
    if (process.platform !== 'linux' || typeof fs.constants?.O_NOFOLLOW !== 'number' ||
        typeof fs.constants.O_NONBLOCK !== 'number' || typeof fs.statfsSync !== 'function' ||
        [rootInfo, socketsInfo].some(item => !item?.isDirectory() || item.uid !== process.getuid() ||
          (item.mode & 0o077) !== 0) ||
        !selectedSocketInfo?.isSocket() || selectedSocketInfo.uid !== process.getuid() ||
        fs.statfsSync('/proc').type !== 0x9fa0) return;
    const address = path.join(directory, 'sockets', name + '.sock');
    const pidPath = path.join(directory, 'sockets', name + '.pid');
    const pid = ownedInteger(pidPath, 4194304);
    if (!pid || fs.statSync('/proc/' + pid).uid !== process.getuid()) return;
    const rows = procTable('/proc/net/unix');
    if (!rows || late()) return;
    let listener;
    let pending = 0;
    const held = new Set();
    for (const row of rows) {
      // The path follows the inode and may contain spaces; only the exact selected path.
      const match = /^[0-9a-fA-F]+: [0-9A-F]{8} [0-9A-F]{8} ([0-9A-F]{8}) ([0-9A-F]{4}) ([0-9A-F]{2}) +(0|[1-9][0-9]{0,19}) (.*)$/.exec(row);
      if (match?.[5] !== address) continue;
      const [, flags, type, state, inode] = match;
      if (type !== '0001') return;
      if (flags === '00010000' && state === '01' && inode !== '0' && listener === undefined) listener = inode;
      else if (flags === '00000000' && state === '02' && inode === '0') pending++;
      else if (flags === '00000000' && state === '03' && inode !== '0' && !held.has(inode)) held.add(inode);
      else return;
    }
    if (listener === undefined) return;
    const wanted = new Set([listener, ...held].map(inode => 'socket:[' + inode + ']'));
    let fds;
    try {
      fds = fs.opendirSync('/proc/' + pid + '/fd');
      for (let count = 0, entry; wanted.size > 0 && count < 256 && (entry = fds.readSync()); count++) {
        if (!/^[0-9]+$/.test(entry.name) || late()) return;
        wanted.delete(fs.readlinkSync('/proc/' + pid + '/fd/' + entry.name));
      }
    } finally { if (fds) { try { fds.closeSync(); } catch {} } }
    if (wanted.size > 0) return;
    // A replaced socket or PID sidecar, or another process owner, is visible drift.
    const current = fs.lstatSync(address);
    if (!current.isSocket() || current.uid !== process.getuid() || current.dev !== selectedSocketInfo.dev ||
        current.ino !== selectedSocketInfo.ino || ownedInteger(pidPath, 4194304) !== pid ||
        fs.statSync('/proc/' + pid).uid !== process.getuid() || late()) return;
    return { pid, listener, pending, held };
  } catch {}
}
const queueTuple = queue => [1, Math.min(queue.pending, 15), Math.min(queue.held.size, 15)];
/** Before connecting, an opted-in status samples the selected daemon's accepted connections
 * once with the deadline scanner and a 20 ms budget, only between two checks that the selected
 * session's same plain OPEN is still STARTED with its exact wrapper incarnation live. Keeps
 * that receipt and the local sample; any doubt or a late sample is undefined. Never exported.
 */
function preconnectQueue() {
  try {
    const started = process.hrtime.bigint();
    if (!argumentsValid || !rootInfo?.isDirectory() || rootInfo.uid !== process.getuid() ||
        (rootInfo.mode & 0o077) !== 0 || typeof fs.constants?.O_NOFOLLOW !== 'number' ||
        typeof fs.constants.O_NONBLOCK !== 'number') return;
    const receipt = readReceipt('wrapper-receipt.json');
    const sessionKey = createHash('sha256').update(name, 'utf8').digest('hex');
    if (!validReceipt(receipt) || receipt.action !== 'open' || receipt.phase !== 'started' ||
        receipt.session_key !== sessionKey || receipt.open_receipt_support !== 1 ||
        !openStillStarted(receipt, sessionKey)) return;
    const queue = listenerQueue(20000000n);
    if (queue && openStillStarted(receipt, sessionKey) &&
        process.hrtime.bigint() - started <= 20000000n) return { queue, receipt };
  } catch {}
}
/** Only the selected session's still-STARTED WAIT whose exact wrapper incarnation
 * is visible and not a zombie; any missing, other or uncertain observation is false.
 * Proves no daemon progress, health or freshness.
 */
function activeWait() {
  const wrapper = wrapperReceipt();
  return wrapper.wrapper_phase === 'started' && wrapper.wrapper_session_matches === true &&
    wrapper.w1 === 3 && wrapper.k1 === 0;
}
/** Only an opted-in status or screenshot request whose selected owned socket is absent: true
 * when the wrapper's private close proof links to the still-current selection inode for this
 * exact name. The proof stays pinned by its descriptor, so a replaced proof cannot alias a reused
 * inode; with it pinned the socket is absent again and the selection is unchanged, so no
 * later command has started. Never exports the name, path or inode; any doubt is false.
 * Past the opt-in, a false result also records its first refusing check in closeProofFailure
 * (a BROWSER_CLOSE_PROOF_FAILURES index) from these same calls; the result is unchanged.
 */
let closeProofFailure;
function sessionClosed() {
  let fd;
  // Which check is running, for classifying a thrown error; undefined before the opt-in.
  let step;
  const refuse = code => { closeProofFailure = code; return false; };
  try {
    const opted = JSON.parse(payload);
    if (opted?.recognize_closed !== true || !['stream_status', 'screenshot'].includes(opted.action)) return false;
    step = 'scope';
    if (!argumentsValid || typeof fs.constants?.O_NOFOLLOW !== 'number' || typeof fs.constants.O_NONBLOCK !== 'number' ||
        [rootInfo, socketsInfo].some(item => !item?.isDirectory() || item.uid !== process.getuid() ||
          (item.mode & 0o077) !== 0)) return refuse(7);
    const uid = BigInt(process.getuid());
    // BigInt identities: large inode numbers can collide as Numbers.
    const valid = entry => entry.isFile() && entry.uid === uid && (entry.mode & 0o077n) === 0n &&
      entry.size >= 1n && entry.size <= 512n;
    const proofPath = path.join(directory, 'closed-session');
    step = 'proof';
    if (!valid(fs.lstatSync(proofPath, { bigint: true }))) return refuse(1);
    fd = fs.openSync(proofPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const proof = fs.fstatSync(fd, { bigint: true });
    if (!valid(proof)) return refuse(1);
    const bytes = Buffer.alloc(513);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (!Buffer.from(name, 'utf8').equals(bytes.subarray(0, size))) return refuse(2);
    step = 'socket';
    try {
      fs.lstatSync(path.join(directory, 'sockets', name + '.sock'));
      return refuse(3);
    } catch (error) { if (error?.code !== 'ENOENT') return refuse(6); }
    step = 'selection';
    const active = fs.lstatSync(path.join(directory, 'active-session'), { bigint: true });
    if (!valid(active)) return refuse(8);
    return active.dev === proof.dev && active.ino === proof.ino ? true : refuse(5);
  } catch (error) {
    // A missing proof or selection entry is distinct; any other coded error is unreadable,
    // and an uncoded one is no distinct fact.
    try {
      const code = error?.code;
      if (step !== undefined && typeof code === 'string')
        closeProofFailure = code !== 'ENOENT' ? 6 : step === 'proof' ? 0 : step === 'selection' ? 4 : 6;
    } catch {}
    return false;
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
/** Finish with the original daemon status even when optional diagnostics cannot be written. */
function finish(code, value) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  // Only the eligible deadline reads receipts before its own connection closes.
  const early = queueSnapshot ? wrapperReceipt() : undefined;
  if (socket) socket.destroy();
  // Helper-only literal at this same original deadline, never a wait extension:
  // an opted-in status awaiting a reply during the selected session's still-running
  // plain OPEN, with the daemon holding at least one accepted connection besides this
  // helper's own: two held, or its sole held one proved held before this helper
  // connected (ph1 1). Any other deadline keeps its unchanged exit3 packet.
  if (code === 3 && deferOpen && early?.open_phase === 'started' &&
      (early.q1?.[2] >= 2 || early.ph1 === 1)) {
    code = 0;
    value = { open_deferred: 1 };
  }
  if (code !== 0) {
    const receipt = early ?? wrapperReceipt();
    if (receipt.wrapper_receipt_version === 1) value = { ...value, ...receipt };
    const cli = cliAtPrepare();
    if (cli) value = { ...value, cv: cli };
    // Drop optional codes newest first at the parser cap. The unchecked CLI
    // fallback [1, 0] yields to cp1 when that swap alone fits.
    if (value?.cp1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) {
      const { cv, ...rest } = value;
      if (cv?.length === 2 && cv[0] === 1 && cv[1] === 0 &&
          Buffer.byteLength(JSON.stringify(rest)) <= 544) value = rest;
      else delete value.cp1;
    }
    if (value?.e1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.e1;
    if (value?.ph1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.ph1;
    if (value?.ot1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.ot1;
    if (value?.q1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.q1;
    if (value?.sd1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.sd1;
    if (value?.s1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.s1;
    if (value?.l1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.l1;
    if (value?.o1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.o1;
    if (value?.r1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.r1;
    if (value?.dv !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.dv;
    if (value?.k1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.k1;
    if (value?.os1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.os1;
    if (value?.w1 !== undefined && Buffer.byteLength(JSON.stringify(value)) > 544) delete value.w1;
  }
  // Helper-selected disposition, not actual exit delivery; exit3 is only this
  // helper's own deadline.
  mark(code === 0 ? 's' : code === 3 ? 'd' : 'o');
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
  socketsInfo = sockets;
  const address = path.join(directory, 'sockets', name + '.sock');
  precondition = 'socket_stat';
  const info = fs.lstatSync(address);
  selectedSocketInfo = info;
  precondition = 'root_type';
  if (!root.isDirectory()) throw new Error();
  precondition = 'sockets_type';
  if (!sockets.isDirectory()) throw new Error();
  precondition = 'socket_type';
  if (!info.isSocket()) throw new Error();
  precondition = 'owner_mismatch';
  if ([root, sockets, info].some(item => item.uid !== process.getuid())) throw new Error();
  precondition = 'request_invalid';
  // The internal opt-ins never reach the daemon.
  const { owned_port: ownedPort, defer_wait: deferWait, defer_open: deferOpenRequested,
    recognize_closed: recognizeClosed, observe_progress: _progress, ...request } = JSON.parse(payload);
  if (!['stream_status', 'screenshot', 'viewport'].includes(request.action)) throw new Error();
  // A screenshot sent during an OPEN can still write its file later, so only status.
  deferOpen = deferOpenRequested === true && ownedPort === undefined &&
    request.action === 'stream_status';
  const id = 'hackerai-preview';
  // Upstream runs WAIT under its daemon state lock, so a queued fresh status or
  // screenshot request would reach the deadline; a WAIT can start after status
  // already answered. A fresh passive preview may yield only to the selected
  // session's exact still-running WAIT wrapper incarnation on a daemon that
  // provably holds its own listeners; any doubt sends the original strict
  // request, never the owned-port shortcut.
  const deferred = deferWait === true && ownedPort === undefined &&
    ['stream_status', 'screenshot'].includes(request.action) && activeWait() &&
    ownedStreamPort(root, sockets, address) > 0;
  // A non-fresh preview may skip the serialized daemon queue only with listener proof.
  const port = !deferred && ownedPort === true && request.action === 'stream_status' ?
    ownedStreamPort(root, sockets, address) : 0;
  // Helper-only literal: a daemon reply always carries its own id and success.
  if (deferred) finish(0, { wait_deferred: 1 });
  else if (port) finish(0, { id, success: true, data: { port } });
  else {
    let buffer = '';
    timer = setTimeout(() => {
      // One observation of the connected listener queue; no further daemon traffic.
      queueSnapshot = deadlinePhase === 'awaiting_response' &&
        ['stream_status', 'screenshot'].includes(request.action);
      finish(3, { deadline: [1, deadlinePhase] });
    }, 6000);
    // With the unchanged deadline already armed and before any daemon traffic.
    if (deferOpen) preconnect = preconnectQueue();
    socket = net.createConnection(address);
    socket.setEncoding('utf8');
    // The socket path is initialized with the 6s deadline already armed.
    mark('c');
    socket.on('connect', () => {
      deadlinePhase = 'awaiting_response';
      // Local write-attempt boundary, not daemon receipt.
      mark('w');
      if (recognizeClosed === true && request.action === 'screenshot') screenshotWriteAt = Date.now();
      socket.write(JSON.stringify({ ...request, id }) + '\n');
    });
    socket.on('data', chunk => {
      if (chunk.length > 0) deadlinePhase = 'partial_response';
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return finish(4);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      // Every refusal keeps exit5; r1 records only which check refused it, s1 only
      // a screenshot error's fixed message family. Only the parse can throw
      // before finish marks done, so catch remains invalid_json.
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        const refused = response === null || typeof response !== 'object' || Array.isArray(response) ? 1 :
          response.id !== id ? 2 : response.success === false ? 3 : response.success !== true ? 4 : -1;
        if (refused === 3 && request.action === 'screenshot') {
          const error = response.error;
          return finish(5, { r1: [1, 3], s1: [1, typeof error !== 'string' ? 4 :
            error === 'Browser not launched' ? 0 : error === 'No active page' ? 1 :
            error.startsWith('Failed to decode screenshot:') ? 2 :
            error.startsWith('Failed to save screenshot to ') ? 3 : 4] });
        }
        if (refused >= 0) return finish(5, { r1: [1, refused] });
        finish(0, response);
      } catch { finish(5, { r1: [1, 0] }); }
    });
    // A connection ending without a final reply is never a close by itself. Only an
    // opted-in status or screenshot whose selected socket is now absent beside the
    // same verified close proof answers the helper literal; anything else keeps exit6.
    const dropped = () => {
      if (done) return;
      if (sessionClosed()) finish(0, { session_closed: 1 });
      else finish(6);
    };
    socket.on('error', dropped);
    socket.on('close', dropped);
  }
} catch (error) {
  let code;
  try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch {}
  // Helper-only literal: a daemon reply always carries its own id and success.
  if (precondition === 'socket_stat' && code === 'ENOENT' && sessionClosed())
    finish(0, { session_closed: 1 });
  else {
    try {
      statusSocketMissing = precondition === 'socket_stat' && code === 'ENOENT' &&
        JSON.parse(payload)?.action === 'stream_status';
    } catch {}
    const value = { diagnostic_reason: precondition };
    if (['root_stat', 'sockets_stat', 'socket_stat'].includes(precondition)) {
      value.diagnostic_error = code === 'ENOENT' ? 'missing' :
        code === 'EACCES' || code === 'EPERM' ? 'permission' :
        code === 'ENOTDIR' ? 'not_directory' : 'other';
    }
    // That same refused close-proof check, for an opted-in status without owned_port only.
    try {
      if (statusSocketMissing && closeProofFailure !== undefined &&
          JSON.parse(payload)?.owned_port === undefined) value.cp1 = closeProofFailure;
    } catch {}
    finish(2, value);
  }
}
`;

/**
 * The helper's exact exit-0 output when a defer_wait status or screenshot
 * request yielded to the selected session's verified active WAIT without any
 * daemon traffic. A daemon reply always includes its own id and success, so it
 * can never equal this literal.
 */
export const BROWSER_DAEMON_WAIT_DEFERRED = '{"wait_deferred":1}';

/**
 * The helper's exact exit-0 output when a defer_open status request reached its
 * unchanged original deadline awaiting a response while the selected session's
 * plain OPEN was still STARTED (same live wrapper incarnation before and after
 * the owned listener sample) and that daemon held at least two accepted
 * connections, or its sole held one beside a pending connection was already
 * held at the same OPEN's pre-connect sample. A daemon reply can never equal
 * this literal.
 */
export const BROWSER_DAEMON_OPEN_DEFERRED = '{"open_deferred":1}';

/**
 * The helper's exact exit-0 output when a recognize_closed status or screenshot
 * request found the selected owned socket absent after the wrapper's verified
 * close of that still-current selection, either before connecting or when its
 * connection ends without a final reply. A daemon reply can never equal this
 * literal.
 */
export const BROWSER_DAEMON_SESSION_CLOSED = '{"session_closed":1}';

type BrowserDaemonRequest =
  // owned_port lets the helper prove the port from the daemon's own listeners;
  // the helper strips it and falls back to this same daemon request otherwise.
  // recognize_closed (either status form) only lets an absent socket with a
  // verified close answer; the helper strips it before any daemon traffic.
  // observe_progress (either status form) only adds stderr progress frames;
  // the helper strips it before any daemon traffic.
  | {
      action: "stream_status";
      owned_port?: true;
      recognize_closed?: true;
      observe_progress?: true;
    }
  // defer_wait lets a fresh passive preview yield to a verified active WAIT;
  // defer_open lets its deadline report a verified still-running plain OPEN,
  // and adds one local pre-connect queue sample beside it for an exit3 code.
  // The helper strips both and sends this same strict request otherwise.
  | {
      action: "stream_status";
      defer_wait?: true;
      defer_open?: true;
      recognize_closed?: true;
      observe_progress?: true;
    }
  // defer_wait and recognize_closed have the same meanings for a fresh passive
  // preview's screenshot; both are stripped before any daemon traffic.
  | {
      action: "screenshot";
      path: string;
      format: "jpeg";
      quality: 65;
      defer_wait?: true;
      recognize_closed?: true;
    }
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
