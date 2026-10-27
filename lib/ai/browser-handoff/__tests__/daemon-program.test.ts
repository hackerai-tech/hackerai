import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { BROWSER_DAEMON_PROGRAM } from "../daemon-program";

const directory = "/dev/shm/hackerai-browser-0123456789abcdef";
function daemon(
  options: { directory?: string; invalidPath?: string; action?: string } = {},
) {
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
  let deadline: (() => void) | undefined;
  runInNewContext(BROWSER_DAEMON_PROGRAM, {
    require: (name: string) => {
      if (name === "node:path") return path;
      if (name === "node:net") return { createConnection: connect };
      if (name === "node:fs")
        return {
          lstatSync: (file: string) => ({
            uid: 1000,
            isDirectory: () => file !== options.invalidPath,
            isSocket: () => file !== options.invalidPath,
          }),
        };
      throw new Error("Unexpected process or module access");
    },
    process: {
      argv: [
        "node",
        options.directory ?? directory,
        "default",
        JSON.stringify({ action: options.action ?? "stream_status" }),
      ],
      getuid: () => 1000,
      stdout: { write: output },
      exit,
    },
    setTimeout: (callback: () => void) => {
      deadline = callback;
      return 1;
    },
    clearTimeout: jest.fn(),
  });
  const reply = (value: unknown) =>
    socket.emit("data", JSON.stringify(value) + "\n");
  return { socket, connect, exit, output, reply, timeout: () => deadline?.() };
}

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

it.each([{ directory: "/tmp/hackerai-browser-owned" }, { action: "open" }])(
  "never starts or reconfigures a browser for an invalid request",
  (options) => {
    const d = daemon(options);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.exit).toHaveBeenCalledWith(2);
  },
);
