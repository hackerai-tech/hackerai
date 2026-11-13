import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createHash } from "node:crypto";
import { BROWSER_DAEMON_PROGRAM } from "../daemon-program";

const directory = "/dev/shm/hackerai-browser-0123456789abcdef";
/** Preserve the old receipt budget and the existing full parser cap separately. */
function expectPacketBudgets(text: string) {
  const {
    cv: _cliAtPrepare,
    w1: _wrapperProcess,
    os1: _openSocket,
    k1: _commandClass,
    dv: _daemonVersion,
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
  const fileReceipt = (open: boolean, close = false) =>
    close ? options.closeReceipt : open ? options.openReceipt : options.receipt;
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
              ? options.pidFile!
              : JSON.stringify(fileReceipt(fd === 8, fd === 9)),
      "utf8",
    );
  };
  const closeReceipt = jest.fn();
  const openReceipt = jest.fn((file: string) => {
    if (file === "/proc/net/unix" || file === "/proc/net/tcp") {
      const text = file.endsWith("unix") ? owned.unix : owned.tcp;
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
      if (options.wrapperStatError)
        throw Object.assign(new Error("PRIVATE process"), {
          code: options.wrapperStatError,
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
    if (file !== "/proc/314159/fd") throw new Error("Unexpected process path");
    if (owned.fdError)
      throw Object.assign(new Error("PRIVATE descriptors"), {
        code: owned.fdError,
      });
    const names = Object.keys(owned.fds ?? {});
    return {
      readSync: () => (names.length ? { name: names.shift() } : null),
      closeSync: closeDescriptors,
    };
  });
  const readLink = jest.fn((file: string) => {
    const descriptor = /^\/proc\/314159\/fd\/([0-9]+)$/.exec(file)?.[1];
    if (descriptor === undefined || owned.fds?.[descriptor] === undefined)
      throw new Error("Unexpected descriptor path");
    if (owned.linkError)
      throw Object.assign(new Error("PRIVATE link"), {
        code: owned.linkError,
      });
    return owned.fds[descriptor];
  });
  let deadline: (() => void) | undefined;
  runInNewContext(BROWSER_DAEMON_PROGRAM, {
    require: (name: string) => {
      if (name === "node:path") return path;
      if (name === "node:crypto") return { createHash };
      if (name === "node:net") return { createConnection: connect };
      if (name === "node:fs")
        return {
          constants: { O_RDONLY: 0, O_NOFOLLOW: 256, O_NONBLOCK: 2048 },
          openSync: openReceipt,
          fstatSync: (fd: number) =>
            fd === 15 || fd === 16
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
            if (file !== "/proc/314159")
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
      stdout: { write: output },
      exit,
    },
    Buffer,
    setTimeout: (callback: () => void) => {
      deadline = callback;
      return 1;
    },
    clearTimeout: jest.fn(),
  });
  const reply = (value: unknown) =>
    socket.emit("data", JSON.stringify(value) + "\n");
  return {
    socket,
    connect,
    exit,
    output,
    reply,
    readReceipt,
    closeReceipt,
    openReceipt,
    lstat,
    openDescriptors,
    closeDescriptors,
    readLink,
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
  { id: "other-request", success: true, data: { port: 9223 } },
  { id: "hackerai-preview", success: false, error: "private failure" },
])("refuses an unsuccessful or mismatched daemon response", (response) => {
  const d = daemon();
  d.reply(response);
  expect(d.exit).toHaveBeenCalledWith(5);
  expect(JSON.parse(d.output.mock.calls[0][0])).toEqual({ cv: [1, 0] });
});

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
