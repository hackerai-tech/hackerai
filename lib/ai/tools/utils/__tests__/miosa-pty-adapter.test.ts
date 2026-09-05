import type { EventEmitter } from "node:events";

type MockWebSocket = EventEmitter & {
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
  terminate: jest.Mock;
};

const mockWebSocketInstances: MockWebSocket[] = [];
const mockWebSocketArgs: unknown[][] = [];
jest.mock("node:crypto", () => ({
  randomUUID: () => "12345678-1234-1234-1234-123456789abc",
}));

jest.mock("ws", () => {
  const { EventEmitter } = jest.requireActual(
    "node:events",
  ) as typeof import("node:events");

  class WebSocketMock extends EventEmitter {
    static readonly OPEN = 1;
    readyState = 0;
    send = jest.fn();
    close = jest.fn(() => {
      this.readyState = 3;
      this.emit("close", 1000);
    });
    terminate = jest.fn(() => {
      this.readyState = 3;
      this.emit("close", 1006);
    });

    constructor(...args: unknown[]) {
      super();
      mockWebSocketArgs.push(args);
      mockWebSocketInstances.push(this as unknown as MockWebSocket);
    }
  }

  return { __esModule: true, default: WebSocketMock };
});

import { createMiosaPtyHandle } from "../miosa-pty-adapter";
import type { MiosaSandbox } from "../miosa-sandbox";

function createSandbox(created: Record<string, unknown>) {
  const terminal = {
    create: jest.fn(async () => created),
    delete: jest.fn(async () => undefined),
  };
  return {
    sandbox: { sdkSandbox: { terminal } } as unknown as MiosaSandbox,
    terminal,
  };
}

describe("MIOSA PTY adapter", () => {
  const originalApiKey = process.env.MIOSA_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWebSocketInstances.length = 0;
    mockWebSocketArgs.length = 0;
    process.env.MIOSA_API_KEY = "msk_test";
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.MIOSA_API_KEY;
    else process.env.MIOSA_API_KEY = originalApiKey;
  });

  it("deletes the remote session when the WebSocket upgrade fails", async () => {
    const { sandbox, terminal } = createSandbox({
      session_id: "terminal-1",
      ws_url: "wss://miosa.invalid/terminal-1",
      stream_auth: "test-session-token",
    });

    const pending = createMiosaPtyHandle(sandbox, { cols: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();
    const socket = mockWebSocketInstances[0];
    expect(socket).toBeDefined();

    socket.emit("error", new Error("upgrade failed"));

    await expect(pending).rejects.toThrow("upgrade failed");
    expect(terminal.delete).toHaveBeenCalledTimes(1);
    expect(terminal.delete).toHaveBeenCalledWith("terminal-1");
  });

  it("deletes a created session when the response has no WebSocket URL", async () => {
    const { sandbox, terminal } = createSandbox({
      session_id: "terminal-2",
    });

    await expect(
      createMiosaPtyHandle(sandbox, { cols: 80, rows: 24 }),
    ).rejects.toThrow("terminal create returned no ws_url");
    expect(terminal.delete).toHaveBeenCalledWith("terminal-2");
    expect(mockWebSocketInstances).toHaveLength(0);
  });

  it("uses session auth and confirms container entry before exposing the terminal", async () => {
    const { sandbox, terminal } = createSandbox({
      sessionId: "terminal-3",
      wsUrl: "wss://miosa.invalid/terminal-3",
      streamAuth: "session-token",
    });
    const pending = createMiosaPtyHandle(sandbox, {
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      envs: { TEST: "with ' quote" },
    });
    await Promise.resolve();
    await Promise.resolve();
    const socket = mockWebSocketInstances[0];
    expect(mockWebSocketArgs[0]).toEqual([
      "wss://miosa.invalid/terminal-3",
      "miosa-terminal-v1",
      { headers: { Authorization: "Bearer session-token" } },
    ]);
    socket.readyState = 1;
    socket.emit("open");
    await Promise.resolve();
    await Promise.resolve();
    const handshake = new TextDecoder().decode(socket.send.mock.calls[0][0]);
    expect(handshake).toContain("exec docker exec -it --workdir '/tmp'");
    expect(handshake).toContain("hackerai-agent bash -lc");
    expect(handshake).not.toContain("12345678-1234-1234-1234-123456789abc");
    socket.emit(
      "message",
      Buffer.from("12345678-1234-1234-1234-123456789abc\r\n"),
    );
    const handle = await pending;
    const received = jest.fn();
    handle.onData(received);
    socket.emit("message", Buffer.from("雪\r\n"));
    expect(new TextDecoder().decode(received.mock.calls[0][0])).toBe("雪\r\n");
    await handle.sendInput(Buffer.from("command\n"));
    await handle.resize(100, 30);
    expect(socket.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
    );
    terminal.delete.mockRejectedValueOnce(
      new Error("delete unavailable") as never,
    );
    await expect(handle.kill()).rejects.toThrow("delete unavailable");
    await handle.kill();
    expect(terminal.delete).toHaveBeenCalledTimes(2);
    await expect(handle.exited).resolves.toEqual({ exitCode: null });
    await expect(handle.sendInput(Buffer.from("late"))).rejects.toThrow(
      "terminal is closed",
    );
  });

  it("cleans up when the socket closes before container readiness", async () => {
    const { sandbox, terminal } = createSandbox({
      sessionId: "terminal-4",
      wsUrl: "wss://miosa.invalid/terminal-4",
      streamAuth: "session-token",
    });
    const pending = createMiosaPtyHandle(sandbox, { cols: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();
    const socket = mockWebSocketInstances[0];
    socket.readyState = 1;
    socket.emit("open");
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("close", 1000);
    await expect(pending).rejects.toThrow(
      "terminal closed before container shell was ready",
    );
    expect(terminal.delete).toHaveBeenCalledWith("terminal-4");
  });
});
