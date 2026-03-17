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

// ── Helpers ───────────────────────────────────────────────────────────

function createTestJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, exp: Date.now() / 1000 + 3600 }));
  return `${header}.${payload}.fakesignature`;
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    cmdServerInfo: { port: 3001, token: "test-token" },
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

  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        os_info: {
          platform: "darwin",
          arch: "arm64",
          release: "24.0.0",
          hostname: "test-host",
        },
      }),
  });
});

// ── targetConnectionId filtering ──────────────────────────────────────

describe("targetConnectionId filtering", () => {
  it("handles command when targetConnectionId matches this connection", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    const streamResponse = {
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                JSON.stringify({ type: "exit", exit_code: 0 }) + "\n",
              ),
            })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(streamResponse);

    handler({
      data: {
        type: "command",
        commandId: "cmd-1",
        command: "echo hi",
        targetConnectionId: "conn-123",
      },
    });

    // Allow the async handleCommand to complete
    await new Promise((r) => setTimeout(r, 50));

    // fetch should have been called for execute/stream
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/execute/stream",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ignores command when targetConnectionId does not match", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    // Reset fetch call count after start()
    (global.fetch as jest.Mock).mockClear();

    handler({
      data: {
        type: "command",
        commandId: "cmd-2",
        command: "echo hi",
        targetConnectionId: "other-connection",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/execute/stream"),
      expect.anything(),
    );
  });

  it("handles command when targetConnectionId is undefined (broadcast)", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    const streamResponse = {
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                JSON.stringify({ type: "exit", exit_code: 0 }) + "\n",
              ),
            })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(streamResponse);

    handler({
      data: {
        type: "command",
        commandId: "cmd-3",
        command: "echo broadcast",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/execute/stream",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

// ── extractUserIdFromToken ────────────────────────────────────────────

describe("extractUserIdFromToken", () => {
  it("extracts sub from a valid JWT", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    // The bridge should have created a subscription on the correct channel
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

    const ndjson = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
    const streamResponse = {
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(ndjson),
            })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(streamResponse);

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

  it("defaults exit_code to -1 when missing from exit chunk", async () => {
    const calls = await startBridgeAndForwardChunks([{ type: "exit" }]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: -1 },
    ]);
  });

  it("publishes correct exit_code when provided", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "exit", exit_code: 42 },
    ]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: 42 },
    ]);
  });
});
