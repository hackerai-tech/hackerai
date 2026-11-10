import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createHash } from "node:crypto";
import { BROWSER_DAEMON_PROGRAM } from "../daemon-program";

const directory = "/dev/shm/hackerai-browser-0123456789abcdef";
/** Run the real daemon helper against controlled filesystem and socket boundaries. */
function daemon(
  options: {
    directory?: string;
    invalidPath?: string;
    action?: string;
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
  const readReceipt = jest.fn((fd: number, bytes: Buffer) =>
    bytes.write(
      fd === 10
        ? options.pidFile!
        : JSON.stringify(fileReceipt(fd === 8, fd === 9)),
      "utf8",
    ),
  );
  const closeReceipt = jest.fn();
  const openReceipt = jest.fn((file: string) => {
    if (file.endsWith(".pid")) return 10;
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
            fd === 10 ? pidStat() : receiptStat(fd === 8, fd === 9),
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
          lstatSync: (file: string) => {
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
              mode: 0o700,
              isDirectory: () =>
                file !== socketPath && file !== options.invalidPath,
              isSocket: () =>
                file === socketPath && file !== options.invalidPath,
            };
          },
        };
      throw new Error("Unexpected process or module access");
    },
    process: {
      argv: [
        "node",
        options.directory ?? directory,
        options.name ?? "default",
        JSON.stringify({ action: options.action ?? "stream_status" }),
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
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
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

it("keeps the longest open/close/declaration failure below the unchanged 512-byte cap", () => {
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
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
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
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
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
  expect(d.output).not.toHaveBeenCalled();
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
      });
    else expect(d.output).not.toHaveBeenCalled();
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
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
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
  "keeps maximal history/close/open context within512 bytes and censors cross-session order (%s)",
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
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
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

it("keeps the combined selected process and maximal existing receipts within one 544-byte packet", () => {
  const longest = { ...receipt, at: Date.now() + 60_000, exit: 999 };
  const d = daemon({
    missingPath: directory + "/sockets/default.sock",
    missingCode: "ENOTDIR",
    pidFile: "314159",
    processVisibility: "same_uid",
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
    closeReceipt: { ...longest, action: "close", close_all: true },
  });
  const text = d.output.mock.calls[0][0];
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(544);
  expect(JSON.parse(text)).toMatchObject({
    p1: [1, 3, 2],
    h1: 3,
    open_idle: [1, "unparsed"],
    close_receipt: [
      1,
      "recorded",
      "completed",
      "other",
      "all_sessions",
      "unknown",
      "same_time",
    ],
  });
});
