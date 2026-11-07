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
    name?: string;
    receipt?: unknown;
    receiptOwner?: number;
    receiptMode?: number;
    receiptSize?: number;
    receiptSymlink?: boolean;
    receiptRegular?: boolean;
    stdoutThrows?: boolean;
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
  const readReceipt = jest.fn((_: number, bytes: Buffer) => {
    return bytes.write(JSON.stringify(options.receipt), "utf8");
  });
  const closeReceipt = jest.fn();
  const openReceipt = jest.fn(() => {
    if (options.receipt === undefined || options.receiptSymlink)
      throw new Error("PRIVATE unavailable receipt");
    return 7;
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
          fstatSync: () => ({
            uid: options.receiptOwner ?? 1000,
            mode: options.receiptMode ?? 0o600,
            size: options.receiptSize ?? JSON.stringify(options.receipt).length,
            isFile: () => options.receiptRegular !== false,
          }),
          readSync: readReceipt,
          closeSync: closeReceipt,
          lstatSync: (file: string) => {
            if (file.endsWith("/wrapper-receipt.json"))
              return {
                uid: options.receiptOwner ?? 1000,
                mode: options.receiptMode ?? 0o600,
                size:
                  options.receiptSize ??
                  JSON.stringify(options.receipt)?.length,
                isFile: () =>
                  options.receipt !== undefined &&
                  !options.receiptSymlink &&
                  options.receiptRegular !== false,
              };
            if (file === options.missingPath)
              throw Object.assign(new Error("PRIVATE filesystem path"), {
                code: "ENOENT",
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
};

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
    expect(d.output).not.toHaveBeenCalled();
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
