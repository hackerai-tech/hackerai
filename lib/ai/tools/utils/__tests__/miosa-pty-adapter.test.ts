import type { EventEmitter } from "node:events";

type MockWebSocket = EventEmitter & {
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
  terminate: jest.Mock;
};

const mockWebSocketInstances: MockWebSocket[] = [];

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

    constructor() {
      super();
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
});
