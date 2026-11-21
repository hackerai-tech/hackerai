import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  BROWSER_DAEMON_OPEN_DEFERRED,
  BROWSER_DAEMON_PROGRAM,
  BROWSER_DAEMON_PROGRESS_FRAMES,
  BROWSER_DAEMON_PROGRESS_SEQUENCES,
  BROWSER_DAEMON_SESSION_CLOSED,
  BROWSER_DAEMON_WAIT_DEFERRED,
} from "../daemon-program";

const directory = "/dev/shm/hackerai-browser-0123456789abcdef";
/** Preserve the old receipt budget and the existing full parser cap separately. */
function expectPacketBudgets(text: string) {
  const {
    cv: _cliAtPrepare,
    w1: _wrapperProcess,
    os1: _openSocket,
    k1: _commandClass,
    dv: _daemonVersion,
    r1: _responseValidation,
    o1: _openInfo,
    l1: _wrapperResult,
    s1: _screenshotRefusal,
    sd1: _socketDirectory,
    q1: _listenerQueue,
    ot1: _openWriteOrder,
    ph1: _preconnectHeld,
    ...previousContext
  } = JSON.parse(text);
  expect(
    Buffer.byteLength(JSON.stringify(previousContext)),
  ).toBeLessThanOrEqual(512);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
}
/** The selected stream sidecar and this helper's procfs view of its daemon. */
type OwnedState = {
  stream?: string;
  streamOwner?: number;
  streamMode?: number;
  streamSize?: number;
  streamSymlink?: boolean;
  streamFifo?: boolean;
  unix?: string;
  tcp?: string;
  tableError?: string;
  fds?: Record<string, string>;
  fdError?: string;
  linkError?: string;
  // Replaces the selected socket or the PID sidecar, or ends the started wrapper,
  // once the connected helper's descriptor walk starts.
  walkDrift?: "socket" | "pid" | "wrapper";
  // Receipt contents once the connected helper's descriptor walk starts; an
  // undefined value is missing.
  afterWalk?: { receipt?: unknown; openReceipt?: unknown };
  // The view before the helper connects, where it differs; afterWalk applies once
  // that pre-connect descriptor walk starts.
  beforeConnect?: {
    pidFile?: string;
    unix?: string;
    fds?: Record<string, string>;
    receipt?: unknown;
    openReceipt?: unknown;
    afterWalk?: { receipt?: unknown; openReceipt?: unknown };
  };
};
/** Run the real daemon helper against controlled filesystem and socket boundaries. */
function daemon(
  options: {
    directory?: string;
    invalidPath?: string;
    action?: string;
    request?: Record<string, unknown>;
    rootMode?: number;
    owned?: OwnedState;
    unownedPath?: string;
    missingPath?: string;
    missingCode?: string;
    name?: string;
    receipt?: unknown;
    openReceipt?: unknown;
    closeReceipt?: unknown;
    closeReceiptOwner?: number;
    closeReceiptMode?: number;
    closeReceiptSize?: number;
    closeReceiptSymlink?: boolean;
    openReceiptOwner?: number;
    openReceiptMode?: number;
    openReceiptSize?: number;
    openReceiptSymlink?: boolean;
    receiptOwner?: number;
    receiptMode?: number;
    receiptSize?: number;
    receiptSymlink?: boolean;
    receiptRegular?: boolean;
    stdoutThrows?: boolean;
    procUnavailable?: boolean;
    pidFile?: string;
    pidOwner?: number;
    pidMode?: number;
    pidSymlink?: boolean;
    pidSize?: number;
    processVisibility?: "same_uid" | "other_uid" | "missing" | "permission";
    cliReceipt?: unknown;
    cliOwner?: number;
    cliMode?: number;
    cliSize?: number;
    cliSymlink?: boolean;
    procfsType?: number;
    wrapperStat?: string;
    wrapperStatError?: string;
    wrapperStatOwner?: number;
    wrapperStatFifo?: boolean;
    socketsMode?: number;
    versionFile?: string;
    versionOwner?: number;
    versionMode?: number;
    versionSize?: number;
    versionSymlink?: boolean;
    versionFifo?: boolean;
    versionError?: string;
    versionReadError?: boolean;
    // Charges extra bytes to every packet measurement to simulate a tighter cap.
    chargedBytes?: number;
    // Monotonic nanoseconds for each process.hrtime.bigint() read.
    clock?: () => bigint;
    // Wall-clock milliseconds for each Date.now() read; the real clock otherwise.
    now?: () => number;
    // What descriptor 2 is (default a pipe), whether the helper's own
    // nonblocking reopen of it fails, and whether every write to that reopened
    // descriptor fails (EAGAIN is a full pipe).
    stderrKind?: "fifo" | "tty" | "file";
    stderrOpenError?: string;
    stderrWriteError?: string;
  } = {},
) {
  const socketPath = path.join(
    options.directory ?? directory,
    "sockets",
    `${options.name ?? "default"}.sock`,
  );
  const socket = new EventEmitter() as EventEmitter & {
    write: jest.Mock;
    destroy: jest.Mock;
    setEncoding: jest.Mock;
  };
  socket.write = jest.fn();
  socket.destroy = jest.fn();
  socket.setEncoding = jest.fn();
  const connect = jest.fn(() => socket);
  const exit = jest.fn();
  const output = jest.fn();
  if (options.stdoutThrows)
    output.mockImplementation(() => {
      throw new Error("PRIVATE broken output");
    });
  // Descriptor 2 and the helper's own reopened description of the same pipe.
  const stderrStat = () => ({
    dev: 13,
    ino: 4400,
    isFIFO: () => (options.stderrKind ?? "fifo") === "fifo",
  });
  const delivered: string[] = [];
  const stderr = jest.fn((fd: number, text: string) => {
    // Recorded before throwing, so a write to shared fd 2 is still visible.
    if (fd !== 30) throw new Error("Unexpected descriptor write");
    if (options.stderrWriteError)
      throw Object.assign(new Error("PRIVATE stderr"), {
        code: options.stderrWriteError,
      });
    delivered.push(text);
  });
  // The pre-connect overrides apply only until the helper's one connection.
  const preconnect = () =>
    connect.mock.calls.length === 0 ? options.owned?.beforeConnect : undefined;
  const fileReceipt = (open: boolean, close = false) => {
    if (close) return options.closeReceipt;
    const key = open ? "openReceipt" : "receipt";
    const before = preconnect();
    if (before) {
      const after = before.afterWalk;
      if (preWalked && after && key in after) return after[key];
      if (key in before) return before[key];
    }
    const after = options.owned?.afterWalk;
    return walked && after && key in after ? after[key] : options[key];
  };
  const receiptStat = (open: boolean, close = false) => ({
    uid:
      (close
        ? options.closeReceiptOwner
        : open
          ? options.openReceiptOwner
          : options.receiptOwner) ?? 1000,
    mode:
      (close
        ? options.closeReceiptMode
        : open
          ? options.openReceiptMode
          : options.receiptMode) ?? 0o600,
    size:
      (close
        ? options.closeReceiptSize
        : open
          ? options.openReceiptSize
          : options.receiptSize) ??
      JSON.stringify(fileReceipt(open, close))?.length,
    isFile: () =>
      fileReceipt(open, close) !== undefined &&
      !(close
        ? options.closeReceiptSymlink
        : open
          ? options.openReceiptSymlink
          : options.receiptSymlink) &&
      (open || options.receiptRegular !== false),
  });
  const pidStat = () => ({
    uid: options.pidOwner ?? 1000,
    mode: options.pidMode ?? 0o644,
    size: options.pidSize ?? options.pidFile?.length,
    isFile: () => !options.pidSymlink && options.pidFile !== undefined,
  });
  const cliStat = () => ({
    uid: options.cliOwner ?? 1000,
    mode: options.cliMode ?? 0o600,
    size: options.cliSize ?? JSON.stringify(options.cliReceipt)?.length,
    isFile: () => options.cliReceipt !== undefined && !options.cliSymlink,
  });
  const versionStat = () => ({
    uid: options.versionOwner ?? 1000,
    mode: options.versionMode ?? 0o644,
    size: options.versionSize ?? Buffer.byteLength(options.versionFile ?? ""),
    isFile: () =>
      options.versionFile !== undefined &&
      !options.versionSymlink &&
      !options.versionFifo,
  });
  const owned = options.owned ?? {};
  const streamStat = () => ({
    uid: owned.streamOwner ?? 1000,
    mode: owned.streamMode ?? 0o644,
    size: owned.streamSize ?? Buffer.byteLength(owned.stream ?? ""),
    isFile: () =>
      owned.stream !== undefined && !owned.streamSymlink && !owned.streamFifo,
  });
  // procfs tables report size 0 and return at most a page per read.
  const tables = new Map<number, { text: Buffer; at: number }>();
  // The connected helper's walk and, separately, any walk before it connects.
  let walked = false;
  let preWalked = false;
  const view = <K extends "pidFile" | "unix" | "fds">(
    key: K,
    fallback: NonNullable<OwnedState["beforeConnect"]>[K],
  ) => {
    const before = preconnect();
    return before && key in before ? before[key] : fallback;
  };
  // The recorded daemon PID, or the pre-connect sidecar's when it differs.
  const knownPid = (pid: string | undefined) =>
    pid === "314159" ||
    (pid !== undefined && pid === owned.beforeConnect?.pidFile);
  const readReceipt = jest.fn(
    (fd: number, bytes: Buffer, offset = 0, length = bytes.length) => {
      const table = tables.get(fd);
      if (table) {
        const chunk = table.text.subarray(
          table.at,
          table.at + Math.min(length, 4096),
        );
        chunk.copy(bytes, offset);
        table.at += chunk.length;
        return chunk.length;
      }
      if (fd === 14) return bytes.write(owned.stream!, "latin1");
      return readFile(fd, bytes);
    },
  );
  const readFile = (fd: number, bytes: Buffer) => {
    if (fd === 13 && options.versionReadError)
      throw new Error("PRIVATE version read");
    return bytes.write(
      fd === 13
        ? options.versionFile!
        : fd === 12
          ? options.wrapperStat!
          : fd === 11
            ? JSON.stringify(options.cliReceipt)
            : fd === 10
              ? walked && owned.walkDrift === "pid"
                ? "314160"
                : view("pidFile", options.pidFile)!
              : JSON.stringify(fileReceipt(fd === 8, fd === 9)),
      "utf8",
    );
  };
  const closeReceipt = jest.fn();
  const openReceipt = jest.fn((file: string) => {
    if (file === "/proc/self/fd/2") {
      if (options.stderrOpenError)
        throw Object.assign(new Error("PRIVATE reopen"), {
          code: options.stderrOpenError,
        });
      return 30;
    }
    if (file === "/proc/net/unix" || file === "/proc/net/tcp") {
      const text = file.endsWith("unix") ? view("unix", owned.unix) : owned.tcp;
      if (owned.tableError || text === undefined)
        throw Object.assign(new Error("PRIVATE table"), {
          code: owned.tableError ?? "ENOENT",
        });
      const fd = file.endsWith("unix") ? 15 : 16;
      tables.set(fd, { text: Buffer.from(text, "latin1"), at: 0 });
      return fd;
    }
    if (file.endsWith(".stream")) {
      if (owned.streamSymlink)
        throw Object.assign(new Error("PRIVATE link"), { code: "ELOOP" });
      return 14;
    }
    if (file.startsWith("/proc/")) {
      if (file !== "/proc/271828/stat")
        throw new Error("Unexpected process path");
      if (options.wrapperStatError || (walked && owned.walkDrift === "wrapper"))
        throw Object.assign(new Error("PRIVATE process"), {
          code: options.wrapperStatError ?? "ENOENT",
        });
      return 12;
    }
    if (file.endsWith("/cli-at-prepare.json")) {
      if (options.cliReceipt === undefined || options.cliSymlink)
        throw new Error("PRIVATE unavailable CLI receipt");
      return 11;
    }
    if (file.endsWith(".pid")) return 10;
    if (file.endsWith(".version")) {
      if (options.versionSymlink)
        throw Object.assign(new Error("PRIVATE link"), { code: "ELOOP" });
      return 13;
    }
    const open = file.endsWith("/open-receipt.json");
    const close = file.endsWith("/close-receipt.json");
    if (
      fileReceipt(open, close) === undefined ||
      (close
        ? options.closeReceiptSymlink
        : open
          ? options.openReceiptSymlink
          : options.receiptSymlink)
    )
      throw new Error("PRIVATE unavailable receipt");
    return close ? 9 : open ? 8 : 7;
  });
  const lstat = jest.fn((file: string) => {
    if (file.endsWith("/cli-at-prepare.json")) return cliStat();
    if (file.endsWith(".stream")) {
      if (owned.stream === undefined)
        throw Object.assign(new Error("PRIVATE missing stream"), {
          code: "ENOENT",
        });
      return streamStat();
    }
    if (file.endsWith(".version")) {
      if (options.versionError || options.versionFile === undefined)
        throw Object.assign(new Error("PRIVATE version"), {
          code: options.versionError ?? "ENOENT",
        });
      return versionStat();
    }
    if (file.endsWith(".pid")) {
      if (options.pidFile === undefined)
        throw Object.assign(new Error("PRIVATE missing PID"), {
          code: "ENOENT",
        });
      return pidStat();
    }
    if (
      file.endsWith("/wrapper-receipt.json") ||
      file.endsWith("/open-receipt.json") ||
      file.endsWith("/close-receipt.json")
    ) {
      const open = file.endsWith("/open-receipt.json");
      const close = file.endsWith("/close-receipt.json");
      if (fileReceipt(open, close) === undefined)
        throw Object.assign(new Error("PRIVATE missing receipt"), {
          code: "ENOENT",
        });
      return receiptStat(open, close);
    }
    if (file === options.missingPath)
      throw Object.assign(new Error("PRIVATE filesystem path"), {
        code: options.missingCode ?? "ENOENT",
      });
    return {
      uid: file === options.unownedPath ? 0 : 1000,
      dev: 64769,
      ino:
        file === socketPath && walked && owned.walkDrift === "socket" ? 78 : 77,
      mode:
        file.endsWith("/sockets") && options.socketsMode !== undefined
          ? options.socketsMode
          : file === (options.directory ?? directory) &&
              options.rootMode !== undefined
            ? options.rootMode
            : 0o700,
      isDirectory: () => file !== socketPath && file !== options.invalidPath,
      isSocket: () => file === socketPath && file !== options.invalidPath,
    };
  });
  const closeDescriptors = jest.fn();
  const openDescriptors = jest.fn((file: string) => {
    if (!knownPid(/^\/proc\/([0-9]+)\/fd$/.exec(file)?.[1]))
      throw new Error("Unexpected process path");
    if (owned.fdError)
      throw Object.assign(new Error("PRIVATE descriptors"), {
        code: owned.fdError,
      });
    const names = Object.keys(view("fds", owned.fds) ?? {});
    return {
      readSync: () => (names.length ? { name: names.shift() } : null),
      closeSync: closeDescriptors,
    };
  });
  const readLink = jest.fn((file: string) => {
    const [, pid, descriptor = ""] =
      /^\/proc\/([0-9]+)\/fd\/([0-9]+)$/.exec(file) ?? [];
    const fds = view("fds", owned.fds);
    if (!knownPid(pid) || fds?.[descriptor] === undefined)
      throw new Error("Unexpected descriptor path");
    if (connect.mock.calls.length > 0) walked = true;
    else preWalked = true;
    if (owned.linkError)
      throw Object.assign(new Error("PRIVATE link"), {
        code: owned.linkError,
      });
    return fds[descriptor];
  });
  let deadline: (() => void) | undefined;
  // The helper's one deadline timer and its requested delay.
  const arm = jest.fn((callback: () => void, _ms: number) => {
    deadline = callback;
    return 1;
  });
  runInNewContext(BROWSER_DAEMON_PROGRAM, {
    require: (name: string) => {
      if (name === "node:path") return path;
      if (name === "node:crypto") return { createHash };
      if (name === "node:net") return { createConnection: connect };
      if (name === "node:fs")
        return {
          constants: {
            O_RDONLY: 0,
            O_WRONLY: 1,
            O_NOFOLLOW: 256,
            O_NONBLOCK: 2048,
          },
          openSync: openReceipt,
          fstatSync: (fd: number) =>
            fd === 2 || fd === 30
              ? stderrStat()
              : fd === 15 || fd === 16
                ? { isFile: () => true }
                : fd === 14
                  ? streamStat()
                  : fd === 13
                    ? versionStat()
                    : fd === 12
                      ? {
                          uid: options.wrapperStatOwner ?? 1000,
                          isFile: () => !options.wrapperStatFifo,
                        }
                      : fd === 11
                        ? cliStat()
                        : fd === 10
                          ? pidStat()
                          : receiptStat(fd === 8, fd === 9),
          statfsSync: (file: string) => {
            if (file !== "/proc") throw new Error("Unexpected filesystem");
            if (options.procUnavailable)
              throw Object.assign(new Error("PRIVATE unavailable procfs"), {
                code: "ENOENT",
              });
            return { type: options.procfsType ?? 0x9fa0 };
          },
          statSync: (file: string) => {
            if (file === "/proc") {
              if (options.procUnavailable)
                throw Object.assign(new Error("PRIVATE unavailable procfs"), {
                  code: "ENOENT",
                });
              return { isDirectory: () => true };
            }
            if (!knownPid(/^\/proc\/([0-9]+)$/.exec(file)?.[1]))
              throw new Error("Unexpected process path");
            if (
              options.processVisibility === "missing" ||
              options.processVisibility === "permission"
            )
              throw Object.assign(new Error("PRIVATE process"), {
                code:
                  options.processVisibility === "missing" ? "ENOENT" : "EACCES",
              });
            return {
              uid: options.processVisibility === "other_uid" ? 0 : 1000,
            };
          },
          readSync: readReceipt,
          writeSync: stderr,
          closeSync: closeReceipt,
          lstatSync: lstat,
          opendirSync: openDescriptors,
          readlinkSync: readLink,
        };
      throw new Error("Unexpected process or module access");
    },
    process: {
      argv: [
        "node",
        options.directory ?? directory,
        options.name ?? "default",
        JSON.stringify(
          options.request ?? { action: options.action ?? "stream_status" },
        ),
      ],
      getuid: () => 1000,
      platform: "linux",
      hrtime: { bigint: options.clock ?? (() => BigInt(0)) },
      stdout: { write: output },
      exit,
    },
    Buffer:
      options.chargedBytes !== undefined
        ? Object.assign(Object.create(Buffer), {
            byteLength: (text: string) =>
              Buffer.byteLength(text) + options.chargedBytes!,
          })
        : Buffer,
    setTimeout: arm,
    clearTimeout: jest.fn(),
    ...(options.now && { Date: { now: options.now } }),
  });
  const reply = (value: unknown) =>
    socket.emit("data", JSON.stringify(value) + "\n");
  return {
    socket,
    connect,
    exit,
    output,
    // Frames the stderr pipe accepted, in order, and every write attempt.
    stderr: () => delivered.join(""),
    stderrWrites: stderr,
    reply,
    readReceipt,
    closeReceipt,
    openReceipt,
    lstat,
    openDescriptors,
    closeDescriptors,
    readLink,
    arm,
    timeout: () => deadline?.(),
  };
}

const receipt = {
  v: 1,
  session_key: createHash("sha256").update("default").digest("hex"),
  action: "close",
  phase: "completed",
  exit: 37,
  at: Date.now(),
  private: "PRIVATE_TARGET",
  close_all: false,
};

it.each(["unset", "disabled", "lt_15m", "15m", "gt_15m", "unparsed"])(
  "retains the wrapped open declaration %s after a different last command",
  (idle) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...receipt, action: "version", open_receipt_support: 1 },
      openReceipt: {
        ...receipt,
        action: "open",
        idle_env_version: 1,
        idle_env: idle,
      },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text).open_idle).toEqual([1, idle]);
    expectPacketBudgets(text);
    expect(text).not.toContain("PRIVATE");
  },
);

it.each([
  { idle_env_version: 1, idle_env: "PRIVATE_ENV" },
  { idle_env_version: 2, idle_env: "15m" },
  { idle_env_version: 1, idle_env: "15m", session_key: "a".repeat(64) },
  {},
])(
  "censors an invalid, old or other-session open declaration (%#)",
  (fields) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...receipt, open_receipt_support: 1 },
      openReceipt: { ...receipt, action: "open", ...fields },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(JSON.parse(d.output.mock.calls[0][0])).not.toHaveProperty(
      "open_idle",
    );
  },
);

it("keeps previous open/close/declaration context within512 and the full packet within544", () => {
  const longest = { ...receipt, at: Date.now() + 60000, exit: 999 };
  const d = daemon({
    missingPath: directory + "/sockets",
    missingCode: "ENOTDIR",
    receipt: {
      ...longest,
      action: "version",
      session_key: "a".repeat(64),
      open_receipt_support: 1,
      close_receipt_support: 1,
    },
    openReceipt: {
      ...longest,
      action: "open",
      idle_env_version: 1,
      idle_env: "unparsed",
    },
    closeReceipt: { ...longest, action: "close" },
  });
  const text = d.output.mock.calls[0][0];
  expectPacketBudgets(text);
  expect(JSON.parse(text)).toMatchObject({
    diagnostic_reason: "sockets_stat",
    diagnostic_error: "not_directory",
    open_idle: [1, "unparsed"],
    close_receipt: [
      1,
      "recorded",
      "completed",
      "other",
      "selected_session",
      "unknown",
      "same_time",
    ],
  });
});

it("reports only bounded same-session wrapper context when an owned socket is missing", () => {
  const d = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt,
  });
  expect(d.exit).toHaveBeenCalledWith(2);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({
    diagnostic_reason: "socket_stat",
    diagnostic_error: "missing",
    cv: [1, 0],
    wrapper_receipt_version: 1,
    wrapper_action: "close",
    wrapper_phase: "completed",
    wrapper_exit: 37,
    wrapper_session_matches: true,
    wrapper_age: "lt10s",
    open_receipt_version: 1,
    open_receipt_status: "unavailable",
    close_receipt: [1, "unavailable"],
  });
  expect(JSON.stringify(d.output.mock.calls)).not.toMatch(
    /PRIVATE|default|\/dev\/shm/,
  );
  expect(d.closeReceipt).toHaveBeenCalledWith(7);
});

it("can distinguish a started wrapper for a different session at the existing daemon deadline", () => {
  const d = daemon({
    receipt: {
      ...receipt,
      session_key: createHash("sha256").update("PRIVATE_OTHER").digest("hex"),
      action: "open",
      phase: "started",
      exit: null,
    },
  });
  d.timeout();
  expect(d.exit).toHaveBeenCalledWith(3);
  expect(JSON.parse(d.output.mock.calls[0][0])).toMatchObject({
    wrapper_action: "open",
    wrapper_phase: "started",
    wrapper_exit: "none",
    wrapper_session_matches: false,
  });
  expect(JSON.stringify(d.output.mock.calls)).not.toContain("PRIVATE");
});

it.each([
  { receiptOwner: 0 },
  { receiptMode: 0o644 },
  { receiptSymlink: true },
  { receiptSize: 513 },
  { unownedPath: directory },
])(
  "does not read a receipt outside the owned private-file boundary: %j",
  (options) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt,
      ...options,
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.readReceipt).not.toHaveBeenCalled();
    expect(JSON.parse(d.output.mock.calls[0][0])).not.toHaveProperty(
      "wrapper_action",
    );
  },
);

it("omits malformed receipt data and leaves successful daemon responses unchanged", () => {
  const malformed = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt: { ...receipt, action: "PRIVATE_COMMAND" },
  });
  expect(JSON.stringify(malformed.output.mock.calls)).not.toContain("PRIVATE");
  expect(JSON.parse(malformed.output.mock.calls[0][0])).not.toHaveProperty(
    "wrapper_action",
  );
  const success = daemon({ receipt });
  success.reply({
    id: "hackerai-preview",
    success: true,
    data: { connected: true, port: 9223 },
  });
  expect(success.readReceipt).not.toHaveBeenCalled();
  expect(JSON.parse(success.output.mock.calls[0][0])).not.toHaveProperty(
    "wrapper_action",
  );
});

it.each(["missing", "deadline"])(
  "preserves the existing %s failure code when the diagnostic output cannot be written",
  (failure) => {
    const d = daemon({
      receipt,
      stdoutThrows: true,
      ...(failure === "missing"
        ? { missingPath: directory + "/sockets/default.sock" }
        : {}),
    });
    if (failure === "deadline") expect(() => d.timeout()).not.toThrow();
    expect(d.exit).toHaveBeenCalledWith(failure === "missing" ? 2 : 3);
  },
);

it("rejects a nonregular receipt before opening it, so a FIFO cannot stall a browser failure", () => {
  const d = daemon({
    receipt,
    receiptRegular: false,
    missingPath: directory + "/sockets/default.sock",
  });
  expect(d.openReceipt).not.toHaveBeenCalled();
  expect(d.exit).toHaveBeenCalledWith(2);
});

it("queries only the existing owned socket and accepts a complete correlated response", () => {
  const d = daemon();
  d.socket.emit("connect");
  expect(d.connect).toHaveBeenCalledWith(directory + "/sockets/default.sock");
  expect(JSON.parse(d.socket.write.mock.calls[0][0])).toEqual({
    action: "stream_status",
    id: "hackerai-preview",
  });
  const response = JSON.stringify({
    id: "hackerai-preview",
    success: true,
    data: { connected: true, port: 9223 },
  });
  d.socket.emit("data", response.slice(0, 12));
  expect(d.output).not.toHaveBeenCalled();
  d.socket.emit("data", response.slice(12) + "\n");
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(d.output.mock.calls[0][0]).data).toEqual({
    connected: true,
    port: 9223,
  });
  expect(d.socket.destroy).toHaveBeenCalled();
});

it.each(["connecting", "awaiting_response", "partial_response"])(
  "distinguishes %s at the unchanged daemon deadline without returning response bytes",
  (phase) => {
    const d = daemon();
    if (phase !== "connecting") d.socket.emit("connect");
    if (phase === "partial_response")
      d.socket.emit("data", '{"PRIVATE_RESPONSE":');
    d.timeout();
    expect(d.exit).toHaveBeenCalledWith(3);
    expect(d.socket.destroy).toHaveBeenCalled();
    expect(JSON.parse(d.output.mock.calls[0]?.[0] ?? "null")).toEqual({
      deadline: [1, phase],
      cv: [1, 0],
    });
    expect(JSON.stringify(d.output.mock.calls)).not.toContain("PRIVATE");
  },
);

it("preserves maximal wrapper receipts within the parser budget at a response deadline", () => {
  const longest = { ...receipt, at: Date.now() + 60000, exit: 999 };
  const d = daemon({
    receipt: {
      ...longest,
      action: "version",
      open_receipt_support: 1,
      close_receipt_support: 1,
      history: [1, true, false],
    },
    openReceipt: {
      ...longest,
      action: "open",
      idle_env_version: 1,
      idle_env: "unparsed",
    },
    closeReceipt: { ...longest, action: "close" },
  });
  d.socket.emit("connect");
  d.timeout();
  const text = d.output.mock.calls[0][0];
  expectPacketBudgets(text);
  expect(JSON.parse(text)).toMatchObject({
    deadline: [1, "awaiting_response"],
    h1: 1,
    open_idle: [1, "unparsed"],
    close_receipt: [
      1,
      "recorded",
      "completed",
      "other",
      "selected_session",
      "unknown",
      "same_time",
    ],
  });
  expect(text).not.toContain("PRIVATE");
});

it("reports a bounded missing-socket precondition while preserving exit2 and no connection", () => {
  const d = daemon({ missingPath: directory + "/sockets/default.sock" });
  expect(d.exit).toHaveBeenCalledWith(2);
  expect(d.connect).not.toHaveBeenCalled();
  expect(JSON.parse(d.output.mock.calls[0]?.[0] ?? "null")).toEqual({
    diagnostic_reason: "socket_stat",
    diagnostic_error: "missing",
    cv: [1, 0],
  });
  expect(JSON.stringify(d.output.mock.calls)).not.toMatch(
    /PRIVATE|\/dev\/shm|default/,
  );
});

it("distinguishes owner mismatch without exposing UID or path", () => {
  const d = daemon({ unownedPath: directory });
  expect(d.exit).toHaveBeenCalledWith(2);
  expect(d.connect).not.toHaveBeenCalled();
  expect(JSON.parse(d.output.mock.calls[0]?.[0] ?? "null")).toEqual({
    diagnostic_reason: "owner_mismatch",
  });
});

it.each([
  [{ id: "other-request", success: true, data: { port: 9223 } }, 2],
  [{ id: "hackerai-preview", success: false, error: "private failure" }, 3],
])(
  "refuses an unsuccessful or mismatched daemon response",
  (response, refused) => {
    const d = daemon();
    d.reply(response);
    expect(d.exit).toHaveBeenCalledWith(5);
    expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({
      r1: [1, refused],
      cv: [1, 0],
    });
  },
);

it.each(["error", "close", "timeout", "malformed", "oversized"])(
  "fails closed for %s without invoking a CLI or returning daemon data",
  (failure) => {
    const d = daemon();
    if (failure === "timeout") d.timeout();
    else if (failure === "malformed") d.socket.emit("data", "not-json\n");
    else if (failure === "oversized")
      d.socket.emit("data", "x".repeat(2 * 1024 * 1024 + 1));
    else d.socket.emit(failure);
    expect(d.exit.mock.calls[0][0]).not.toBe(0);
    if (failure === "timeout")
      expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({
        deadline: [1, "connecting"],
        cv: [1, 0],
      });
    else if (failure === "malformed")
      expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({
        r1: [1, 0],
        cv: [1, 0],
      });
    else expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({ cv: [1, 0] });
  },
);

it.each([
  directory,
  directory + "/sockets",
  directory + "/sockets/default.sock",
])(
  "rejects a symlink or wrong filesystem type at %s before connecting",
  (invalidPath) => {
    const d = daemon({ invalidPath });
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(2);
  },
);

it.each([
  { directory: "/tmp/hackerai-browser-owned" },
  { action: "open" },
  { unownedPath: directory },
  { unownedPath: directory + "/sockets" },
  { unownedPath: directory + "/sockets/default.sock" },
  { name: "../escape" },
  { name: "a".repeat(81) },
  { name: "" },
  { name: "bad\nname" },
])(
  "never starts or reconfigures a browser for an invalid request",
  (options) => {
    const d = daemon(options);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(2);
  },
);

it("retains a prior open observation when the latest command was a version check", () => {
  const d = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt: { ...receipt, action: "version", open_receipt_support: 1 },
    openReceipt: { ...receipt, action: "open", exit: 0 },
  });
  const value = JSON.parse(d.output.mock.calls[0][0]);
  expect(value).toMatchObject({
    wrapper_action: "version",
    open_receipt_version: 1,
    open_receipt_status: "recorded",
    open_phase: "completed",
    open_exit: 0,
    open_session_matches: true,
    open_age: "lt10s",
  });
  expect(JSON.stringify(value)).not.toMatch(
    /PRIVATE|session_key|default|dev\/shm/,
  );
  expect(d.closeReceipt).toHaveBeenCalledWith(8);
});

it("distinguishes an older writer from an unobserved open without reading an unsupported record", () => {
  const old = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt,
    openReceipt: { ...receipt, action: "open" },
  });
  expect(JSON.parse(old.output.mock.calls[0][0]).open_receipt_status).toBe(
    "unavailable",
  );
  expect(old.readReceipt).toHaveBeenCalledTimes(1);
  const missing = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt: { ...receipt, open_receipt_support: 1 },
  });
  expect(JSON.parse(missing.output.mock.calls[0][0]).open_receipt_status).toBe(
    "not_observed",
  );
});

it.each([
  { openReceiptOwner: 0 },
  { openReceiptMode: 0o644 },
  { openReceiptSymlink: true },
  { openReceiptSize: 513 },
  { openReceipt: { ...receipt, action: "PRIVATE" } },
])(
  "censors an unsafe open receipt while preserving last-command evidence: %j",
  (invalid) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...receipt, open_receipt_support: 1 },
      openReceipt: { ...receipt, action: "open" },
      ...invalid,
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value).toMatchObject({
      wrapper_action: "close",
      open_receipt_status: "unreadable",
    });
    expect(value).not.toHaveProperty("open_phase");
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
  },
);

it("bounds the combined receipt below the existing 512-byte parser limit and preserves session mismatch", () => {
  const d = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt: { ...receipt, open_receipt_support: 1 },
    openReceipt: {
      ...receipt,
      action: "open",
      phase: "started",
      session_key: "a".repeat(64),
      at: 0,
    },
  });
  const text = d.output.mock.calls[0][0];
  expectPacketBudgets(text);
  expect(JSON.parse(text)).toMatchObject({
    open_receipt_status: "recorded",
    open_phase: "started",
    open_exit: "none",
    open_session_matches: false,
    open_age: "older",
  });
});

it.each([
  [100, "after"],
  [-100, "before"],
  [0, "same_time"],
])(
  "retains close/open order %s after a later unrelated command",
  (delta, order) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: {
        ...receipt,
        action: "other",
        open_receipt_support: 1,
        close_receipt_support: 1,
      },
      openReceipt: { ...receipt, action: "open", exit: 0 },
      closeReceipt: {
        ...receipt,
        action: "close",
        at: receipt.at + Number(delta),
        exit: 0,
      },
    });
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value).toMatchObject({
      wrapper_action: "other",
      open_receipt_status: "recorded",
      close_receipt: [
        1,
        "recorded",
        "completed",
        0,
        "selected_session",
        expect.any(String),
        order,
      ],
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.closeReceipt).toHaveBeenCalledWith(9);
    expect(JSON.stringify(value)).not.toMatch(
      /PRIVATE|session_key|default|dev\/shm/,
    );
  },
);

it("distinguishes a legacy close writer from an unobserved close", () => {
  const old = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt,
    closeReceipt: { ...receipt, action: "close" },
  });
  expect(JSON.parse(old.output.mock.calls[0][0]).close_receipt).toEqual([
    1,
    "unavailable",
  ]);
  expect(old.readReceipt).toHaveBeenCalledTimes(1);
  const missing = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt: { ...receipt, close_receipt_support: 1 },
  });
  expect(JSON.parse(missing.output.mock.calls[0][0]).close_receipt).toEqual([
    1,
    "not_observed",
  ]);
});

it.each([
  { closeReceiptOwner: 0 },
  { closeReceiptMode: 0o644 },
  { closeReceiptSymlink: true },
  { closeReceiptSize: 513 },
  { closeReceipt: { ...receipt, action: "PRIVATE" } },
])(
  "censors an unsafe close while preserving the original failure: %j",
  (invalid) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...receipt, close_receipt_support: 1 },
      closeReceipt: { ...receipt, action: "close" },
      ...invalid,
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value).toMatchObject({
      wrapper_action: "close",
      close_receipt: [1, "unreadable"],
    });
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
  },
);

it.each([false, true])(
  "keeps previous history/close/open context within512 and censors cross-session order (%s)",
  (selectedClose) => {
    const longest = {
      ...receipt,
      at: Date.now() + 60000,
      exit: 999,
      session_key: "a".repeat(64),
    };
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      missingCode: "ENOTDIR",
      receipt: {
        ...longest,
        action: "version",
        open_receipt_support: 1,
        close_receipt_support: 1,
        history: [1, true, false],
      },
      openReceipt: {
        ...longest,
        action: "open",
        session_key: receipt.session_key,
        idle_env_version: 1,
        idle_env: "unparsed",
      },
      closeReceipt: {
        ...longest,
        action: "close",
        session_key: selectedClose ? receipt.session_key : longest.session_key,
      },
    });
    const text = d.output.mock.calls[0][0];
    expectPacketBudgets(text);
    expect(JSON.parse(text).close_receipt).toEqual([
      1,
      "recorded",
      "completed",
      "other",
      selectedClose ? "selected_session" : "other_session",
      "unknown",
      selectedClose ? "same_time" : "unavailable",
    ]);
  },
);

it("attributes a completed close-all to the selected session without requiring its name to match", () => {
  const d = daemon({
    missingPath: directory + "/sockets/default.sock",
    receipt: { ...receipt, open_receipt_support: 1, close_receipt_support: 1 },
    openReceipt: { ...receipt, action: "open", at: 0 },
    closeReceipt: {
      ...receipt,
      close_all: true,
      session_key: "a".repeat(64),
      exit: 0,
    },
  });
  expect(JSON.parse(d.output.mock.calls[0][0]).close_receipt).toEqual([
    1,
    "recorded",
    "completed",
    0,
    "all_sessions",
    expect.any(String),
    "after",
  ]);
});

const successfulOpen = {
  ...receipt,
  action: "open",
  exit: 0,
};

it.each([
  [{}, [1, 0, 0]],
  [{ pidFile: "314159", processVisibility: "same_uid" }, [1, 3, 2]],
  [{ pidFile: "314159", procUnavailable: true }, [1, 3, 0]],
  [{ pidFile: "314159", processVisibility: "missing" }, [1, 3, 1]],
  [{ pidFile: "314159", processVisibility: "other_uid" }, [1, 3, 3]],
  [{ pidFile: "314159", processVisibility: "permission" }, [1, 3, 4]],
  [{ pidFile: "PRIVATE" }, [1, 1, 0]],
  [{ pidFile: "0" }, [1, 1, 0]],
  [{ pidFile: "314159", pidSymlink: true }, [1, 2, 0]],
  [{ pidFile: "314159", pidOwner: 0 }, [1, 2, 0]],
  [{ pidFile: "314159", pidMode: 0o666 }, [1, 2, 0]],
  [{ pidFile: "314159", pidSize: 33 }, [1, 2, 0]],
] as const)(
  "reports bounded PID-sidecar/process visibility without changing a missing-socket exit (%#)",
  (options, expected) => {
    const d = daemon({
      ...options,
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...receipt, open_receipt_support: 1 },
      openReceipt: successfulOpen,
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text).p1).toEqual(expected);
    expect(text).not.toMatch(/PRIVATE|314159|\/proc|\/dev\/shm|default/);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
    if (expected[1] === 3) {
      expect(d.openReceipt).toHaveBeenCalledWith(
        directory + "/sockets/default.pid",
        256 | 2048,
      );
      expect(d.closeReceipt).toHaveBeenCalledWith(10);
    }
  },
);

it("leaves successful capture and mismatched open observations unprobed", () => {
  const d = daemon({
    receipt: { ...receipt, open_receipt_support: 1 },
    openReceipt: { ...successfulOpen, session_key: "a".repeat(64) },
    pidFile: "314159",
  });
  d.reply({ id: "hackerai-preview", success: true, data: { port: 9223 } });
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(d.openReceipt).not.toHaveBeenCalled();
  const failure = daemon({
    receipt: { ...receipt, open_receipt_support: 1 },
    openReceipt: { ...successfulOpen, session_key: "a".repeat(64) },
    pidFile: "314159",
    missingPath: directory + "/sockets/default.sock",
  });
  expect(JSON.parse(failure.output.mock.calls[0][0]).p1).toBeUndefined();
  expect(
    failure.openReceipt.mock.calls.every(([file]) => !file.endsWith(".pid")),
  ).toBe(true);
});

it.each(["sockets", "sockets/default.sock"])(
  "keeps maximal process, history, close and CLI context within544 bytes (%s)",
  (missing) => {
    const longest = { ...receipt, at: Date.now() + 60_000, exit: 999 };
    const d = daemon({
      missingPath: directory + "/" + missing,
      missingCode: "ENOTDIR",
      pidFile: "314159",
      processVisibility: "same_uid",
      cliReceipt: [1, 1, 999999999],
      receipt: {
        ...longest,
        action: "version",
        session_key: "a".repeat(64),
        open_receipt_support: 1,
        close_receipt_support: 1,
        history: [1, true, true],
      },
      openReceipt: {
        ...longest,
        action: "open",
        exit: 0,
        idle_env_version: 1,
        idle_env: "unparsed",
      },
      closeReceipt: { ...longest, action: "close", close_all: false },
    });
    const text = d.output.mock.calls[0][0];
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
    expect(text.length).toBeLessThanOrEqual(544);
    expect(JSON.parse(text)).toMatchObject({
      cv: [1, 1, 999999999],
      p1: missing === "sockets" ? [1, 2, 0] : [1, 3, 2],
      h1: 3,
      open_idle: [1, "unparsed"],
      close_receipt: [
        1,
        "recorded",
        "completed",
        "other",
        "selected_session",
        "unknown",
        "same_time",
      ],
    });
  },
);

it.each([
  [1, 0],
  [1, 1, 39003],
  [1, 2],
  [1, 3],
  [1, 4],
])(
  "retains bounded CLI-at-prepare context without a wrapper receipt: %j",
  (...cv) => {
    const d = daemon({
      cliReceipt: cv,
      missingPath: directory + "/sockets/default.sock",
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(JSON.parse(d.output.mock.calls[0][0]).cv).toEqual(cv);
  },
);

it.each([
  {},
  { cliOwner: 0 },
  { cliMode: 0o644 },
  { cliSymlink: true },
  { cliSize: 513 },
  { cliReceipt: [1, 1, -1] },
  { cliReceipt: [1, 1, 1000000000] },
  { cliReceipt: [1, 2, "PRIVATE"] },
  { cliReceipt: [2, 1, 39003] },
  { cliReceipt: [1, 5] },
])("censors absent, unsafe or malformed CLI receipts (%#)", (override) => {
  const d = daemon({
    cliReceipt: [1, 1, 39003],
    ...override,
    ...(Object.keys(override).length === 0 ? { cliReceipt: undefined } : {}),
    missingPath: directory + "/sockets/default.sock",
  });
  expect(d.exit).toHaveBeenCalledWith(2);
  expect(JSON.parse(d.output.mock.calls[0][0]).cv).toEqual([1, 0]);
  expect(d.output.mock.calls[0][0]).not.toContain("PRIVATE");
});

it("does not read CLI receipts on a successful daemon response", () => {
  const d = daemon({ cliReceipt: [1, 1, 39003] });
  const response = {
    id: "hackerai-preview",
    success: true,
    data: { port: 9223 },
  };
  d.reply(response);
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  expect(d.openReceipt).not.toHaveBeenCalled();
});

// Synthetic fixtures: the wrapper's private identity tuple and procfs stat lines.
const UINT64_MAX = "18446744073709551615";
const startedWrapper = {
  ...receipt,
  action: "open",
  phase: "started",
  exit: null,
  process: [1, 271828, "123456"],
};
/** A stat line with state at field 3 and start ticks at field 22. */
const procStat = ({
  pid = "271828",
  comm = "python3",
  state = "S",
  ticks = "123456",
} = {}) =>
  `${pid} (${comm}) ${state} ${Array.from({ length: 18 }, (_, i) => i + 1).join(" ")} ${ticks} 0 0\n`;
type DaemonOptions = NonNullable<Parameters<typeof daemon>[0]>;

it.each<[string, DaemonOptions & { tuple?: unknown[] }, number]>([
  ["live", { wrapperStat: procStat() }, 3],
  [
    "live with a parenthesized command name",
    { wrapperStat: procStat({ comm: "x) Z 9 (y" }) },
    3,
  ],
  [
    "live at the uint64 start bound",
    {
      wrapperStat: procStat({ ticks: UINT64_MAX }),
      tuple: [1, 271828, UINT64_MAX],
    },
    3,
  ],
  ["zombie", { wrapperStat: procStat({ state: "Z" }) }, 4],
  ["PID reused", { wrapperStat: procStat({ ticks: "123457" }) }, 2],
  [
    "another user's process at the PID",
    { wrapperStat: procStat({ ticks: "9" }), wrapperStatOwner: 0 },
    6,
  ],
  ["gone", { wrapperStatError: "ENOENT" }, 1],
  ["reaped while opening", { wrapperStatError: "ESRCH" }, 1],
  ["permission", { wrapperStatError: "EACCES" }, 5],
  ["symlink", { wrapperStatError: "ELOOP" }, 6],
  [
    "same start under another user",
    { wrapperStat: procStat(), wrapperStatOwner: 0 },
    6,
  ],
  ["non-regular", { wrapperStat: procStat(), wrapperStatFifo: true }, 6],
  ["oversized", { wrapperStat: procStat() + " ".repeat(4097) }, 6],
  ["another PID", { wrapperStat: procStat({ pid: "271829" }) }, 6],
  ["truncated", { wrapperStat: "271828 (python3) S 1 2 3\n" }, 6],
  ["non-numeric start", { wrapperStat: procStat({ ticks: "PRIVATE" }) }, 6],
  [
    "start beyond uint64",
    { wrapperStat: procStat({ ticks: "18446744073709551616" }) },
    6,
  ],
  ["procfs unavailable", { procUnavailable: true }, 0],
  ["not procfs", { wrapperStat: procStat(), procfsType: 0x01021994 }, 0],
])(
  "reports exact started-wrapper incarnation visibility (%s) without changing the failure",
  (_case, { tuple, ...options }, code) => {
    const d = daemon({
      ...options,
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...startedWrapper, process: tuple ?? startedWrapper.process },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text)).toMatchObject({
      diagnostic_reason: "socket_stat",
      wrapper_phase: "started",
      wrapper_exit: "none",
      wrapper_session_matches: true,
      w1: code,
    });
    expect(text).not.toMatch(/PRIVATE|271828|123456|\/proc|process/);
    const probed = d.openReceipt.mock.calls.filter(([file]) =>
      file.startsWith("/proc/"),
    );
    expect(probed).toEqual(
      code === 0 ? [] : [["/proc/271828/stat", 256 | 2048]],
    );
    if (code !== 0 && !("wrapperStatError" in options))
      expect(d.closeReceipt).toHaveBeenCalledWith(12);
    // Only an owned regular stat file is read; another UID's bytes never are.
    if ("wrapperStatFifo" in options || "wrapperStatOwner" in options)
      expect(d.readReceipt.mock.calls.some(([fd]) => fd === 12)).toBe(false);
  },
);

it.each([
  undefined,
  [2, 271828, "123456"],
  [1, 0, "123456"],
  [1, "271828", "123456"],
  [1, 271828, 123456],
  [1, 271828, "0123456"],
  [1, 271828, "18446744073709551616"],
  [1, 271828, "123456", "PRIVATE"],
])(
  "keeps a legacy or malformed private identity unavailable instead of not_found (%#)",
  (tuple) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...startedWrapper, process: tuple },
      wrapperStatError: "ENOENT",
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text).w1).toBe(0);
    expect(text).not.toMatch(/PRIVATE|271828|123456/);
    expect(
      d.openReceipt.mock.calls.some(([file]) => file.startsWith("/proc/")),
    ).toBe(false);
  },
);

it.each([{ phase: "completed", exit: 0 }, { session_key: "a".repeat(64) }])(
  "does not probe a completed or other-session wrapper receipt (%j)",
  (override) => {
    const d = daemon({
      missingPath: directory + "/sockets/default.sock",
      receipt: { ...startedWrapper, ...override },
      wrapperStat: procStat(),
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value.wrapper_receipt_version).toBe(1);
    expect(value).not.toHaveProperty("w1");
    expect(
      d.openReceipt.mock.calls.some(([file]) => file.startsWith("/proc/")),
    ).toBe(false);
  },
);

it("reports a visible started wrapper at the unchanged connected-response deadline", () => {
  const d = daemon({ receipt: startedWrapper, wrapperStat: procStat() });
  d.socket.emit("connect");
  d.timeout();
  expect(d.exit).toHaveBeenCalledWith(3);
  expect(d.socket.destroy).toHaveBeenCalled();
  expect(d.connect).toHaveBeenCalledTimes(1);
  expect(JSON.parse(d.output.mock.calls[0][0])).toMatchObject({
    deadline: [1, "awaiting_response"],
    wrapper_phase: "started",
    w1: 3,
  });
});

it("leaves a successful response unprobed even for a started selected wrapper", () => {
  const d = daemon({ receipt: startedWrapper, wrapperStat: procStat() });
  const response = { id: "hackerai-preview", success: true, data: {} };
  d.reply(response);
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  expect(d.openReceipt).not.toHaveBeenCalled();
});

it("fits the incarnation code beside every maximal existing field within544 without changing them", () => {
  const longest = { ...receipt, at: Date.now() + 60_000, exit: 999 };
  const maximal = (process?: unknown) =>
    daemon({
      missingPath: directory + "/sockets",
      missingCode: "ENOTDIR",
      pidFile: "314159",
      processVisibility: "same_uid",
      cliReceipt: [1, 1, 999999999],
      wrapperStat: procStat(),
      receipt: {
        ...longest,
        action: "version",
        phase: "started",
        exit: null,
        open_receipt_support: 1,
        close_receipt_support: 1,
        history: [1, true, true],
        process,
      },
      openReceipt: {
        ...longest,
        action: "open",
        exit: 0,
        idle_env_version: 1,
        idle_env: "unparsed",
      },
      closeReceipt: { ...longest, action: "close", close_all: false },
    }).output.mock.calls[0][0];
  const text = maximal(startedWrapper.process);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
  const { w1, ...existing } = JSON.parse(text);
  expect(w1).toBe(3);
  const { w1: legacy, ...withoutIdentity } = JSON.parse(maximal(undefined));
  expect(legacy).toBe(0);
  expect(existing).toEqual(withoutIdentity);
  expect(existing).toMatchObject({
    diagnostic_reason: "sockets_stat",
    diagnostic_error: "not_directory",
    wrapper_action: "version",
    wrapper_age: "unknown",
    h1: 3,
    open_exit: 0,
    open_age: "unknown",
    open_idle: [1, "unparsed"],
    p1: [1, 2, 0],
    cv: [1, 1, 999999999],
    close_receipt: [
      1,
      "recorded",
      "completed",
      "other",
      "selected_session",
      "unknown",
      "same_time",
    ],
  });
});

const missingSocket = { missingPath: directory + "/sockets/default.sock" };

it.each([0, 1, 2, 3, 4])(
  "projects the selected successful OPEN's at-return socket code %s without touching the socket",
  (code) => {
    const d = daemon({
      ...missingSocket,
      receipt: { ...receipt, action: "version", open_receipt_support: 1 },
      openReceipt: { ...successfulOpen, os1: code },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    expect(
      d.openReceipt.mock.calls.some(([file]) => file.endsWith(".sock")),
    ).toBe(false);
    const text = d.output.mock.calls[0][0];
    // The capture-time precondition stays separate from the at-return code.
    expect(JSON.parse(text)).toMatchObject({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
      open_phase: "completed",
      open_exit: 0,
      open_session_matches: true,
      p1: [1, 0, 0],
      os1: code,
    });
    expectPacketBudgets(text);
    expect(text).not.toMatch(/PRIVATE|\/dev\/shm|default|\.sock/);
  },
);

it.each<[string, Record<string, unknown>]>([
  ["a STARTED OPEN", { phase: "started", exit: null }],
  ["a failed OPEN", { exit: 37 }],
  ["a signal-terminated OPEN", { exit: -15 }],
  ["another session's OPEN", { session_key: "a".repeat(64) }],
  ["an out-of-range code", { os1: 5 }],
  ["a negative code", { os1: -1 }],
  ["a fractional code", { os1: 1.5 }],
  ["a string code", { os1: "1" }],
  ["a tuple", { os1: [1, 1] }],
  ["a boolean", { os1: true }],
  ["null", { os1: null }],
  ["an older writer", { os1: undefined }],
])("omits the at-return socket code for %s", (_case, override) => {
  const d = daemon({
    ...missingSocket,
    receipt: { ...receipt, action: "version", open_receipt_support: 1 },
    openReceipt: { ...successfulOpen, os1: 1, ...override },
  });
  expect(d.exit).toHaveBeenCalledWith(2);
  const value = JSON.parse(d.output.mock.calls[0][0]);
  // Every other bounded open observation remains; absence is never "missing".
  expect(value).toMatchObject({
    diagnostic_reason: "socket_stat",
    open_receipt_status: "recorded",
  });
  expect(value).not.toHaveProperty("os1");
  expect(JSON.stringify(value)).not.toContain("PRIVATE");
});

it("does not read or add the at-return socket code to a successful daemon response", () => {
  const d = daemon({
    receipt: { ...receipt, open_receipt_support: 1 },
    openReceipt: { ...successfulOpen, os1: 2 },
  });
  const response = { id: "hackerai-preview", success: true, data: {} };
  d.reply(response);
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  expect(d.openReceipt).not.toHaveBeenCalled();
});

it.each([0, 1, 2, 3])(
  "forwards the selected successful OPEN's informational-token code %s beside os1",
  (code) => {
    const d = daemon({
      ...missingSocket,
      receipt: { ...receipt, action: "version", open_receipt_support: 1 },
      openReceipt: { ...successfulOpen, os1: 2, o1: code },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text)).toMatchObject({
      diagnostic_reason: "socket_stat",
      open_phase: "completed",
      open_exit: 0,
      open_session_matches: true,
      p1: [1, 0, 0],
      os1: 2,
      o1: code,
    });
    expectPacketBudgets(text);
    expect(text).not.toMatch(/PRIVATE|\/dev\/shm|default|\.sock/);
  },
);

it.each<[string, Record<string, unknown>, boolean]>([
  ["a STARTED OPEN", { phase: "started", exit: null }, false],
  ["a failed OPEN", { exit: 37 }, false],
  ["another session's OPEN", { session_key: "a".repeat(64) }, false],
  ["an out-of-range code", { o1: 4 }, true],
  ["a negative code", { o1: -1 }, true],
  ["a fractional code", { o1: 1.5 }, true],
  ["a string code", { o1: "1" }, true],
  ["null", { o1: null }, true],
  ["an older writer", { o1: undefined }, true],
])(
  "omits the informational-token code for %s without dropping os1",
  (_case, override, selected) => {
    const d = daemon({
      ...missingSocket,
      receipt: { ...receipt, action: "version", open_receipt_support: 1 },
      openReceipt: { ...successfulOpen, os1: 2, o1: 3, ...override },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value).toMatchObject({
      diagnostic_reason: "socket_stat",
      open_receipt_status: "recorded",
    });
    expect(value).not.toHaveProperty("o1");
    // The selected successful OPEN's existing code is independent of o1.
    expect(value.os1).toBe(selected ? 2 : undefined);
  },
);

/** A status request whose selected socket is absent after a plain missing-socket OPEN. */
const missingDirectory = (
  open: Record<string, unknown> = {},
  options: Parameters<typeof daemon>[0] = {},
) =>
  daemon({
    ...missingSocket,
    receipt: { ...receipt, action: "version", open_receipt_support: 1 },
    openReceipt: { ...successfulOpen, os1: 2, o1: 0, sd1: 2, ...open },
    ...options,
  });

it.each([0, 1, 2])(
  "forwards the plain missing-socket OPEN's socket-directory code %s at a missing status socket",
  (code) => {
    const d = missingDirectory({ sd1: code });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    const { sd1, ...existing } = JSON.parse(text);
    expect(sd1).toBe(code);
    // Identical to an older writer's packet apart from the one new code.
    expect(existing).toEqual(
      JSON.parse(missingDirectory({ sd1: undefined }).output.mock.calls[0][0]),
    );
    expect(existing).toMatchObject({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
      os1: 2,
      o1: 0,
    });
    expectPacketBudgets(text);
    expect(text).not.toMatch(/PRIVATE|\/dev\/shm|default|\.sock/);
  },
);

it.each<[string, Record<string, unknown>, Parameters<typeof daemon>[0]]>([
  ["an older writer", { sd1: undefined }, {}],
  ["an out-of-range code", { sd1: 3 }, {}],
  ["a negative code", { sd1: -1 }, {}],
  ["a fractional code", { sd1: 0.5 }, {}],
  ["a string code", { sd1: "0" }, {}],
  ["null", { sd1: null }, {}],
  ["a private value", { sd1: "/PRIVATE/sockets" }, {}],
  ["an owned socket at return", { os1: 1 }, {}],
  ["an unreadable socket at return", { os1: 4 }, {}],
  ["help tokens", { o1: 1 }, {}],
  ["an older informational writer", { o1: undefined }, {}],
  ["a STARTED OPEN", { phase: "started", exit: null }, {}],
  ["a failed OPEN", { exit: 37 }, {}],
  ["another session's OPEN", { session_key: "a".repeat(64) }, {}],
  ["a screenshot request", {}, { request: { action: "screenshot" } }],
  ["a viewport request", {}, { action: "viewport" }],
  ["an unreadable status socket", {}, { missingCode: "EACCES" }],
  [
    "a missing sockets directory",
    {},
    { missingPath: directory + "/sockets", missingCode: "ENOENT" },
  ],
])(
  "omits the socket-directory code for %s without changing the failure",
  (_case, open, options) => {
    const d = missingDirectory(open, options);
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value).toHaveProperty("diagnostic_reason");
    expect(value).not.toHaveProperty("sd1");
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
  },
);

it("drops the socket-directory code first, before o1 or any existing field, at the544 cap", () => {
  // Every other optional selected-OPEN code is present beside the new one.
  const near = (sd1?: number, chargedBytes?: number) =>
    missingDirectory(
      { sd1, idle_env_version: 1, idle_env: "unparsed" },
      {
        chargedBytes,
        pidFile: "314159",
        processVisibility: "same_uid",
        cliReceipt: [1, 1, 999999999],
        versionFile: "999.999.999",
      },
    ).output.mock.calls[0][0] as string;
  const complete = near(2);
  expectPacketBudgets(complete);
  expect(JSON.parse(complete)).toMatchObject({
    sd1: 2,
    os1: 2,
    o1: 0,
    dv: [1, 1, 999999999],
  });
  // One byte over the cap drops only sd1; every existing field remains.
  const justOver = near(2, 545 - Buffer.byteLength(complete));
  expect(JSON.parse(justOver)).toEqual(JSON.parse(near()));
});

/** Maximal legacy context, optionally with a started wrapper's w1 and an os1 code. */
const maximalOpenSocket = (started: boolean, os1?: number, exit = 999) => {
  const longest = { ...receipt, at: Date.now() + 60_000, exit };
  return daemon({
    missingPath: directory + "/sockets",
    missingCode: "ENOTDIR",
    pidFile: "314159",
    processVisibility: "same_uid",
    cliReceipt: [1, 1, 999999999],
    wrapperStat: procStat(),
    receipt: {
      ...longest,
      action: "version",
      ...(started
        ? { phase: "started", exit: null, process: startedWrapper.process }
        : { session_key: "a".repeat(64) }),
      open_receipt_support: 1,
      close_receipt_support: 1,
      history: [1, true, true],
    },
    openReceipt: {
      ...longest,
      action: "open",
      exit: 0,
      idle_env_version: 1,
      idle_env: "unparsed",
      os1,
    },
    closeReceipt: { ...longest, action: "close", close_all: false },
  }).output.mock.calls[0][0];
};

it.each([true, false])(
  "drops the at-return socket code before w1 or any existing field at the544 cap (started wrapper:%s)",
  (started) => {
    const text = maximalOpenSocket(started, 4);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
    const value = JSON.parse(text);
    expect(value).not.toHaveProperty("os1");
    expect(value.w1).toBe(started ? 3 : undefined);
    // Identical to an older writer's packet: no previous field or w1 displaced.
    expect(value).toEqual(JSON.parse(maximalOpenSocket(started)));
    expect(value).toMatchObject({
      diagnostic_reason: "sockets_stat",
      diagnostic_error: "not_directory",
      wrapper_phase: started ? "started" : "completed",
      h1: 3,
      open_exit: 0,
      open_idle: [1, "unparsed"],
      p1: [1, 2, 0],
      cv: [1, 1, 999999999],
      close_receipt: [
        1,
        "recorded",
        "completed",
        "other",
        "selected_session",
        "unknown",
        "same_time",
      ],
    });
  },
);

it("retains the at-return socket code in a near-cap packet that still fits", () => {
  // A numeric last-command/close exit leaves just enough room beside the code.
  const text = maximalOpenSocket(false, 4, 255);
  expect(Buffer.byteLength(text)).toBeGreaterThan(512);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
  const { os1, ...existing } = JSON.parse(text);
  expect(os1).toBe(4);
  expect(existing).toEqual(
    JSON.parse(maximalOpenSocket(false, undefined, 255)),
  );
  expect(existing).toMatchObject({ wrapper_exit: 255, h1: 3, p1: [1, 2, 0] });
});

/** Near-cap selected-OPEN context beside a valid sockets directory, at a
 * missing-socket precondition, with optional declared category and sidecar. */
const nearCapDeclaration = (
  closeExit: number,
  missingCode: string,
  { k1, versionFile }: { k1?: number; versionFile?: string } = {},
) => {
  const longest = { ...receipt, at: Date.now() + 60_000, exit: closeExit };
  return daemon({
    missingPath: directory + "/sockets/default.sock",
    missingCode,
    pidFile: "314159",
    processVisibility: "same_uid",
    cliReceipt: [1, 1, 999999999],
    wrapperStat: procStat(),
    versionFile,
    receipt: {
      ...longest,
      action: "other",
      phase: "started",
      exit: null,
      process: startedWrapper.process,
      open_receipt_support: 1,
      close_receipt_support: 1,
      history: [1, true, true],
      k1,
    },
    openReceipt: {
      ...longest,
      action: "open",
      exit: 0,
      idle_env_version: 1,
      idle_env: "unparsed",
      os1: 4,
    },
    closeReceipt: { ...longest, action: "close", close_all: false },
  }).output.mock.calls[0][0];
};

it.each<[number, string, number | undefined, number | undefined]>([
  [999, "ENOENT", undefined, 4], // Both new fields drop; os1 and w1 remain.
  [255, "ENOENT", 6, 4], // Exactly at the cap: the declaration drops before k1.
  [999, "ENOTDIR", undefined, undefined], // The existing os1 rule is unchanged.
])(
  "drops the declaration, then the category, before os1/w1 or any existing field at the544 cap (close exit %s, %s)",
  (closeExit, missingCode, k1, os1) => {
    const text = nearCapDeclaration(closeExit, missingCode, {
      k1: 6,
      versionFile: "999.999.999",
    });
    expectPacketBudgets(text);
    const { dv, k1: category, ...existing } = JSON.parse(text);
    expect(dv).toBeUndefined();
    expect(category).toBe(k1);
    expect(existing.os1).toBe(os1);
    expect(existing.w1).toBe(3);
    // The same packet without the new inputs keeps identical existing context.
    const {
      dv: _missing,
      k1: _absent,
      ...baseline
    } = JSON.parse(nearCapDeclaration(closeExit, missingCode));
    expect(existing).toEqual(baseline);
    expect(existing).toMatchObject({
      diagnostic_reason: "socket_stat",
      wrapper_phase: "started",
      h1: 3,
      open_exit: 0,
      open_idle: [1, "unparsed"],
      p1: [1, 3, 2],
      cv: [1, 1, 999999999],
    });
    expect(text).not.toMatch(/PRIVATE|314159|271828|default|\/dev\/shm/);
  },
);

const versionPath = directory + "/sockets/default.version";
/** A missing-socket failure after the selected session's successful OPEN. */
const selectedOpenFailure = {
  ...missingSocket,
  receipt: { ...receipt, action: "version", open_receipt_support: 1 },
  openReceipt: successfulOpen,
};

it.each<[string, DaemonOptions, unknown[], boolean]>([
  ["the upstream release", { versionFile: "0.39.3" }, [1, 1, 39003], true],
  [
    "the maximal release",
    { versionFile: "999.999.999" },
    [1, 1, 999999999],
    true,
  ],
  ["a trailing newline", { versionFile: "0.39.3\n" }, [1, 1, 39003], true],
  ["missing", {}, [1, 2], false],
  ["a symlink", { versionFile: "0.39.3", versionSymlink: true }, [1, 3], false],
  ["a FIFO", { versionFile: "0.39.3", versionFifo: true }, [1, 3], false],
  ["another owner", { versionFile: "0.39.3", versionOwner: 0 }, [1, 3], false],
  [
    "group-writable",
    { versionFile: "0.39.3", versionMode: 0o664 },
    [1, 3],
    false,
  ],
  [
    "world-writable",
    { versionFile: "0.39.3", versionMode: 0o646 },
    [1, 3],
    false,
  ],
  ["oversized", { versionFile: "0.39.3", versionSize: 33 }, [1, 3], false],
  [
    "grown past its stat size",
    { versionFile: "0.39.3" + " ".repeat(40), versionSize: 6 },
    [1, 3],
    true,
  ],
  ["permission", { versionError: "EACCES" }, [1, 3], false],
  [
    "an unexpected read failure",
    { versionFile: "0.39.3", versionReadError: true },
    [1, 0],
    true,
  ],
  ["empty", { versionFile: "" }, [1, 4], true],
  ["a component above 999", { versionFile: "1000.0.0" }, [1, 4], true],
  ["two components", { versionFile: "0.39" }, [1, 4], true],
  ["four components", { versionFile: "0.39.3.1" }, [1, 4], true],
  ["a leading zero", { versionFile: "0.039.3" }, [1, 4], true],
  ["a prerelease", { versionFile: "0.40.0-beta.1" }, [1, 4], true],
  ["text", { versionFile: "PRIVATE" }, [1, 4], true],
])(
  "reports the selected daemon's version declaration when %s without changing the failure",
  (_case, options, expected, opened) => {
    const d = daemon({ ...selectedOpenFailure, ...options });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text)).toMatchObject({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
      open_exit: 0,
      dv: expected,
    });
    expectPacketBudgets(text);
    expect(text).not.toMatch(/PRIVATE|\/dev\/shm|default|\.version|beta/);
    // Only an owned, regular, non-writable-by-others file is opened, without
    // following links or blocking, and read at most once.
    const opens = d.openReceipt.mock.calls.filter(([file]) =>
      file.endsWith(".version"),
    );
    expect(opens).toEqual(opened ? [[versionPath, 256 | 2048]] : []);
    expect(d.readReceipt.mock.calls.filter(([fd]) => fd === 13).length).toBe(
      opened ? 1 : 0,
    );
    if (opened) expect(d.closeReceipt).toHaveBeenCalledWith(13);
  },
);

it.each<[string, DaemonOptions]>([
  ["no wrapper receipt", { receipt: undefined }],
  ["an older writer without open receipts", { receipt }],
  ["a STARTED OPEN", { openReceipt: { ...successfulOpen, phase: "started" } }],
  ["a failed OPEN", { openReceipt: { ...successfulOpen, exit: 37 } }],
  ["a fractional OPEN exit", { openReceipt: { ...successfulOpen, exit: 0.5 } }],
  [
    "another session's OPEN",
    { openReceipt: { ...successfulOpen, session_key: "a".repeat(64) } },
  ],
  ["an unowned sockets directory", { unownedPath: directory + "/sockets" }],
  ["a group-accessible sockets directory", { socketsMode: 0o750 }],
  [
    "a sockets path that is not a directory",
    { missingPath: directory + "/sockets", missingCode: "ENOTDIR" },
  ],
])(
  "neither reads nor reports a version declaration for %s",
  (_case, override) => {
    const d = daemon({
      ...selectedOpenFailure,
      versionFile: "0.39.3",
      ...override,
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(JSON.parse(d.output.mock.calls[0][0])).not.toHaveProperty("dv");
    expect(d.lstat.mock.calls.some(([file]) => file.endsWith(".version"))).toBe(
      false,
    );
    expect(
      d.openReceipt.mock.calls.some(([file]) => file.endsWith(".version")),
    ).toBe(false);
  },
);

it("reads only the selected session's declaration beside its socket", () => {
  const key = createHash("sha256").update("PRIVATE_SELECTED").digest("hex");
  const d = daemon({
    name: "PRIVATE_SELECTED",
    missingPath: directory + "/sockets/PRIVATE_SELECTED.sock",
    receipt: {
      ...receipt,
      session_key: key,
      action: "version",
      open_receipt_support: 1,
    },
    openReceipt: { ...successfulOpen, session_key: key },
    versionFile: "0.39.3",
  });
  const text = d.output.mock.calls[0][0];
  expect(JSON.parse(text).dv).toEqual([1, 1, 39003]);
  expect(
    d.lstat.mock.calls
      .map(([file]) => file)
      .filter((file) => file.endsWith(".version")),
  ).toEqual([directory + "/sockets/PRIVATE_SELECTED.version"]);
  expect(text).not.toContain("PRIVATE");
});

it("reports the declared wait category and selected daemon declaration at the unchanged response deadline", () => {
  const d = daemon({
    receipt: {
      ...startedWrapper,
      action: "other",
      open_receipt_support: 1,
      k1: 0,
    },
    openReceipt: { ...successfulOpen, os1: 1 },
    pidFile: "314159",
    processVisibility: "same_uid",
    wrapperStat: procStat(),
    versionFile: "0.39.3",
  });
  d.socket.emit("connect");
  d.timeout();
  expect(d.exit).toHaveBeenCalledWith(3);
  expect(d.socket.destroy).toHaveBeenCalled();
  // No new socket, request or retry: only the original status request.
  expect(d.connect).toHaveBeenCalledTimes(1);
  expect(d.socket.write).toHaveBeenCalledTimes(1);
  const text = d.output.mock.calls[0][0];
  expect(JSON.parse(text)).toMatchObject({
    deadline: [1, "awaiting_response"],
    wrapper_action: "other",
    wrapper_phase: "started",
    wrapper_session_matches: true,
    w1: 3,
    k1: 0,
    p1: [1, 3, 2],
    os1: 1,
    dv: [1, 1, 39003],
  });
  expectPacketBudgets(text);
  expect(text).not.toMatch(/PRIVATE|314159|271828|default|\/dev\/shm/);
});

it.each<[unknown, number | undefined]>([
  [0, 0],
  [3, 3],
  [7, 7],
  [8, undefined],
  [-1, undefined],
  [1.5, undefined],
  ["0", undefined],
  [true, undefined],
  [null, undefined],
  [[0], undefined],
  ["PRIVATE", undefined],
  [undefined, undefined], // An older writer is unmeasured.
])(
  "projects only a fixed declared-category code %j from the latest receipt",
  (k1, expected) => {
    const d = daemon({ ...missingSocket, receipt: { ...receipt, k1 } });
    expect(d.exit).toHaveBeenCalledWith(2);
    const text = d.output.mock.calls[0][0];
    const { k1: category, ...existing } = JSON.parse(text);
    expect(category).toBe(expected);
    // Every other field is the same as for a receipt without the code.
    expect(existing).toEqual(
      JSON.parse(daemon({ ...missingSocket, receipt }).output.mock.calls[0][0]),
    );
    expect(text).not.toContain("PRIVATE");
  },
);

it("neither reads the declaration nor adds the category to a successful response", () => {
  const d = daemon({
    receipt: { ...startedWrapper, open_receipt_support: 1, k1: 0 },
    openReceipt: successfulOpen,
    versionFile: "0.39.3",
  });
  const response = { id: "hackerai-preview", success: true, data: {} };
  d.reply(response);
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  expect(d.openReceipt).not.toHaveBeenCalled();
  expect(d.lstat.mock.calls.some(([file]) => file.endsWith(".version"))).toBe(
    false,
  );
});

const selectedSocket = directory + "/sockets/default.sock";
/** /proc/net/unix as Linux prints it: a %5lu inode, then a path that can contain spaces. */
const unixTable = (...rows: string[]) =>
  ["Num       RefCount Protocol Flags    Type St Inode Path", ...rows, ""].join(
    "\n",
  );
const unixRow = (inode: number, address?: string, listening = true) =>
  `0000000000000000: 00000002 00000000 ${listening ? "00010000" : "00000000"} 0001 ${listening ? "01" : "03"} ${String(inode).padStart(5)}${address === undefined ? "" : ` ${address}`}`;
/** /proc/net/tcp: host-order (little-endian) hex address:port, 0A is LISTEN, field 10 the inode. */
const tcpTable = (...rows: string[]) =>
  [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    ...rows,
    "",
  ].join("\n");
const tcpRow = (
  inode: number,
  { local = "0100007F", port = 9223, state = "0A" } = {},
) =>
  `   0: ${local}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`.padEnd(
    149,
  );
const descriptors = (fillers: number, ...links: string[]) =>
  Object.fromEntries(
    [...Array.from({ length: fillers }, () => "/dev/null"), ...links].map(
      (link, index) => [String(index), link],
    ),
  );
const ownedFds = {
  "0": "/dev/null",
  "3": "socket:[4242]",
  "4": "anon_inode:[eventfd]",
  "7": "socket:[4243]",
  "9": "socket:[5151]",
};
/** The selected daemon holds both listeners while a serialized wait is connected. */
const ownedState: OwnedState = {
  stream: "9223",
  unix: unixTable(
    unixRow(4100),
    unixRow(4242, selectedSocket),
    // The accepted wait connection inherits the listener's path.
    unixRow(4243, selectedSocket, false),
    unixRow(4300, directory + "/sockets/other session.sock"),
  ),
  tcp: tcpTable(
    tcpRow(5151),
    tcpRow(5152, { state: "01" }),
    tcpRow(5200, { port: 9224 }),
  ),
  fds: ownedFds,
};
const ownedRequest = { action: "stream_status", owned_port: true };
const ownedDaemon = (options: DaemonOptions = {}, owned: OwnedState = {}) =>
  daemon({
    pidFile: "314159",
    request: ownedRequest,
    ...options,
    owned: { ...ownedState, ...owned },
  });

it.each<[string, DaemonOptions, OwnedState, number]>([
  ["the upstream plain sidecars", {}, {}, 9223],
  [
    "newline-terminated sidecars",
    { pidFile: "314159\n" },
    { stream: "9223\n" },
    9223,
  ],
  [
    "the highest port",
    {},
    { stream: "65535", tcp: tcpTable(tcpRow(5151, { port: 65535 })) },
    65535,
  ],
  [
    "both listeners at the descriptor cap",
    {},
    { fds: descriptors(254, "socket:[4242]", "socket:[5151]") },
    9223,
  ],
])(
  "returns only a port held by the selected daemon's own Unix and loopback listeners (%s)",
  (_case, options, owned, port) => {
    const d = ownedDaemon(options, owned);
    expect(d.exit).toHaveBeenCalledWith(0);
    // No serialized daemon request, so the preview is not queued behind a wait.
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    // Never a fabricated connection, health or freshness claim.
    expect(JSON.parse(text)).toEqual({
      id: "hackerai-preview",
      success: true,
      data: { port },
    });
    expect(text).not.toMatch(/314159|4242|5151|\/proc|\/dev\/shm|default/);
    // Only fixed tables and the recorded PID's descriptors; never a process scan.
    expect(
      d.openReceipt.mock.calls.filter(([file]) => file.startsWith("/proc/")),
    ).toEqual([
      ["/proc/net/unix", 256 | 2048],
      ["/proc/net/tcp", 256 | 2048],
    ]);
    expect(d.openReceipt).toHaveBeenCalledWith(
      directory + "/sockets/default.stream",
      256 | 2048,
    );
    expect(d.openReceipt).toHaveBeenCalledWith(
      directory + "/sockets/default.pid",
      256 | 2048,
    );
    for (const fd of [10, 14, 15, 16])
      expect(d.closeReceipt).toHaveBeenCalledWith(fd);
    expect(d.openDescriptors.mock.calls).toEqual([["/proc/314159/fd"]]);
    expect(d.closeDescriptors).toHaveBeenCalledTimes(1);
    expect(d.readLink.mock.calls.length).toBeLessThanOrEqual(256);
  },
);

const unixFiller = Array.from({ length: 2000 }, (_, index) =>
  unixRow(10000 + index, "/tmp/" + "x".repeat(100)),
);
const tcpFiller = Array.from({ length: 2000 }, (_, index) =>
  tcpRow(10000 + index, { port: 10000 + index }),
);

it.each<[string, DaemonOptions, OwnedState]>([
  ["the stream sidecar is missing", {}, { stream: undefined }],
  ...[
    "0",
    "65536",
    "09223",
    " 9223",
    "9223 ",
    "9223\r\n",
    "9223\n\n",
    "+9223",
    "9223.0",
    "PRIVATE",
    '{"port":9223}',
    "",
  ].map((stream): [string, DaemonOptions, OwnedState] => [
    `the stream sidecar is ${JSON.stringify(stream)}`,
    {},
    { stream },
  ]),
  ["the stream sidecar is a symlink", {}, { streamSymlink: true }],
  ["the stream sidecar is a FIFO", {}, { streamFifo: true }],
  ["another user owns the stream sidecar", {}, { streamOwner: 0 }],
  ["the stream sidecar is group-writable", {}, { streamMode: 0o664 }],
  ["the stream sidecar is world-writable", {}, { streamMode: 0o646 }],
  ["the stream sidecar exceeds its bound", {}, { streamSize: 12 }],
  ["the sockets directory is group-accessible", { socketsMode: 0o750 }, {}],
  ["the root directory is group-accessible", { rootMode: 0o710 }, {}],
  ["the PID sidecar is missing", { pidFile: undefined }, {}],
  ["the PID sidecar is malformed", { pidFile: "PRIVATE" }, {}],
  ["the PID sidecar is zero", { pidFile: "0" }, {}],
  ["the PID exceeds the kernel limit", { pidFile: "4194305" }, {}],
  ["the PID sidecar is a symlink", { pidSymlink: true }, {}],
  ["another user owns the PID sidecar", { pidOwner: 0 }, {}],
  ["the PID sidecar is group-writable", { pidMode: 0o664 }, {}],
  ["the recorded process is gone", { processVisibility: "missing" }, {}],
  [
    "another user runs the recorded PID",
    { processVisibility: "other_uid" },
    {},
  ],
  ["procfs denies the process", { processVisibility: "permission" }, {}],
  ["procfs is unavailable", { procUnavailable: true }, {}],
  ["/proc is not procfs", { procfsType: 0x01021994 }, {}],
  ["the recorded port is stale", {}, { stream: "9225" }],
  [
    "another process listens on the recorded port",
    {},
    { fds: { "3": "socket:[4242]" } },
  ],
  [
    "another process holds the selected Unix listener",
    {},
    { fds: { "9": "socket:[5151]" } },
  ],
  [
    "the PID was reused by an unrelated process",
    {},
    { fds: { "0": "/dev/null", "1": "pipe:[4242]", "2": "pipe:[5151]" } },
  ],
  [
    "only an accepted connection has the selected path",
    {},
    {
      unix: unixTable(unixRow(4243, selectedSocket, false)),
      fds: { "7": "socket:[4243]", "9": "socket:[5151]" },
    },
  ],
  [
    "the listener only shares the selected path's prefix",
    {},
    { unix: unixTable(unixRow(4242, selectedSocket + ".old")) },
  ],
  [
    "the listener belongs to another session",
    {},
    { unix: unixTable(unixRow(4242, directory + "/sockets/other.sock")) },
  ],
  [
    "two listeners claim the selected path",
    {},
    {
      unix: unixTable(
        unixRow(4242, selectedSocket),
        unixRow(4244, selectedSocket),
      ),
      fds: { ...ownedFds, "11": "socket:[4244]" },
    },
  ],
  [
    "two loopback listeners share the port",
    {},
    {
      tcp: tcpTable(tcpRow(5151), tcpRow(5153)),
      fds: { ...ownedFds, "11": "socket:[5153]" },
    },
  ],
  [
    "the port listener is not loopback",
    {},
    { tcp: tcpTable(tcpRow(5151, { local: "00000000" })) },
  ],
  [
    "the port socket is not listening",
    {},
    { tcp: tcpTable(tcpRow(5151, { state: "01" })) },
  ],
  [
    "the Unix table exceeds its bound",
    {},
    { unix: unixTable(unixRow(4242, selectedSocket), ...unixFiller) },
  ],
  [
    "the TCP table exceeds its bound",
    {},
    { tcp: tcpTable(tcpRow(5151), ...tcpFiller) },
  ],
  ["procfs denies the tables", {}, { tableError: "EACCES" }],
  ["procfs denies the descriptor list", {}, { fdError: "EACCES" }],
  ["a descriptor cannot be read", {}, { linkError: "EACCES" }],
  [
    "the listeners lie beyond the descriptor cap",
    {},
    { fds: descriptors(256, "socket:[4242]", "socket:[5151]") },
  ],
])(
  "keeps the unchanged daemon request and deadline packet when %s",
  (_case, options, owned) => {
    const deadline = (request: Record<string, unknown>) => {
      const d = ownedDaemon({ ...options, request }, owned);
      expect(d.exit).not.toHaveBeenCalled();
      expect(d.connect.mock.calls).toEqual([[selectedSocket]]);
      d.socket.emit("connect");
      d.timeout();
      expect(d.exit.mock.calls).toEqual([[3]]);
      return [d.socket.write.mock.calls, d.output.mock.calls[0][0]];
    };
    const [writes, text] = deadline(ownedRequest);
    // Byte-identical to a request that never opted in: the flag is internal.
    expect(writes).toEqual([
      ['{"action":"stream_status","id":"hackerai-preview"}\n'],
    ]);
    expect(text).toBe(deadline({ action: "stream_status" })[1]);
    expect(JSON.parse(text).deadline).toEqual([1, "awaiting_response"]);
    expect(text).not.toMatch(/PRIVATE|314159|9223|4242|5151/);
  },
);

it.each<Record<string, unknown>>([
  { action: "stream_status" },
  { action: "stream_status", owned_port: "true" },
  { action: "stream_status", owned_port: 1 },
  {
    action: "screenshot",
    path: directory + "/preview.jpg",
    format: "jpeg",
    quality: 65,
    owned_port: true,
  },
  {
    action: "viewport",
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    owned_port: true,
  },
])(
  "never reads the stream sidecar or procfs for a request without the exact status opt-in: %j",
  (request) => {
    const d = ownedDaemon({ request });
    expect(d.connect.mock.calls).toEqual([[selectedSocket]]);
    d.socket.emit("connect");
    const { owned_port: _flag, ...wire } = request;
    expect(d.socket.write.mock.calls).toEqual([
      [JSON.stringify({ ...wire, id: "hackerai-preview" }) + "\n"],
    ]);
    expect(d.lstat.mock.calls.some(([file]) => file.endsWith(".stream"))).toBe(
      false,
    );
    expect(d.openReceipt).not.toHaveBeenCalled();
    expect(d.openDescriptors).not.toHaveBeenCalled();
    const response = {
      id: "hackerai-preview",
      success: true,
      data: { connected: true, port: 9223 },
    };
    d.reply(response);
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  },
);

/** The selected session's still-running WAIT: the reproduced lock holder. */
const activeWait = { ...startedWrapper, action: "other", k1: 0 };
const deferRequest = { action: "stream_status", defer_wait: true };
const waitDaemon = (options: DaemonOptions = {}, owned: OwnedState = {}) =>
  ownedDaemon(
    {
      request: deferRequest,
      receipt: activeWait,
      wrapperStat: procStat(),
      ...options,
    },
    owned,
  );

/** A fresh preview's screenshot after its status already answered. */
const deferScreenshot = {
  action: "screenshot",
  path: directory + "/preview.jpg",
  format: "jpeg",
  quality: 65,
  defer_wait: true,
};

it.each([
  ["status request", deferRequest],
  // The reproduced gap: a WAIT that started after status already answered.
  ["screenshot", deferScreenshot],
])(
  "yields a fresh %s to a verified same-session WAIT with only the helper literal",
  (_case, request) => {
    const d = waitDaemon({ request });
    expect(d.exit.mock.calls).toEqual([[0]]);
    // Never queued behind the WAIT that holds the daemon state lock.
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.output.mock.calls).toEqual([[BROWSER_DAEMON_WAIT_DEFERRED]]);
    // Exact wrapper incarnation and the daemon's own listeners were both checked.
    expect(d.openReceipt).toHaveBeenCalledWith("/proc/271828/stat", 256 | 2048);
    expect(d.openDescriptors.mock.calls).toEqual([["/proc/314159/fd"]]);
  },
);

const declinedWaitCases: [string, DaemonOptions, OwnedState][] = [
  ["no wrapper receipt exists", { receipt: undefined }, {}],
  [
    "the WAIT belongs to another session",
    { receipt: { ...activeWait, session_key: "a".repeat(64) } },
    {},
  ],
  [
    "the WAIT completed",
    { receipt: { ...activeWait, phase: "completed", exit: 0 } },
    {},
  ],
  [
    "the latest command is not a WAIT",
    { receipt: { ...activeWait, k1: 1 } },
    {},
  ],
  [
    "an older writer omitted the command class",
    { receipt: { ...activeWait, k1: undefined } },
    {},
  ],
  [
    "the WAIT wrapper is a zombie",
    { wrapperStat: procStat({ state: "Z" }) },
    {},
  ],
  [
    "the WAIT wrapper's PID was reused",
    { wrapperStat: procStat({ ticks: "123457" }) },
    {},
  ],
  ["the WAIT wrapper is gone", { wrapperStatError: "ENOENT" }, {}],
  ["procfs is unavailable", { procUnavailable: true }, {}],
  ["the stream sidecar is missing", {}, { stream: undefined }],
  [
    "another process holds the selected Unix listener",
    {},
    { fds: { "9": "socket:[5151]" } },
  ],
  ["the recorded port is stale", {}, { stream: "9225" }],
  ["the opt-in is a string", { request: { defer_wait: "true" } }, {}],
  ["the opt-in is numeric", { request: { defer_wait: 1 } }, {}],
];

it.each(declinedWaitCases)(
  "sends the original strict request without the internal flag when %s",
  (_case, options, owned) => {
    const observe = (request: Record<string, unknown>) => {
      const d = waitDaemon({ ...options, request }, owned);
      expect(d.exit).not.toHaveBeenCalled();
      expect(d.connect.mock.calls).toEqual([[selectedSocket]]);
      d.socket.emit("connect");
      d.timeout();
      expect(d.exit.mock.calls).toEqual([[3]]);
      return [d.socket.write.mock.calls, d.output.mock.calls[0][0]];
    };

    for (const request of [deferRequest, deferScreenshot]) {
      const { defer_wait: _flag, ...unopted } = request;
      const [wire, output] = observe({ ...request, ...options.request });
      expect(wire).toEqual([
        [JSON.stringify({ ...unopted, id: "hackerai-preview" }) + "\n"],
      ]);
      expect(output).toBe(observe(unopted)[1]);
      expect(output).not.toContain("wait_deferred");
    }
  },
);

it("passes a strict daemon reply through unchanged after a declined deferral", () => {
  const d = waitDaemon({ receipt: { ...activeWait, k1: 1 } });
  d.socket.emit("connect");
  const response = {
    id: "hackerai-preview",
    success: true,
    data: { connected: true, port: 9223 },
    wait_deferred: 1,
  };
  d.reply(response);
  expect(d.exit.mock.calls).toEqual([[0]]);
  const text = d.output.mock.calls[0][0];
  // A daemon reply always carries its own id, so it can never equal the literal.
  expect(text).not.toBe(BROWSER_DAEMON_WAIT_DEFERRED);
  expect(JSON.parse(text)).toEqual(response);
});

const { defer_wait: _waitFlag, ...unoptedScreenshot } = deferScreenshot;

it.each<Record<string, unknown>>([
  { action: "stream_status", defer_wait: true, owned_port: true },
  { ...deferScreenshot, owned_port: true },
  unoptedScreenshot,
  {
    action: "viewport",
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    defer_wait: true,
  },
])(
  "never defers outside an opted-in fresh status or screenshot: %j",
  (request) => {
    const d = waitDaemon({ request });
    expect(d.output.mock.calls.flat()).not.toContain(
      BROWSER_DAEMON_WAIT_DEFERRED,
    );
    // A status opt-in keeps its own listener shortcut; anything else is queued unchanged.
    if (request.action === "stream_status") {
      expect(d.exit.mock.calls).toEqual([[0]]);
      expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({
        id: "hackerai-preview",
        success: true,
        data: { port: 9223 },
      });
    } else {
      expect(d.exit).not.toHaveBeenCalled();
      d.socket.emit("connect");
      const { defer_wait: _flag, owned_port: _port, ...wire } = request;
      expect(d.socket.write.mock.calls).toEqual([
        [JSON.stringify({ ...wire, id: "hackerai-preview" }) + "\n"],
      ]);
    }
  },
);

const screenshotRequest = {
  action: "screenshot",
  path: directory + "/preview-PRIVATE.jpg",
  format: "jpeg",
  quality: 65,
};
/** First daemon response lines and the check that refuses each one. */
const refusedResponses: [string, string, number][] = [
  ["invalid JSON", "PRIVATE_BODY", 0],
  ["an empty line", "", 0],
  ["a truncated object", '{"id":"hackerai-preview","data":"PRIVATE', 0],
  ["null", "null", 1],
  ["an array", '["hackerai-preview",true,"PRIVATE"]', 1],
  ["a string", '"PRIVATE"', 1],
  ["a number", "7", 1],
  ["a boolean", "true", 1],
  ["another ID", '{"id":"PRIVATE_ID","success":true,"data":"PRIVATE"}', 2],
  ["a missing ID", '{"success":true,"data":"PRIVATE"}', 2],
  [
    "an own __proto__ key",
    '{"__proto__":{"id":"hackerai-preview","success":true}}',
    2,
  ],
  ["another ID with success false", '{"id":null,"success":false}', 2],
  [
    "success false",
    '{"id":"hackerai-preview","success":false,"error":"PRIVATE","data":"PRIVATE"}',
    3,
  ],
  ["a missing success", '{"id":"hackerai-preview","data":"PRIVATE"}', 4],
  ["a string success", '{"id":"hackerai-preview","success":"true"}', 4],
  ["a numeric success", '{"id":"hackerai-preview","success":1}', 4],
  ["a null success", '{"id":"hackerai-preview","success":null}', 4],
];

it.each(
  refusedResponses.flatMap(([name, line, refused]) =>
    [{ action: "stream_status" }, screenshotRequest].map(
      (request) => [name, request.action, line, refused, request] as const,
    ),
  ),
)(
  "keeps exit5 for %s at %s and records only its refusal code",
  (_case, action, line, refused, request) => {
    const d = daemon({ request });
    d.socket.emit("connect");
    d.socket.emit("data", line + "\n");
    // Neither a later valid line nor the deadline can replace the first refusal.
    d.socket.emit("data", '{"id":"hackerai-preview","success":true}\n');
    d.timeout();
    expect(d.exit.mock.calls).toEqual([[5]]);
    expect(d.socket.destroy).toHaveBeenCalled();
    expect(d.connect).toHaveBeenCalledTimes(1);
    expect(d.socket.write.mock.calls).toEqual([
      [JSON.stringify({ ...request, id: "hackerai-preview" }) + "\n"],
    ]);
    expect(d.output.mock.calls).toHaveLength(1);
    const text = d.output.mock.calls[0][0];
    // Only a screenshot's explicit success false adds its unrecognized error class.
    expect(JSON.parse(text)).toEqual({
      r1: [1, refused],
      ...(action === "screenshot" && refused === 3 && { s1: [1, 4] }),
      cv: [1, 0],
    });
    expect(text).not.toMatch(/PRIVATE|hackerai-preview|data|error|true/);
  },
);

it("returns a successful response unchanged without a refusal code or receipt reads", () => {
  const line =
    '{"id":"hackerai-preview","success":true,"data":{"connected":true,"port":9223},"r1":"daemon"}';
  const d = daemon({ receipt, request: screenshotRequest });
  d.socket.emit("connect");
  d.socket.emit("data", line + "\n");
  expect(d.exit.mock.calls).toEqual([[0]]);
  expect(d.output.mock.calls).toEqual([[line]]);
  expect(d.readReceipt).not.toHaveBeenCalled();
});

it("preserves exit5 when the refusal packet cannot be written", () => {
  const d = daemon({ receipt, stdoutThrows: true });
  d.socket.emit("connect");
  expect(() => d.socket.emit("data", "null\n")).not.toThrow();
  expect(d.exit.mock.calls).toEqual([[5]]);
});

/** Every maximal optional context field beside a connected daemon response. */
const maximalResponse = (
  line?: string,
  chargedBytes?: number,
  o1?: number,
  lr?: unknown,
  request?: Record<string, unknown>,
) => {
  const longest = { ...receipt, at: Date.now() + 60_000, exit: 999 };
  const d = daemon({
    request,
    chargedBytes,
    pidFile: "314159",
    processVisibility: "same_uid",
    cliReceipt: [1, 1, 999999999],
    wrapperStat: procStat(),
    versionFile: "999.999.999",
    receipt: {
      ...longest,
      action: "other",
      phase: "started",
      exit: null,
      process: startedWrapper.process,
      open_receipt_support: 1,
      close_receipt_support: 1,
      history: [1, true, true],
      k1: 6,
      lr,
    },
    openReceipt: {
      ...longest,
      action: "open",
      exit: 0,
      idle_env_version: 1,
      idle_env: "unparsed",
      os1: 4,
      o1,
    },
    closeReceipt: { ...longest, action: "close", close_all: false },
  });
  d.socket.emit("connect");
  // Without a line the daemon closes first: exit6 carries the same context, no r1.
  if (line === undefined) d.socket.emit("close");
  else d.socket.emit("data", line + "\n");
  expect(d.exit.mock.calls).toEqual([[line === undefined ? 6 : 5]]);
  return d.output.mock.calls[0][0] as string;
};

it("retains the refusal code beside every maximal existing field within the unchanged budgets", () => {
  const text = maximalResponse('{"id":"hackerai-preview","success":"x"}');
  expectPacketBudgets(text);
  const { r1, ...existing } = JSON.parse(text);
  expect(r1).toEqual([1, 4]);
  expect(existing).toEqual(JSON.parse(maximalResponse()));
  expect(existing).toMatchObject({
    wrapper_phase: "started",
    w1: 3,
    k1: 6,
    h1: 3,
    open_exit: 0,
    open_idle: [1, "unparsed"],
    os1: 4,
    p1: [1, 3, 2],
    dv: [1, 1, 999999999],
    cv: [1, 1, 999999999],
  });
  expect(text).not.toMatch(/PRIVATE|314159|271828|default|\/dev\/shm/);
});

it("drops the refusal code first, before the declaration or any existing field, under cap pressure", () => {
  const line = '{"id":"PRIVATE","success":true}';
  const full = Buffer.byteLength(maximalResponse(line));
  const baseline = maximalResponse();
  const refusalBytes = full - Buffer.byteLength(baseline);
  // Existing closed fields cannot reach the cap at exit5 today; charge extra
  // bytes so the complete packet measures one byte over it.
  const justOver = maximalResponse(line, 545 - full);
  expect(JSON.parse(justOver)).toEqual(JSON.parse(baseline));
  // When dropping r1 is not enough, the existing order continues with dv only.
  const { dv, ...rest } = JSON.parse(baseline);
  expect(dv).toEqual([1, 1, 999999999]);
  expect(JSON.parse(maximalResponse(line, 545 - full + refusalBytes))).toEqual(
    rest,
  );
});

it("drops the OPEN informational-token code first, before the refusal code or any existing field", () => {
  const line = '{"id":"PRIVATE","success":true}';
  const complete = maximalResponse(line, undefined, 3);
  expectPacketBudgets(complete);
  expect(JSON.parse(complete)).toMatchObject({ o1: 3, r1: [1, 2], os1: 4 });
  // One byte over the cap drops only o1; r1 and every existing field remain.
  const justOver = maximalResponse(line, 545 - Buffer.byteLength(complete), 3);
  expect(JSON.parse(justOver)).toEqual(JSON.parse(maximalResponse(line)));
});

it.each<[number[]]>([[[1, 0, 0]], [[1, 1, 3]], [[1, 2, 5]], [[1, 3, 0]]])(
  "exports the selected wrapper's result tuple %j unchanged beside a COMPLETED or STARTED receipt",
  (lr) => {
    for (const phase of ["completed", "started"]) {
      const d = daemon({
        receipt: {
          ...receipt,
          action: "other",
          phase,
          exit: phase === "started" ? null : 0,
          lr: [...lr],
        },
      });
      d.socket.emit("connect");
      d.timeout();
      expect(d.exit).toHaveBeenCalledWith(3);
      const text = d.output.mock.calls[0][0];
      expect(JSON.parse(text)).toMatchObject({
        deadline: [1, "awaiting_response"],
        wrapper_phase: phase,
        wrapper_session_matches: true,
        l1: lr,
      });
      expectPacketBudgets(text);
      expect(text).not.toMatch(/PRIVATE|"lr"/);
    }
  },
);

it.each<[string, Record<string, unknown>]>([
  ["a legacy writer", {}],
  ["another session", { session_key: "a".repeat(64), lr: [1, 0, 0] }],
  ["an unknown result", { lr: [1, 4, 0] }],
  ["an unknown elapsed bucket", { lr: [1, 0, 6] }],
  ["a negative code", { lr: [1, 0, -1] }],
  ["another version", { lr: [2, 0, 0] }],
  ["a fractional code", { lr: [1, 0.5, 0] }],
  ["a string code", { lr: [1, "0", 0] }],
  ["a short tuple", { lr: [1, 0] }],
  ["a long tuple", { lr: [1, 0, 0, 0] }],
  ["an array-like object", { lr: { 0: 1, 1: 0, 2: 0, length: 3 } }],
  ["a string", { lr: "PRIVATE" }],
])(
  "keeps the wrapper result unmeasured for %s without changing the failure",
  (_case, override) => {
    const d = daemon({
      ...missingSocket,
      receipt: { ...receipt, ...override },
    });
    expect(d.exit).toHaveBeenCalledWith(2);
    expect(d.connect).not.toHaveBeenCalled();
    const value = JSON.parse(d.output.mock.calls[0][0]);
    expect(value).toMatchObject({
      diagnostic_reason: "socket_stat",
      wrapper_receipt_version: 1,
    });
    expect(value).not.toHaveProperty("l1");
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
  },
);

it("neither reads receipts nor adds the wrapper result to a successful response", () => {
  const d = daemon({ receipt: { ...receipt, lr: [1, 1, 3] } });
  const response = { id: "hackerai-preview", success: true, data: {} };
  d.reply(response);
  expect(d.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  expect(d.readReceipt).not.toHaveBeenCalled();
});

it("drops the wrapper result first, before the declaration, refusal code or any existing field", () => {
  const line = '{"id":"PRIVATE","success":true}';
  const resultBytes = Buffer.byteLength(',"l1":[1,3,5]');
  const withResult = maximalResponse(line, undefined, undefined, [1, 3, 5]);
  expectPacketBudgets(withResult);
  expect(JSON.parse(withResult)).toEqual({
    ...JSON.parse(maximalResponse(line)),
    l1: [1, 3, 5],
  });
  // One byte over the cap drops only l1; o1, r1 and every existing field remain.
  const declared = maximalResponse(line, undefined, 3);
  const justOver = maximalResponse(
    line,
    545 - Buffer.byteLength(declared) - resultBytes,
    3,
    [1, 3, 5],
  );
  expect(JSON.parse(justOver)).toEqual(JSON.parse(declared));
  expect(JSON.parse(declared)).toMatchObject({ o1: 3, r1: [1, 2] });
});

it("drops the screenshot refusal class first, before the wrapper result or any existing field", () => {
  const line =
    '{"id":"hackerai-preview","success":false,"error":"Failed to save screenshot to /PRIVATE.jpg: PRIVATE"}';
  const complete = maximalResponse(
    line,
    undefined,
    undefined,
    [1, 3, 5],
    screenshotRequest,
  );
  expectPacketBudgets(complete);
  const { s1, ...existing } = JSON.parse(complete);
  expect(s1).toEqual([1, 3]);
  expect(existing).toMatchObject({ r1: [1, 3], l1: [1, 3, 5] });
  // One byte over the cap drops only s1; l1, r1 and every existing field remain.
  const justOver = maximalResponse(
    line,
    545 - Buffer.byteLength(complete),
    undefined,
    [1, 3, 5],
    screenshotRequest,
  );
  expect(JSON.parse(justOver)).toEqual(existing);
  // With the OPEN declaration too, the full context already exceeds the cap.
  const declared = JSON.parse(
    maximalResponse(line, undefined, 3, [1, 3, 5], screenshotRequest),
  );
  expect(declared).not.toHaveProperty("s1");
  expect(declared).toMatchObject({ r1: [1, 3], o1: 3, l1: [1, 3, 5] });
  expect(complete).not.toMatch(/PRIVATE|Failed|error/);
});

/** A selected-path /proc/net/unix row: flags, type, state, then a %5lu inode. */
const queueRow = (
  state: string,
  inode: number,
  { flags = "00000000", type = "0001", address = selectedSocket } = {},
) =>
  `0000000000000000: 00000002 00000000 ${flags} ${type} ${state} ${String(inode).padStart(5)} ${address}`;
// Calibrated on Linux: an unaccepted connection has state 02 and no inode; an
// accepted one has state 03 and the daemon's descriptor, even after its client closed.
const pendingRow = queueRow("02", 0);
const heldRow = (inode: number) => queueRow("03", inode);
/** The selected listener 4242 among other sockets, including an exact-path-only neighbour. */
const queueTable = (...rows: string[]) =>
  unixTable(
    unixRow(4100),
    unixRow(4242, selectedSocket),
    queueRow("02", 0, { address: selectedSocket + ".old" }),
    unixRow(4300, directory + "/sockets/other session.sock"),
    ...rows,
  );
/** The daemon's descriptors: its selected listener 4242 plus these accepted inodes. */
const queueFds = (...inodes: number[]) =>
  Object.fromEntries(
    [4242, ...inodes].map((inode, index) => [
      String(index + 3),
      `socket:[${inode}]`,
    ]),
  );
/** After the selected session's successful OPEN; one pending and one held by default. */
const queueDaemon = (options: DaemonOptions = {}, owned: OwnedState = {}) =>
  daemon({
    pidFile: "314159",
    processVisibility: "same_uid",
    receipt: { ...receipt, action: "other", open_receipt_support: 1 },
    openReceipt: successfulOpen,
    ...options,
    owned: {
      unix: queueTable(pendingRow, heldRow(4243)),
      fds: queueFds(4243),
      ...owned,
    },
  });
/** Connect, then reach the unchanged original deadline once with no follow-up request. */
const atDeadline = (d: ReturnType<typeof daemon>) => {
  d.socket.emit("connect");
  d.timeout();
  expect(d.exit.mock.calls).toEqual([[3]]);
  expect(d.connect).toHaveBeenCalledTimes(1);
  expect(d.socket.write).toHaveBeenCalledTimes(1);
  return d.output.mock.calls[0][0] as string;
};
const status = { action: "stream_status" };
const twoPending = [pendingRow, pendingRow];
const waitRows = [heldRow(4243), heldRow(4244)];
const fifteen = Array.from({ length: 15 }, (_, index) => 5000 + index);
const saturated = [...Array(16).fill(pendingRow), ...fifteen.map(heldRow)];

it.each<[string, Record<string, unknown>, string[], number[], number[]]>([
  // The two calibrated regimes: a stopped daemon and a serialized WAIT.
  ["a stopped daemon's status", status, twoPending, [], [1, 2, 0]],
  [
    "a stopped daemon's screenshot",
    screenshotRequest,
    twoPending,
    [],
    [1, 2, 0],
  ],
  ["a serialized WAIT", status, waitRows, [4243, 4244], [1, 0, 2]],
  [
    "16 pending and 15 held, saturated",
    status,
    saturated,
    fifteen,
    [1, 15, 15],
  ],
])(
  "reports visible connections for %s beside the selected daemon's own listener",
  (_case, request, rows, held, expected) => {
    const owned = { unix: queueTable(...rows), fds: queueFds(...held) };
    const d = queueDaemon({ request }, owned);
    const text = atDeadline(d);
    const { q1, ...existing } = JSON.parse(text);
    expect(q1).toEqual(expected);
    // Every other field is the same deadline packet without a sample.
    expect(existing).toEqual(
      JSON.parse(atDeadline(queueDaemon({ request }, { unix: undefined }))),
    );
    expect(existing.deadline).toEqual([1, "awaiting_response"]);
    expect(text).not.toMatch(
      /PRIVATE|314159|424[0-9]|50[0-9]{2}|\/proc|\/dev\/shm|default|socket:/,
    );
    // Sampled before the helper closes its connection, from one fixed table
    // and the recorded PID's descriptors; never a process scan.
    expect(d.readLink.mock.invocationCallOrder.at(-1)).toBeLessThan(
      d.socket.destroy.mock.invocationCallOrder[0],
    );
    expect(
      d.openReceipt.mock.calls.filter(([file]) => file.startsWith("/proc/")),
    ).toEqual([["/proc/net/unix", 256 | 2048]]);
    expect(d.openDescriptors.mock.calls).toEqual([["/proc/314159/fd"]]);
  },
);

const viewport = { action: "viewport", width: 390, height: 844 };
const success = '{"id":"hackerai-preview","success":true}';
it.each<[string, Record<string, unknown>, string[], number]>([
  ["a viewport request", viewport, ["connect"], 3],
  ["the connecting deadline", status, [], 3],
  ["a partial-response deadline", status, ["connect", '{"PRIVATE":'], 3],
  ["a daemon close", status, ["connect", "close"], 6],
  ["a refused response", status, ["connect", "null\n"], 5],
  ["a success", status, ["connect", success + "\n"], 0],
])(
  "neither samples nor reports the queue for %s",
  (_case, request, events, code) => {
    const d = queueDaemon({ request });
    for (const event of events)
      if (event === "connect" || event === "close") d.socket.emit(event);
      else d.socket.emit("data", event);
    // A later deadline callback cannot replace an earlier outcome.
    d.timeout();
    expect(d.exit.mock.calls).toEqual([[code]]);
    const text = d.output.mock.calls[0][0];
    expect(text).not.toMatch(/q1|PRIVATE/);
    if (code === 0) expect(text).toBe(success);
    expect(d.openDescriptors).not.toHaveBeenCalled();
    expect(d.openReceipt.mock.calls.flat()).not.toContain("/proc/net/unix");
  },
);

/** Each read advances 150 ms, so the 200 ms budget lapses during the walk. */
const slowClock = () => {
  let now = 0;
  return () => BigInt((now += 150) * 1_000_000);
};
/** A table holding the selected listener plus one other selected-path row. */
const withRow = (row: string, inode?: number): OwnedState => ({
  unix: queueTable(row),
  fds: inode ? queueFds(inode) : queueFds(),
});
const datagram = queueRow("03", 4248, { type: "0002" });
const pastCap = descriptors(256, "socket:[4242]", "socket:[4243]");

it.each<[string, DaemonOptions, OwnedState]>([
  ["the PID sidecar is missing", { pidFile: undefined }, {}],
  ["another user runs the PID", { processVisibility: "other_uid" }, {}],
  ["/proc is not procfs", { procfsType: 0x01021994 }, {}],
  ["the OPEN failed", { openReceipt: { ...successfulOpen, exit: 1 } }, {}],
  ["another process holds the listener", {}, { fds: { "7": "socket:[4243]" } }],
  ["another process holds a connection", {}, { fds: queueFds() }],
  ["no listener has the path", {}, { unix: unixTable(pendingRow) }],
  ["two listeners", {}, withRow(unixRow(4245, selectedSocket), 4245)],
  ["a bound non-listener", {}, withRow(queueRow("01", 4246), 4246)],
  ["a disconnecting connection", {}, withRow(queueRow("04", 0))],
  ["an unaccepted row has an inode", {}, withRow(queueRow("02", 4247), 4247)],
  ["a datagram socket", {}, withRow(datagram, 4248)],
  ["the Unix table exceeds its bound", {}, { unix: queueTable(...unixFiller) }],
  ["the listener lies past the descriptor cap", {}, { fds: pastCap }],
  ["the socket is replaced mid-walk", {}, { walkDrift: "socket" }],
  ["the PID sidecar changes mid-walk", {}, { walkDrift: "pid" }],
  ["the sample outlasts its time budget", { clock: slowClock() }, {}],
])(
  "omits the queue and keeps the unchanged deadline failure when %s",
  (_case, options, owned) => {
    const text = atDeadline(queueDaemon(options, owned));
    expect(JSON.parse(text).deadline).toEqual([1, "awaiting_response"]);
    expect(text).not.toMatch(/"q1"|PRIVATE|31415|31416|424[0-9]|socket:/);
  },
);

/** Near-cap deadline context with or without a sample; a recorded close makes it maximal. */
const nearCap = (queue: boolean, close = false, chargedBytes?: number) => {
  const longest = { ...receipt, at: Date.now() + 60_000, exit: 999 };
  return atDeadline(
    queueDaemon(
      {
        chargedBytes,
        cliReceipt: [1, 1, 999999999],
        wrapperStat: procStat(),
        versionFile: "999.999.999",
        receipt: {
          ...longest,
          action: "other",
          phase: "started",
          exit: null,
          process: startedWrapper.process,
          open_receipt_support: 1,
          close_receipt_support: close ? 1 : undefined,
          history: [1, true, true],
          k1: 6,
        },
        openReceipt: {
          ...longest,
          action: "open",
          exit: 0,
          idle_env_version: 1,
          idle_env: "unparsed",
          os1: 4,
        },
        closeReceipt: { ...longest, action: "close", close_all: false },
      },
      queue ? {} : { unix: undefined },
    ),
  );
};

it("drops the queue tuple first and never displaces an existing field at the unchanged cap", () => {
  const complete = nearCap(true);
  expectPacketBudgets(complete);
  const { q1, ...existing } = JSON.parse(complete);
  expect(q1).toEqual([1, 1, 1]);
  expect(existing).toEqual(JSON.parse(nearCap(false)));
  // One byte over the cap drops only q1.
  const over = nearCap(true, false, 545 - Buffer.byteLength(complete));
  expect(JSON.parse(over)).toEqual(existing);
  // A maximal packet has no room: identical to the same packet without a sample.
  const maximal = nearCap(true, true);
  expectPacketBudgets(maximal);
  expect(JSON.parse(maximal)).toEqual(JSON.parse(nearCap(false, true)));
  expect(complete + maximal).not.toMatch(/PRIVATE|314159|271828|424[0-9]/);
});

// One plain OPEN invocation still running: the wrapper writes both STARTED records
// from the same value, so they share a timestamp; only the latest carries identity.
const opening = {
  ...receipt,
  action: "open",
  phase: "started",
  exit: null,
  open_receipt_support: 1,
};
const openingWrapper = { ...opening, process: startedWrapper.process, k1: 3 };
const openingRecord = { ...opening, o1: 0 };
const openingDaemon = (options: DaemonOptions = {}, owned: OwnedState = {}) =>
  queueDaemon(
    {
      receipt: openingWrapper,
      openReceipt: openingRecord,
      wrapperStat: procStat(),
      ...options,
    },
    owned,
  );

it.each([status, screenshotRequest])(
  "reports the queue beside the selected plain OPEN still running at the deadline (%j)",
  (request) => {
    const d = openingDaemon({ request });
    const text = atDeadline(d);
    const { q1, ...existing } = JSON.parse(text);
    expect(q1).toEqual([1, 1, 1]);
    // The same deadline packet without a sample; no completed-OPEN context is added.
    expect(existing).toEqual(
      JSON.parse(atDeadline(openingDaemon({ request }, { unix: undefined }))),
    );
    expect(existing).toMatchObject({
      wrapper_action: "open",
      wrapper_phase: "started",
      open_phase: "started",
      w1: 3,
    });
    for (const field of ["p1", "os1", "o1", "sd1", "dv"])
      expect(existing).not.toHaveProperty(field);
    expect(text).not.toMatch(
      /PRIVATE|314159|271828|123456|424[0-9]|\/proc|\/dev\/shm|default|socket:/,
    );
    // Both receipts are reread exactly once and the exact incarnation checked again
    // after the sample, before the close.
    const walkEnd = d.readLink.mock.invocationCallOrder.at(-1)!;
    const close = d.socket.destroy.mock.invocationCallOrder[0];
    for (const file of [
      "/proc/271828/stat",
      directory + "/wrapper-receipt.json",
      directory + "/open-receipt.json",
    ]) {
      const opens = d.openReceipt.mock.invocationCallOrder.filter(
        (_order, index) => d.openReceipt.mock.calls[index][0] === file,
      );
      expect(opens).toHaveLength(2);
      expect(opens[0]).toBeLessThan(walkEnd);
      expect(opens[1]).toBeGreaterThan(walkEnd);
      expect(opens[1]).toBeLessThan(close);
    }
  },
);

it.each<[string, DaemonOptions, OwnedState]>([
  ["the OPEN declared help", { openReceipt: { ...openingRecord, o1: 1 } }, {}],
  [
    "the OPEN declared version",
    { openReceipt: { ...openingRecord, o1: 2 } },
    {},
  ],
  ["the OPEN's plain declaration is unrecorded", { openReceipt: opening }, {}],
  [
    "the sticky OPEN is an earlier STARTED record",
    { openReceipt: { ...openingRecord, at: opening.at - 1 } },
    {},
  ],
  [
    "the sticky OPEN is another session's",
    { openReceipt: { ...openingRecord, session_key: "f".repeat(64) } },
    {},
  ],
  [
    "the latest wrapper is another session's",
    { receipt: { ...openingWrapper, session_key: "f".repeat(64) } },
    {},
  ],
  [
    "the latest wrapper is another command",
    { receipt: { ...openingWrapper, action: "other", k1: 0 } },
    {},
  ],
  [
    "the latest wrapper has no recorded identity",
    { receipt: { ...openingWrapper, process: undefined } },
    {},
  ],
  [
    "the sticky OPEN is unsupported",
    { receipt: { ...openingWrapper, open_receipt_support: undefined } },
    {},
  ],
  ["the wrapper is gone", { wrapperStatError: "ENOENT" }, {}],
  [
    "the wrapper PID was reused",
    { wrapperStat: procStat({ ticks: "123457" }) },
    {},
  ],
  ["the wrapper is a zombie", { wrapperStat: procStat({ state: "Z" }) }, {}],
  ["the wrapper exits during the sample", {}, { walkDrift: "wrapper" }],
  ["another process holds a connection", {}, { fds: queueFds() }],
])(
  "omits the queue beside a still-running OPEN when %s",
  (_case, options, owned) => {
    const d = openingDaemon(options, owned);
    const text = atDeadline(d);
    expect(JSON.parse(text).deadline).toEqual([1, "awaiting_response"]);
    expect(text).not.toMatch(/"q1"|PRIVATE|31415|271828|424[0-9]|socket:/);
    // Only a fully scoped OPEN is sampled at all.
    if (!("walkDrift" in owned) && !("fds" in owned))
      expect(d.openDescriptors).not.toHaveBeenCalled();
  },
);

// The wrapper records completion before its process exits, so its exact
// incarnation stays live (the default procStat) while the receipts change.
const completedOpening = {
  ...opening,
  phase: "completed",
  exit: 0,
  at: opening.at + 1,
  lr: [1, 0, 1],
};
it.each<[string, NonNullable<OwnedState["afterWalk"]>]>([
  [
    "the OPEN completes during the sample",
    {
      receipt: { ...completedOpening, k1: 3 },
      openReceipt: { ...completedOpening, o1: 0, os1: 1 },
    },
  ],
  [
    "only the latest wrapper completes",
    { receipt: { ...completedOpening, k1: 3 } },
  ],
  [
    "only the sticky OPEN completes",
    { openReceipt: { ...completedOpening, o1: 0, os1: 1 } },
  ],
  [
    "a later OPEN replaces both records",
    {
      receipt: { ...openingWrapper, at: opening.at + 1 },
      openReceipt: { ...openingRecord, at: opening.at + 1 },
    },
  ],
  [
    "another incarnation replaces the wrapper at the same timestamp",
    { receipt: { ...openingWrapper, process: [1, 271828, "123457"] } },
  ],
  [
    "the wrapper identity is dropped",
    { receipt: { ...openingWrapper, process: undefined } },
  ],
  [
    "another command replaces the wrapper",
    { receipt: { ...openingWrapper, action: "other", k1: 6 } },
  ],
  [
    "the sticky OPEN loses its plain flag",
    { openReceipt: { ...openingRecord, o1: undefined } },
  ],
  ["the wrapper receipt becomes unreadable", { receipt: undefined }],
  ["the sticky OPEN becomes unreadable", { openReceipt: undefined }],
  ["the wrapper receipt becomes invalid", { receipt: "PRIVATE" }],
])(
  "omits only the queue and keeps the original deadline context when %s",
  (_case, afterWalk) => {
    const d = openingDaemon({}, { afterWalk });
    const text = atDeadline(d);
    expect(JSON.parse(text)).toEqual(
      JSON.parse(atDeadline(openingDaemon({}, { unix: undefined }))),
    );
    expect(JSON.parse(text)).toMatchObject({
      deadline: [1, "awaiting_response"],
      wrapper_phase: "started",
      open_phase: "started",
      w1: 3,
    });
    expect(text).not.toMatch(/"q1"|PRIVATE|31415|271828|424[0-9]|socket:/);
    // The sample ran; only the reread refused it.
    expect(d.openDescriptors).toHaveBeenCalledTimes(1);
  },
);

it("never samples beside a still-running OPEN outside the connected deadline", () => {
  const d = openingDaemon();
  d.socket.emit("connect");
  d.socket.emit("close");
  d.timeout();
  expect(d.exit.mock.calls).toEqual([[6]]);
  expect(d.output.mock.calls[0][0]).not.toMatch(/q1|PRIVATE/);
  expect(d.openDescriptors).not.toHaveBeenCalled();
  expect(d.openReceipt.mock.calls.flat()).not.toContain("/proc/net/unix");
});

it("drops the running-OPEN queue first, keeping the wrapper fields that scope it", () => {
  const complete = atDeadline(openingDaemon());
  const { q1, ...existing } = JSON.parse(complete);
  expect(q1).toEqual([1, 1, 1]);
  const over = atDeadline(
    openingDaemon({ chargedBytes: 545 - Buffer.byteLength(complete) }),
  );
  expect(JSON.parse(over)).toEqual(existing);
  expect(existing).toMatchObject({ w1: 3, wrapper_action: "open" });
});

// The fresh GET's screenshot: the only request whose write attempt is timed.
const freshScreenshot = { ...screenshotRequest, recognize_closed: true };
const screenshotWire = [
  [JSON.stringify({ ...screenshotRequest, id: "hackerai-preview" }) + "\n"],
];
/** The running-OPEN deadline with the write attempt this many ms after OPEN started. */
const writeOrderDeadline = (
  writeAfterOpen: number,
  request: Record<string, unknown> = freshScreenshot,
  options: DaemonOptions = {},
  owned: OwnedState = {},
) => {
  const d = openingDaemon(
    { request, now: () => opening.at + writeAfterOpen, ...options },
    owned,
  );
  return { d, text: atDeadline(d) };
};

it.each<[string, number, number]>([
  ["before", 1, 1],
  ["after", -1, 2],
])(
  "reports only whether the still-running OPEN started %s the screenshot's write attempt",
  (_case, writeAfterOpen, code) => {
    const { d, text } = writeOrderDeadline(writeAfterOpen);
    const { ot1, ...existing } = JSON.parse(text);
    expect(ot1).toBe(code);
    // The same strict exit3 packet, queue included, as an unopted screenshot.
    expect(existing).toEqual(
      JSON.parse(writeOrderDeadline(writeAfterOpen, screenshotRequest).text),
    );
    expect(existing).toMatchObject({
      deadline: [1, "awaiting_response"],
      q1: [1, 1, 1],
      open_phase: "started",
    });
    // One unchanged request without the opt-in, then the helper's own close.
    expect(d.socket.write.mock.calls).toEqual(screenshotWire);
    expect(d.socket.destroy).toHaveBeenCalledTimes(1);
    expectPacketBudgets(text);
    for (const at of [opening.at, opening.at + writeAfterOpen])
      expect(text).not.toContain(String(at));
    expect(text).not.toMatch(/PRIVATE|271828|314159/);
  },
);

it.each<[string, number, Record<string, unknown>, DaemonOptions, OwnedState]>([
  ["the times tie", 0, freshScreenshot, {}, {}],
  ["the screenshot did not opt in", 1, screenshotRequest, {}, {}],
  ["the request is a status", 1, { ...status, recognize_closed: true }, {}, {}],
  [
    "the OPEN completed successfully",
    1,
    freshScreenshot,
    {
      receipt: { ...completedOpening, k1: 3 },
      openReceipt: { ...completedOpening, o1: 0, os1: 1 },
    },
    {},
  ],
  [
    "the OPEN completes during the sample",
    1,
    freshScreenshot,
    {},
    { afterWalk: { receipt: { ...completedOpening, k1: 3 } } },
  ],
])(
  "omits the write order when %s",
  (_case, writeAfterOpen, request, options, owned) => {
    const { text } = writeOrderDeadline(
      writeAfterOpen,
      request,
      options,
      owned,
    );
    expect(JSON.parse(text).deadline).toEqual([1, "awaiting_response"]);
    expect(text).not.toContain('"ot1"');
  },
);

it("drops the write order first, keeping the running-OPEN queue at the cap", () => {
  const { text: complete } = writeOrderDeadline(1);
  const { ot1, ...existing } = JSON.parse(complete);
  expect(ot1).toBe(1);
  const { text: over } = writeOrderDeadline(1, freshScreenshot, {
    chargedBytes: 545 - Buffer.byteLength(complete),
  });
  expect(JSON.parse(over)).toEqual(existing);
  expect(existing.q1).toEqual([1, 1, 1]);
});

// The reproduced production regime: a fresh status queued behind a second plain
// OPEN, with the daemon holding another accepted connection besides this helper's.
const openStatus = { action: "stream_status", defer_open: true };
const heldBeyondHelper: OwnedState = {
  unix: queueTable(heldRow(4243), heldRow(4244)),
  fds: queueFds(4243, 4244),
};
/** Reach the unchanged connected deadline once; exit, wire and stdout. */
const openDeadline = (
  request: Record<string, unknown>,
  options: DaemonOptions = {},
  owned: OwnedState = {},
) => {
  const d = openingDaemon(
    { ...options, request },
    { ...heldBeyondHelper, ...owned },
  );
  d.socket.emit("connect");
  d.timeout();
  return {
    d,
    exit: d.exit.mock.calls,
    wire: d.socket.write.mock.calls,
    output: d.output.mock.calls.map(([text]) => text),
  };
};
const plainStatusWire = [
  [JSON.stringify({ action: "stream_status", id: "hackerai-preview" }) + "\n"],
];
/** The opted status's one pre-connect walk only, before its one connection. */
function expectOnlyPreconnectWalk(d: ReturnType<typeof daemon>) {
  expect(d.openDescriptors).toHaveBeenCalledTimes(1);
  expect(d.openDescriptors.mock.invocationCallOrder[0]).toBeLessThan(
    d.connect.mock.invocationCallOrder[0],
  );
}

it.each<Record<string, unknown>>([
  openStatus,
  { ...openStatus, defer_wait: true, recognize_closed: true },
])(
  "reports only the helper OPEN literal at the unchanged deadline behind a still-running plain OPEN: %j",
  (request) => {
    const { d, exit, wire, output } = openDeadline(request);
    expect(exit).toEqual([[0]]);
    expect(output).toEqual([BROWSER_DAEMON_OPEN_DEFERRED]);
    // One unchanged strict request without the internal flags, no retry.
    expect(d.connect).toHaveBeenCalledTimes(1);
    expect(wire).toEqual(plainStatusWire);
    // The existing deadline sample and receipt reread decide it before the close;
    // the one other walk is the pre-connect sample, which cannot change it.
    expect(d.openDescriptors).toHaveBeenCalledTimes(2);
    expect(d.openDescriptors.mock.invocationCallOrder[0]).toBeLessThan(
      d.connect.mock.invocationCallOrder[0],
    );
    expect(d.readLink.mock.invocationCallOrder.at(-1)).toBeLessThan(
      d.socket.destroy.mock.invocationCallOrder[0],
    );
    // Without the opt-in, the same observation keeps its strict exit3 packet.
    const strict = openDeadline({ action: "stream_status" });
    expect(strict.exit).toEqual([[3]]);
    expect(JSON.parse(strict.output[0])).toMatchObject({
      deadline: [1, "awaiting_response"],
      q1: [1, 0, 2],
    });
  },
);

const completedPlainOpen = {
  ...opening,
  phase: "completed",
  exit: 0,
  lr: [1, 0, 1],
};
it.each<[string, Record<string, unknown>, DaemonOptions, OwnedState]>([
  // One held beside a pending connection keeps exit3 unless the pre-connect
  // comparison below proves it was already held.
  [
    "only this helper's own connection is held",
    openStatus,
    {},
    { unix: queueTable(heldRow(4243)), fds: queueFds(4243) },
  ],
  [
    "no connection is accepted",
    openStatus,
    {},
    { unix: queueTable(pendingRow, pendingRow), fds: queueFds() },
  ],
  [
    "another process holds a connection",
    openStatus,
    {},
    { fds: queueFds(4243) },
  ],
  [
    "the OPEN completed successfully",
    openStatus,
    {
      receipt: { ...completedPlainOpen, k1: 3 },
      openReceipt: { ...completedPlainOpen, o1: 0, os1: 1 },
    },
    {},
  ],
  [
    "the OPEN failed",
    openStatus,
    {
      receipt: { ...completedPlainOpen, exit: 1, lr: [1, 1, 1], k1: 3 },
      openReceipt: { ...completedPlainOpen, exit: 1, o1: 0 },
    },
    {},
  ],
  [
    "a newer different wrapper is latest",
    openStatus,
    { receipt: { ...openingWrapper, action: "other", k1: 6 } },
    {},
  ],
  [
    "the OPEN belongs to another session",
    openStatus,
    {
      receipt: { ...openingWrapper, session_key: "f".repeat(64) },
      openReceipt: { ...openingRecord, session_key: "f".repeat(64) },
    },
    {},
  ],
  [
    "the OPEN declared help",
    openStatus,
    { openReceipt: { ...openingRecord, o1: 1 } },
    {},
  ],
  ["the OPEN wrapper is gone", openStatus, { wrapperStatError: "ENOENT" }, {}],
  [
    "the OPEN completes during the sample",
    openStatus,
    {},
    {
      afterWalk: {
        receipt: { ...completedPlainOpen, at: opening.at + 1, k1: 3 },
        openReceipt: { ...completedPlainOpen, at: opening.at + 1, o1: 0 },
      },
    },
  ],
  ["the opt-in is a string", { ...openStatus, defer_open: "true" }, {}, {}],
  [
    "the status uses the owned-port shortcut",
    { ...openStatus, owned_port: true },
    {},
    {},
  ],
  [
    "the request is a fresh screenshot",
    { ...screenshotRequest, defer_open: true },
    {},
    {},
  ],
])(
  "keeps the original strict deadline packet when %s",
  (_case, request, options, owned) => {
    const opted = openDeadline(request, options, owned);
    const {
      defer_open: _open,
      owned_port: _port,
      ...unopted
    } = request as Record<string, unknown>;
    const strict = openDeadline(
      request.owned_port === true ? { ...unopted, owned_port: true } : unopted,
      options,
      owned,
    );
    expect(opted.exit).toEqual([[3]]);
    expect(opted.output).toEqual(strict.output);
    expect(opted.wire).toEqual(strict.wire);
    expect(opted.output.join("")).not.toContain("open_deferred");
    expect(JSON.parse(opted.output[0]).deadline).toEqual([
      1,
      "awaiting_response",
    ]);
  },
);

it.each<[string, string[], string]>([
  ["the connecting deadline", [], "connecting"],
  [
    "a partial-response deadline",
    ["connect", '{"PRIVATE":'],
    "partial_response",
  ],
])(
  "keeps exit3 for %s even behind a still-running OPEN",
  (_case, events, phase) => {
    const d = openingDaemon({ request: openStatus }, heldBeyondHelper);
    for (const event of events)
      if (event === "connect") d.socket.emit(event);
      else d.socket.emit("data", event);
    d.timeout();
    expect(d.exit.mock.calls).toEqual([[3]]);
    const text = d.output.mock.calls[0][0];
    expect(JSON.parse(text).deadline).toEqual([1, phase]);
    expect(text).not.toMatch(/open_deferred|q1|ph1|PRIVATE/);
    // Only the pre-connect sample; no deadline sample.
    expectOnlyPreconnectWalk(d);
  },
);

it("relays a daemon reply that answers before the deadline unchanged", () => {
  const d = openingDaemon({ request: openStatus }, heldBeyondHelper);
  d.socket.emit("connect");
  const response = {
    id: "hackerai-preview",
    success: true,
    data: { connected: true, port: 9223 },
    open_deferred: 1,
  };
  d.reply(response);
  d.timeout();
  expect(d.exit.mock.calls).toEqual([[0]]);
  const text = d.output.mock.calls[0][0];
  expect(text).not.toBe(BROWSER_DAEMON_OPEN_DEFERRED);
  expect(JSON.parse(text)).toEqual(response);
  expectOnlyPreconnectWalk(d);
});

// The narrow production regime: one held beside a pending connection at the
// deadline. Those counts cannot tell whether the daemon still holds a connection
// accepted before this helper connected; only the pre-connect sample compares it.
const oneHeldOnePending: OwnedState = {
  unix: queueTable(pendingRow, heldRow(4243)),
  fds: queueFds(4243),
};
const preconnectDeadline = (
  request: Record<string, unknown> = openStatus,
  options: DaemonOptions = {},
  owned: OwnedState = {},
) => openDeadline(request, options, { ...oneHeldOnePending, ...owned });

/** The one pre-connect walk and the one deadline walk of the same recorded daemon PID,
 * on one unchanged request at the unchanged 6 s deadline armed before both. */
function expectPreconnectAndDeadlineWalks(
  d: ReturnType<typeof daemon>,
  wire: unknown[],
) {
  expect(d.connect).toHaveBeenCalledTimes(1);
  expect(wire).toEqual(plainStatusWire);
  expect(d.arm.mock.calls).toEqual([[expect.any(Function), 6000]]);
  expect(d.openDescriptors.mock.calls).toEqual([
    ["/proc/314159/fd"],
    ["/proc/314159/fd"],
  ]);
  const [before, after] = d.openDescriptors.mock.invocationCallOrder;
  expect(d.arm.mock.invocationCallOrder[0]).toBeLessThan(before);
  expect(before).toBeLessThan(d.connect.mock.invocationCallOrder[0]);
  expect(after).toBeLessThan(d.socket.destroy.mock.invocationCallOrder[0]);
}

// The first natural production positive: q1 [1, 1, 1] with the sole held connection
// already accepted before the helper connected, so it is not the helper's own.
it("reports only the helper OPEN literal when the sole held connection was already held before the helper connected", () => {
  const { d, exit, wire, output } = preconnectDeadline();
  expect(exit).toEqual([[0]]);
  expect(output).toEqual([BROWSER_DAEMON_OPEN_DEFERRED]);
  expectPreconnectAndDeadlineWalks(d, wire);
  // Without the opt-in, the same observation keeps its strict exit3 packet.
  const strict = preconnectDeadline(status);
  expect(strict.exit).toEqual([[3]]);
  expect(strict.wire).toEqual(plainStatusWire);
  expect(JSON.parse(strict.output[0])).toMatchObject({
    deadline: [1, "awaiting_response"],
    q1: [1, 1, 1],
    open_phase: "started",
  });
  expect(strict.output[0]).not.toMatch(/open_deferred|"ph1"/);
});

it.each<[string, OwnedState]>([
  [
    "not held before the helper connected",
    { beforeConnect: { unix: queueTable(pendingRow), fds: queueFds() } },
  ],
  [
    "not the connection held before the helper connected",
    { beforeConnect: { unix: queueTable(heldRow(4250)), fds: queueFds(4250) } },
  ],
])(
  "keeps exit3 with only the pre-connect code when the sole held connection was %s",
  (_case, owned) => {
    const { d, exit, wire, output } = preconnectDeadline(openStatus, {}, owned);
    expect(exit).toEqual([[3]]);
    expect(output[0]).not.toContain("open_deferred");
    const { ph1, ...existing } = JSON.parse(output[0]);
    expect(ph1).toBe(2);
    // The identical strict packet: the same counts either way cannot classify it.
    const strict = preconnectDeadline(status, {}, owned);
    expect(strict.exit).toEqual([[3]]);
    expect(existing).toEqual(JSON.parse(strict.output[0]));
    expect(existing).toMatchObject({
      deadline: [1, "awaiting_response"],
      q1: [1, 1, 1],
      open_phase: "started",
      w1: 3,
    });
    expectPacketBudgets(output[0]);
    expect(output[0]).not.toMatch(
      /PRIVATE|314159|271828|123456|424[0-9]|4250|\/proc|\/dev\/shm|default|socket:/,
    );
    expectPreconnectAndDeadlineWalks(d, wire);
    // The fixed Unix table once per sample; never the TCP table or a process scan.
    expect(
      d.openReceipt.mock.calls.filter(([file]) =>
        file.startsWith("/proc/net/"),
      ),
    ).toEqual([
      ["/proc/net/unix", 256 | 2048],
      ["/proc/net/unix", 256 | 2048],
    ]);
  },
);

/** Each read advances 15 ms: past the 20 ms pre-connect budget, within the deadline's 200 ms. */
const stepClock = () => {
  let now = 0;
  return () => BigInt((now += 15) * 1_000_000);
};
it.each<[string, () => DaemonOptions, OwnedState, number[] | undefined]>([
  [
    "the pre-connect table is unreadable",
    () => ({}),
    { beforeConnect: { unix: undefined } },
    [1, 1, 1],
  ],
  [
    "the pre-connect sample outlasts its budget",
    () => ({ clock: stepClock() }),
    {},
    [1, 1, 1],
  ],
  [
    "another process held a pre-connect connection",
    () => ({}),
    { beforeConnect: { fds: queueFds() } },
    [1, 1, 1],
  ],
  [
    "the daemon PID changed between the samples",
    () => ({}),
    { beforeConnect: { pidFile: "314158" } },
    [1, 1, 1],
  ],
  [
    "the listener changed between the samples",
    () => ({}),
    {
      beforeConnect: {
        unix: unixTable(
          unixRow(4241, selectedSocket),
          pendingRow,
          heldRow(4243),
        ),
        fds: { "3": "socket:[4241]", "4": "socket:[4243]" },
      },
    },
    [1, 1, 1],
  ],
  [
    "a later OPEN replaced both records between the samples",
    () => ({}),
    {
      beforeConnect: {
        receipt: { ...openingWrapper, at: opening.at - 1 },
        openReceipt: { ...openingRecord, at: opening.at - 1 },
      },
    },
    [1, 1, 1],
  ],
  [
    "the OPEN completes during the pre-connect sample",
    () => ({}),
    {
      beforeConnect: {
        afterWalk: { receipt: { ...completedPlainOpen, k1: 3 } },
      },
    },
    [1, 1, 1],
  ],
  [
    "no OPEN was running before the helper connected",
    () => ({}),
    {
      beforeConnect: {
        receipt: { ...receipt, action: "other", open_receipt_support: 1 },
        openReceipt: successfulOpen,
      },
    },
    [1, 1, 1],
  ],
  [
    "the selected socket is replaced after connecting",
    () => ({}),
    { walkDrift: "socket" },
    undefined,
  ],
  [
    "the sole held connection has none pending beside it",
    () => ({}),
    { unix: queueTable(heldRow(4243)) },
    [1, 0, 1],
  ],
])(
  "keeps the strict exit3 packet without the pre-connect code when %s",
  (_case, options, owned, queue) => {
    const opted = preconnectDeadline(openStatus, options(), owned);
    const strict = preconnectDeadline(status, options(), owned);
    expect(opted.exit).toEqual([[3]]);
    expect(opted.output).toEqual(strict.output);
    expect(opted.wire).toEqual(strict.wire);
    expect(opted.output[0]).not.toMatch(/"ph1"|PRIVATE|31415|424[0-9]/);
    const packet = JSON.parse(opted.output[0]);
    expect(packet.deadline).toEqual([1, "awaiting_response"]);
    // The deadline sample still reports wherever only the earlier proof failed.
    expect(packet.q1).toEqual(queue);
  },
);

it.each<[string, Record<string, unknown>]>([
  ["a strict status", status],
  ["an owned-port status", { ...openStatus, owned_port: true }],
  ["a fresh screenshot", { ...screenshotRequest, defer_open: true }],
  ["a WAIT-only opt-in", { action: "stream_status", defer_wait: true }],
])("never samples before connecting for %s", (_case, request) => {
  const { d, output } = preconnectDeadline(request);
  const connected = d.connect.mock.invocationCallOrder[0];
  expect(d.openDescriptors).toHaveBeenCalledTimes(1);
  expect(d.openDescriptors.mock.invocationCallOrder[0]).toBeGreaterThan(
    connected,
  );
  expect(output[0]).not.toContain('"ph1"');
});

it("drops the pre-connect code first at the unchanged cap, keeping the queue that scopes it", () => {
  const notHeldBefore: OwnedState = {
    beforeConnect: { unix: queueTable(pendingRow), fds: queueFds() },
  };
  const complete = preconnectDeadline(openStatus, {}, notHeldBefore).output[0];
  const { ph1, ...existing } = JSON.parse(complete);
  expect(ph1).toBe(2);
  const over = preconnectDeadline(
    openStatus,
    { chargedBytes: 545 - Buffer.byteLength(complete) },
    notHeldBefore,
  ).output[0];
  expect(JSON.parse(over)).toEqual(existing);
  expect(existing.q1).toEqual([1, 1, 1]);
});

/** One filesystem entry; hard links share the same object and so its identity. */
type FsNode = {
  kind: "dir" | "file" | "socket" | "symlink";
  ino: string; // Decimal inode number.
  uid?: number;
  mode?: number;
  content?: string;
};
const proofPath = directory + "/closed-session";
const activePath = directory + "/active-session";
const closedSocketPath = directory + "/sockets/default.sock";
// 2^60 + 1 and 2^60 + 2 collide as Numbers: identity must be compared as BigInt.
const selection: FsNode = {
  kind: "file",
  ino: "1152921504606846977",
  content: "default",
};
const closedRequest = { action: "stream_status", recognize_closed: true };
/** The selection and its proof as one hard-linked entry. */
const linked = (node: FsNode) => ({ [activePath]: node, [proofPath]: node });

/** Run the real helper over an in-memory root whose proof links to the selection. */
function closedDaemon(
  options: {
    request?: Record<string, unknown>;
    files?: Record<string, FsNode | undefined>;
    socketError?: string;
    afterProofOpens?: (files: Map<string, FsNode>) => void;
  } = {},
) {
  const files = new Map<string, FsNode>();
  for (const [file, node] of Object.entries({
    [directory]: { kind: "dir", ino: "1" },
    [directory + "/sockets"]: { kind: "dir", ino: "2" },
    ...linked(selection),
    ...options.files,
  } as Record<string, FsNode | undefined>))
    if (node) files.set(file, node);
  const stat = (node: FsNode, bigint: boolean) => {
    const number = (value: bigint) => (bigint ? value : Number(value));
    return {
      dev: number(BigInt(64)),
      ino: number(BigInt(node.ino)),
      uid: number(BigInt(node.uid ?? 1000)),
      mode: number(BigInt(node.mode ?? (node.kind === "dir" ? 0o700 : 0o600))),
      size: number(BigInt(Buffer.byteLength(node.content ?? ""))),
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "dir",
      isSocket: () => node.kind === "socket",
    };
  };
  const missing = (code = "ENOENT") =>
    Object.assign(new Error("PRIVATE filesystem path"), { code });
  const descriptors = new Map<number, FsNode>();
  const opened: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    write: jest.fn(),
    destroy: jest.fn(),
    setEncoding: jest.fn(),
  });
  const connect = jest.fn(() => socket);
  const exit = jest.fn();
  const output = jest.fn();
  runInNewContext(BROWSER_DAEMON_PROGRAM, {
    require: (specifier: string) => {
      if (specifier === "node:path") return path;
      if (specifier === "node:crypto") return { createHash };
      if (specifier === "node:net") return { createConnection: connect };
      if (specifier === "node:fs")
        return {
          constants: { O_RDONLY: 0, O_NOFOLLOW: 256, O_NONBLOCK: 2048 },
          lstatSync: (file: string, flags?: { bigint?: boolean }) => {
            if (file === closedSocketPath && options.socketError)
              throw missing(options.socketError);
            const node = files.get(file);
            if (!node) throw missing();
            return stat(node, flags?.bigint === true);
          },
          openSync: (file: string, flags: number) => {
            const node = files.get(file);
            if (!node) throw missing();
            if (node.kind === "symlink" && flags & 256) throw missing("ELOOP");
            opened.push(file);
            const fd = 20 + descriptors.size;
            descriptors.set(fd, node);
            if (file === proofPath) options.afterProofOpens?.(files);
            return fd;
          },
          fstatSync: (fd: number, flags?: { bigint?: boolean }) =>
            stat(descriptors.get(fd)!, flags?.bigint === true),
          readSync: (fd: number, bytes: Buffer) =>
            bytes.write(descriptors.get(fd)!.content ?? "", "utf8"),
          closeSync: (fd: number) => descriptors.delete(fd),
        };
      throw new Error("Unexpected process or module access");
    },
    process: {
      argv: [
        "node",
        directory,
        "default",
        JSON.stringify(options.request ?? closedRequest),
      ],
      getuid: () => 1000,
      platform: "linux",
      stdout: { write: output },
      exit,
    },
    Buffer,
    setTimeout: () => 1,
    clearTimeout: jest.fn(),
  });
  return { socket, connect, exit, output, opened, descriptors, files };
}

const closedScreenshot = {
  action: "screenshot",
  path: directory + "/preview.jpg",
  format: "jpeg",
  quality: 65,
  recognize_closed: true,
};

it.each<Record<string, unknown>>([
  closedRequest,
  { ...closedRequest, owned_port: true },
  { ...closedRequest, defer_wait: true },
  closedScreenshot,
  { ...closedScreenshot, defer_wait: true },
])(
  "answers only the helper literal for a verified close of the absent selected socket: %j",
  (request) => {
    const d = closedDaemon({ request });
    expect(d.exit.mock.calls).toEqual([[0]]);
    expect(d.output.mock.calls).toEqual([[BROWSER_DAEMON_SESSION_CLOSED]]);
    expect(d.connect).not.toHaveBeenCalled();
    // The pinned proof descriptor is released.
    expect(d.descriptors.size).toBe(0);
  },
);

it.each<[string, Parameters<typeof closedDaemon>[0]]>([
  ["no proof exists (an older wrapper)", { files: { [proofPath]: undefined } }],
  [
    "a later command published a new selection inode",
    { files: { [activePath]: { ...selection, ino: "1152921504606846978" } } },
  ],
  [
    "the proof names another selection",
    { files: linked({ ...selection, content: "other" }) },
  ],
  [
    "the proof names the selection with extra bytes",
    { files: linked({ ...selection, content: "default\n" }) },
  ],
  [
    "the proof is a symlink to the selection",
    { files: { [proofPath]: { kind: "symlink", ino: "9" } } },
  ],
  [
    "the proof is readable by others",
    { files: linked({ ...selection, mode: 0o640 }) },
  ],
  ["another user owns the proof", { files: linked({ ...selection, uid: 0 }) }],
  ["the proof is empty", { files: linked({ ...selection, content: "" }) }],
  [
    "the proof is oversized",
    { files: linked({ ...selection, content: "x".repeat(513) }) },
  ],
  [
    "the selection is a symlink",
    { files: { [activePath]: { kind: "symlink", ino: selection.ino } } },
  ],
  [
    "the run root is not private",
    { files: { [directory]: { kind: "dir", ino: "1", mode: 0o755 } } },
  ],
  [
    "the sockets directory is not private",
    {
      files: {
        [directory + "/sockets"]: { kind: "dir", ino: "2", mode: 0o750 },
      },
    },
  ],
  [
    "another user owns the sockets directory",
    { files: { [directory + "/sockets"]: { kind: "dir", ino: "2", uid: 0 } } },
  ],
  [
    "the socket reappears after the proof opens",
    {
      afterProofOpens: (files) =>
        files.set(closedSocketPath, { kind: "socket", ino: "30" }),
    },
  ],
  [
    "a stale proof is replaced by a matching one after it opens",
    {
      files: { [proofPath]: { ...selection, ino: "5" } },
      // Rechecking the path instead of the pinned descriptor would accept.
      afterProofOpens: (files) => files.set(proofPath, selection),
    },
  ],
  [
    "the opt-in is a string",
    { request: { ...closedRequest, recognize_closed: "true" } },
  ],
  [
    "the opt-in is numeric",
    { request: { ...closedRequest, recognize_closed: 1 } },
  ],
  [
    "the request is neither status nor screenshot",
    {
      request: {
        action: "viewport",
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        recognize_closed: true,
      },
    },
  ],
  [
    "the screenshot opt-in is a string",
    { request: { ...closedScreenshot, recognize_closed: "true" } },
  ],
])(
  "keeps the unchanged missing-socket exit2 packet when %s",
  (_case, options) => {
    const d = closedDaemon(options);
    expect(d.exit.mock.calls).toEqual([[2]]);
    expect(d.connect).not.toHaveBeenCalled();
    const text = d.output.mock.calls[0][0];
    // Byte-identical to a request that never opted in.
    const strict = closedDaemon({
      ...options,
      request: { action: "stream_status" },
    });
    expect(strict.opened).toEqual([]);
    expect(text).toBe(strict.output.mock.calls[0][0]);
    expect(JSON.parse(text)).toMatchObject({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
    });
    expect(text).not.toMatch(/session_closed|PRIVATE|default|115292/);
    expect(d.descriptors.size).toBe(0);
  },
);

it("never checks a proof unless the selected socket is exactly missing", () => {
  const d = closedDaemon({ socketError: "EACCES" });
  expect(d.exit.mock.calls).toEqual([[2]]);
  expect(d.opened).toEqual([]);
  expect(JSON.parse(d.output.mock.calls[0][0])).toMatchObject({
    diagnostic_reason: "socket_stat",
    diagnostic_error: "permission",
  });
});

it("strips the opt-in before an existing daemon sees the request", () => {
  const d = closedDaemon({
    files: { [closedSocketPath]: { kind: "socket", ino: "30" } },
  });
  expect(d.connect.mock.calls).toEqual([[closedSocketPath]]);
  d.socket.emit("connect");
  expect(d.socket.write.mock.calls).toEqual([
    ['{"action":"stream_status","id":"hackerai-preview"}\n'],
  ]);
  const response = {
    id: "hackerai-preview",
    success: true,
    data: { connected: true, port: 9223 },
  };
  d.socket.emit("data", JSON.stringify(response) + "\n");
  expect(d.exit.mock.calls).toEqual([[0]]);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual(response);
  // A live socket never consults the close proof.
  expect(d.opened).toEqual([]);
});

const { recognize_closed: _screenshotOptIn, ...strictScreenshot } =
  closedScreenshot;
describe.each<[string, Record<string, unknown>, Record<string, unknown>]>([
  ["screenshot", closedScreenshot, strictScreenshot],
  // A status that selected the socket before a completed CLOSE removed it.
  ["status", closedRequest, { action: "stream_status" }],
])("a %s connection ending without a final reply", (_kind, opted, strict) => {
  const liveSocket = { [closedSocketPath]: { kind: "socket", ino: "30" } };
  type Ending = (d: ReturnType<typeof closedDaemon>) => void;
  const socketError = (code: string) =>
    Object.assign(new Error("PRIVATE"), { code });
  const errorBeforeConnect: Ending = (d) =>
    d.socket.emit("error", socketError("ENOENT"));
  const resetAfterWrite: Ending = (d) => {
    d.socket.emit("connect");
    d.socket.emit("error", socketError("ECONNRESET"));
    d.socket.emit("close");
  };
  const closeAfterPartialReply: Ending = (d) => {
    d.socket.emit("connect");
    d.socket.emit("data", '{"id":"hackerai-preview"');
    d.socket.emit("close");
  };
  const endings: [string, Ending][] = [
    ["the listener disappears before connect", errorBeforeConnect],
    ["the written request's connection resets", resetAfterWrite],
    ["the connection closes after a partial reply", closeAfterPartialReply],
  ];
  /** Start with the selected socket present; it disappears before the ending. */
  const run = (
    ending: Ending,
    options: Parameters<typeof closedDaemon>[0] & {
      socketRemains?: boolean;
      replacement?: FsNode;
    } = {},
  ) => {
    const d = closedDaemon({
      request: opted,
      ...options,
      files: { ...liveSocket, ...options.files },
    });
    expect(d.connect.mock.calls).toEqual([[closedSocketPath]]);
    if (!options.socketRemains) d.files.delete(closedSocketPath);
    if (options.replacement) d.files.set(closedSocketPath, options.replacement);
    ending(d);
    return d;
  };

  it.each(endings)(
    "answers the helper literal for a verified close when %s",
    (_case, ending) => {
      const d = run(ending);
      expect(d.exit.mock.calls).toEqual([[0]]);
      expect(d.output.mock.calls).toEqual([[BROWSER_DAEMON_SESSION_CLOSED]]);
      expect(d.descriptors.size).toBe(0);
      // The daemon never receives the internal opt-in.
      for (const [line] of d.socket.write.mock.calls)
        expect(JSON.parse(line)).toEqual({ ...strict, id: "hackerai-preview" });
    },
  );

  it.each(
    (
      [
        ["no proof exists", { files: { [proofPath]: undefined } }],
        [
          "a later command published a new selection inode",
          {
            files: {
              [activePath]: { ...selection, ino: "1152921504606846978" },
            },
          },
        ],
        [
          "the proof names another session",
          { files: linked({ ...selection, content: "other" }) },
        ],
        ["the selected socket is still present", { socketRemains: true }],
        [
          "a replacement socket was published",
          { replacement: { kind: "socket", ino: "31" } },
        ],
        ["the request did not opt in", { request: strict }],
        [
          "the opt-in is a string",
          { request: { ...opted, recognize_closed: "true" } },
        ],
      ] as [string, Parameters<typeof run>[1]][]
    ).flatMap(([name, options]) =>
      endings.map(
        ([ending, act]) => [`${name} and ${ending}`, act, options] as const,
      ),
    ),
  )("keeps the unchanged exit6 when %s", (_case, ending, options) => {
    const d = run(ending, options);
    expect(d.exit.mock.calls).toEqual([[6]]);
    expect(d.output.mock.calls.map(([text]) => text).join("")).not.toMatch(
      /session_closed|PRIVATE|default|115292/,
    );
    expect(d.descriptors.size).toBe(0);
  });

  it("never reads the proof when the request did not opt in", () => {
    const d = run(resetAfterWrite, { request: strict });
    expect(d.exit.mock.calls).toEqual([[6]]);
    expect(d.opened).not.toContain(proofPath);
  });

  it("relays a final reply even when the connection then closes", () => {
    const d = run((daemon) => {
      daemon.socket.emit("connect");
      daemon.socket.emit(
        "data",
        '{"id":"hackerai-preview","success":true,"data":{}}\n',
      );
      daemon.socket.emit("close");
    });
    expect(d.exit.mock.calls).toEqual([[0]]);
    expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({
      id: "hackerai-preview",
      success: true,
      data: {},
    });
    expect(d.opened).not.toContain(proofPath);
  });
});

describe("opt-in status progress frames", () => {
  const frames = (letters: string) =>
    [...letters].map((letter) => `hp1:${letter}\n`).join("");
  const reply = {
    id: "hackerai-preview",
    success: true,
    data: { connected: true, port: 9223 },
  };
  type Act = (d: ReturnType<typeof daemon>) => void;
  const connected: Act = (d) => d.socket.emit("connect");
  const status = { action: "stream_status" };

  const replied: Act = (d) => {
    connected(d);
    d.reply(reply);
  };
  const expired: Act = (d) => {
    connected(d);
    d.timeout();
  };

  it.each<[string, DaemonOptions, Record<string, unknown>, Act, string]>([
    // The socket path is initialized, with no disposition yet.
    ["is still connecting", {}, status, () => {}, "ec"],
    ["relays a daemon reply", {}, status, replied, "ecws"],
    ["reaches its own deadline after the write", {}, status, expired, "ecwd"],
    [
      "reaches its own deadline while connecting",
      {},
      status,
      (d) => d.timeout(),
      "ecd",
    ],
    [
      "refuses a mismatched reply",
      {},
      status,
      (d) => {
        connected(d);
        d.reply({ ...reply, id: "PRIVATE" });
      },
      "ecwo",
    ],
    // Neither path initializes a socket.
    [
      "finds the selected socket missing",
      missingSocket,
      status,
      () => {},
      "eo",
    ],
    [
      "answers from the owned listeners",
      { pidFile: "314159", owned: ownedState },
      ownedRequest,
      () => {},
      "es",
    ],
  ])(
    "writes only constant ordered frames when the helper %s, with unchanged stdout, exit and daemon traffic",
    (_case, options, request, act, letters) => {
      const opted = daemon({
        ...options,
        request: { ...request, observe_progress: true },
      });
      act(opted);
      const plain = daemon({ ...options, request });
      act(plain);

      expect(opted.stderr()).toBe(frames(letters));
      // Only the helper's own nonblocking open of the stderr pipe, never a
      // (blocking) write to shared descriptor 2.
      expect(
        opted.openReceipt.mock.calls.filter(([file]) =>
          file.startsWith("/proc/self/"),
        ),
      ).toEqual([["/proc/self/fd/2", 1 | 2048]]);
      expect(opted.stderrWrites.mock.calls.map(([fd]) => fd)).toEqual(
        [...letters].map(() => 30),
      );
      // The consumer accepts exactly this producer sequence.
      expect(BROWSER_DAEMON_PROGRESS_FRAMES.test(opted.stderr())).toBe(true);
      expect(Object.keys(BROWSER_DAEMON_PROGRESS_SEQUENCES)).toContain(letters);
      // The opt-in is stripped: identical daemon traffic, stdout and exit.
      expect(plain.openReceipt).not.toHaveBeenCalledWith(
        "/proc/self/fd/2",
        expect.anything(),
      );
      expect(plain.stderrWrites).not.toHaveBeenCalled();
      expect(opted.connect.mock.calls).toEqual(plain.connect.mock.calls);
      expect(opted.socket.write.mock.calls).toEqual(
        plain.socket.write.mock.calls,
      );
      expect(opted.output.mock.calls).toEqual(plain.output.mock.calls);
      expect(opted.exit.mock.calls).toEqual(plain.exit.mock.calls);
      for (const [text] of opted.socket.write.mock.calls)
        expect(text).not.toContain("observe_progress");
    },
  );

  it.each<Record<string, unknown>>([
    status,
    { ...status, observe_progress: "true" },
    {
      action: "screenshot",
      path: directory + "/preview.jpg",
      format: "jpeg",
      quality: 65,
      observe_progress: true,
    },
  ])("never touches stderr without the exact status opt-in: %j", (request) => {
    const d = daemon({ request });
    replied(d);
    expect(d.openReceipt).not.toHaveBeenCalledWith(
      "/proc/self/fd/2",
      expect.anything(),
    );
    expect(d.stderrWrites).not.toHaveBeenCalled();
    const { observe_progress: _flag, ...forwarded } = request;
    expect(d.socket.write.mock.calls).toEqual([
      [JSON.stringify({ ...forwarded, id: "hackerai-preview" }) + "\n"],
    ]);
  });

  it.each<[string, DaemonOptions, number]>([
    // Each six-byte write is whole or EAGAIN; the frame is dropped, not retried.
    ["the stderr pipe is full", { stderrWriteError: "EAGAIN" }, 4],
    // A nonblocking FIFO open without a reader fails instead of waiting.
    ["the stderr pipe has no reader", { stderrOpenError: "ENXIO" }, 0],
    // Never a synchronous TTY or regular-file write.
    ["stderr is a terminal", { stderrKind: "tty" }, 0],
    ["stderr is a regular file", { stderrKind: "file" }, 0],
  ])(
    "delivers no frames and keeps stdout, exit and the daemon request when %s",
    (_case, options, attempts) => {
      for (const act of [replied, expired]) {
        const opted = daemon({
          ...options,
          request: { ...status, observe_progress: true },
        });
        act(opted);
        const plain = daemon({ request: status });
        act(plain);
        expect(opted.stderr()).toBe("");
        expect(opted.stderrWrites).toHaveBeenCalledTimes(attempts);
        expect(opted.socket.write.mock.calls).toEqual(
          plain.socket.write.mock.calls,
        );
        expect(opted.output.mock.calls).toEqual(plain.output.mock.calls);
        expect(opted.exit.mock.calls).toEqual(plain.exit.mock.calls);
      }
    },
  );
});
