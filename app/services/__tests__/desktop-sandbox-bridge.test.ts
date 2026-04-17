import { DesktopSandboxBridge } from "../desktop-sandbox-bridge";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockSubscription = {
  on: jest.fn(),
  subscribe: jest.fn(),
  unsubscribe: jest.fn(),
  removeAllListeners: jest.fn(),
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockClient = {
  newSubscription: jest.fn().mockReturnValue(mockSubscription),
  connect: jest.fn(),
  disconnect: jest.fn(),
  on: jest.fn(),
};

jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn().mockImplementation(() => mockClient),
}));

// Mock Tauri IPC
let mockInvokeHandler: (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
let capturedChannel: { onmessage?: (event: unknown) => void } | null = null;

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn((...args: unknown[]) => {
    const [cmd, invokeArgs] = args as [
      string,
      Record<string, unknown> | undefined,
    ];
    return mockInvokeHandler(cmd, invokeArgs);
  }),
  Channel: jest.fn().mockImplementation(() => {
    const ch = {
      onmessage: undefined as ((event: unknown) => void) | undefined,
    };
    capturedChannel = ch;
    return ch;
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function createTestJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 }));
  return `${header}.${payload}.fakesignature`;
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    connectDesktop: jest.fn().mockResolvedValue({
      connectionId: "conn-123",
      centrifugoToken: createTestJwt("user-456"),
      centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
    }),
    refreshCentrifugoTokenDesktop: jest
      .fn()
      .mockResolvedValue({ centrifugoToken: "new-token" }),
    disconnectDesktop: jest.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function getPublicationHandler(): (ctx: { data: unknown }) => void {
  const onCalls = mockSubscription.on.mock.calls;
  const pubCall = onCalls.find(([event]: [string]) => event === "publication");
  if (!pubCall) throw new Error("No publication handler registered");
  return pubCall[1];
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  capturedChannel = null;

  mockInvokeHandler = async (cmd: string) => {
    if (cmd === "execute_command") {
      return {
        stdout: "Darwin 24.0.0 arm64\ntest-host\n",
        stderr: "",
        exit_code: 0,
      };
    }
    if (cmd === "execute_stream_command") {
      return undefined;
    }
    throw new Error(`Unknown command: ${cmd}`);
  };
});

// ── targetConnectionId filtering ──────────────────────────────────────

describe("targetConnectionId filtering", () => {
  it("handles command when targetConnectionId matches this connection", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    (invoke as jest.Mock).mockClear();

    // Set up streaming mock that sends exit event via channel
    mockInvokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "execute_stream_command") {
        // Simulate the Rust side sending an exit event via channel
        if (capturedChannel?.onmessage) {
          capturedChannel.onmessage({ type: "exit", exitCode: 0 });
        }
        return undefined;
      }
      return undefined;
    };

    handler({
      data: {
        type: "command",
        commandId: "cmd-1",
        command: "echo hi",
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(invoke).toHaveBeenCalledWith(
      "execute_stream_command",
      expect.objectContaining({ command: "echo hi" }),
    );
  });

  it("ignores command when targetConnectionId does not match", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    (invoke as jest.Mock).mockClear();

    handler({
      data: {
        type: "command",
        commandId: "cmd-2",
        command: "echo hi",
        targetConnectionId: "other-connection",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(invoke).not.toHaveBeenCalledWith(
      "execute_stream_command",
      expect.anything(),
    );
  });

  it("handles command when targetConnectionId is undefined (broadcast)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    (invoke as jest.Mock).mockClear();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "execute_stream_command") {
        if (capturedChannel?.onmessage) {
          capturedChannel.onmessage({ type: "exit", exitCode: 0 });
        }
        return undefined;
      }
      return undefined;
    };

    handler({
      data: {
        type: "command",
        commandId: "cmd-3",
        command: "echo broadcast",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(invoke).toHaveBeenCalledWith(
      "execute_stream_command",
      expect.objectContaining({ command: "echo broadcast" }),
    );
  });
});

// ── extractUserIdFromToken ────────────────────────────────────────────

describe("extractUserIdFromToken", () => {
  it("extracts sub from a valid JWT", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    expect(mockClient.newSubscription).toHaveBeenCalledWith(
      "sandbox:user#user-456",
    );
  });

  it("throws on JWT with fewer than 3 parts", async () => {
    const config = buildConfig({
      connectDesktop: jest.fn().mockResolvedValue({
        connectionId: "conn-bad",
        centrifugoToken: "only.twoparts",
        centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
      }),
    });
    const bridge = new DesktopSandboxBridge(config);

    await expect(bridge.start()).rejects.toThrow("Invalid JWT");
  });

  it("throws on JWT missing sub field", async () => {
    const header = btoa(JSON.stringify({ alg: "HS256" }));
    const payload = btoa(JSON.stringify({ exp: 9999999999 }));
    const tokenNoSub = `${header}.${payload}.sig`;

    const config = buildConfig({
      connectDesktop: jest.fn().mockResolvedValue({
        connectionId: "conn-nosub",
        centrifugoToken: tokenNoSub,
        centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
      }),
    });
    const bridge = new DesktopSandboxBridge(config);

    await expect(bridge.start()).rejects.toThrow("JWT missing 'sub' claim");
  });
});

// ── forwardChunk ──────────────────────────────────────────────────────

describe("forwardChunk", () => {
  async function startBridgeAndForwardChunks(
    chunks: Array<Record<string, unknown>>,
  ) {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    // Mock execute_stream_command to send chunks via channel
    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "execute_stream_command") {
        if (capturedChannel?.onmessage) {
          for (const chunk of chunks) {
            capturedChannel.onmessage(chunk);
          }
        }
        return undefined;
      }
      return undefined;
    };

    handler({
      data: {
        type: "command",
        commandId: "cmd-fwd",
        command: "test",
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    return mockSubscription.publish.mock.calls;
  }

  it("publishes stdout message for stdout chunk", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "stdout", data: "hello world" },
    ]);

    expect(calls).toContainEqual([
      { type: "stdout", commandId: "cmd-fwd", data: "hello world" },
    ]);
  });

  it("does not publish for stderr chunk with empty data", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "stderr", data: "" },
    ]);

    const stderrCalls = calls.filter(
      ([msg]: [{ type: string }]) => msg.type === "stderr",
    );
    expect(stderrCalls).toHaveLength(0);
  });

  it("defaults exitCode to -1 when missing from exit chunk", async () => {
    const calls = await startBridgeAndForwardChunks([{ type: "exit" }]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: -1 },
    ]);
  });

  it("publishes correct exitCode when provided", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "exit", exitCode: 42 },
    ]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: 42 },
    ]);
  });

  it("forwards exitCode 0 for successful commands", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "exit", exitCode: 0 },
    ]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: 0 },
    ]);
  });

  it("warns when exitCode is missing from exit chunk", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await startBridgeAndForwardChunks([{ type: "exit" }]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exit chunk missing exitCode"),
    );
    warnSpy.mockRestore();
  });
});

// ── pty_data publish ordering ─────────────────────────────────────────
//
// Regression guard for the publishQueue serialization in handlePtyCreate.
// Rust flushes per-read (often per-char on interactive echo); firing N
// unawaited publishes at Centrifuge reordered arrivals server-side, which
// produced garbled terminal rendering. The chain through `publishQueue`
// must preserve FIFO order even when earlier publishes take longer.

describe("pty_data publish ordering", () => {
  it("serializes rapid pty_data publishes to preserve FIFO order", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    const publishOrder: string[] = [];
    let dataIdx = 0;
    mockSubscription.publish.mockImplementation(async (msg: unknown) => {
      const m = msg as { type: string; data?: string };
      if (m.type === "pty_data") {
        const idx = dataIdx++;
        // Decreasing delay — first chunk waits longest. Without the
        // publishQueue chain, later chunks (shorter delay) would land first.
        const delay = Math.max(0, 20 - idx * 2);
        await new Promise((r) => setTimeout(r, delay));
        publishOrder.push(m.data ?? "");
      }
    });

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "execute_pty_create") {
        return { pid: 9999, session_id: "sess-x" };
      }
      return undefined;
    };

    handler({
      data: {
        type: "pty_create",
        sessionId: "sess-x",
        command: "bash",
        cols: 80,
        rows: 24,
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedChannel?.onmessage).toBeDefined();

    const chunks = Array.from({ length: 10 }, (_, i) => `chunk-${i}`);
    for (const c of chunks) {
      capturedChannel!.onmessage!(c);
    }

    await new Promise((r) => setTimeout(r, 400));

    expect(publishOrder).toEqual(chunks);
  });
});
