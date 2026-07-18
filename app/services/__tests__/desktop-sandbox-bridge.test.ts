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
let mockClientOptions: { getToken?: () => Promise<string> } | null = null;

jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn().mockImplementation((_, options) => {
    mockClientOptions = options;
    return mockClient;
  }),
}));

// Mock Tauri IPC
let mockInvokeHandler: (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
let capturedChannel: { onmessage?: (event: unknown) => void } | null = null;
const originalFetch = global.fetch;

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
      .mockResolvedValue({ ok: true, centrifugoToken: "new-token" }),
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
  mockClientOptions = null;
  global.fetch = originalFetch;

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

afterEach(() => {
  global.fetch = originalFetch;
});

// ── desktop capability registration ───────────────────────────────────

describe("desktop capability registration", () => {
  it("advertises native file relay support for updated desktop builds", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    expect(config.connectDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: { commands: true, pty: true, files: true },
      }),
    );
  });
});

describe("terminal connection state", () => {
  it("notifies the owner when the server terminates the connection", async () => {
    const onTerminated = jest.fn();
    const config = buildConfig({
      onTerminated,
      refreshCentrifugoTokenDesktop: jest.fn().mockResolvedValue({
        ok: false,
        terminated: true,
        reason: "connection_inactive",
        connectionId: "conn-123",
        clientVersion: "desktop",
        status: "disconnected",
        disconnectReason: "presence_sweep",
        msSinceDisconnected: 100,
        msSinceLastHeartbeat: 200,
        msSinceCreated: 300,
      }),
    });
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    await expect(mockClientOptions?.getToken?.()).rejects.toThrow(
      "Centrifugo refresh aborted: connection_inactive",
    );

    expect(onTerminated).toHaveBeenCalledWith("connection_inactive");
    expect(bridge.getConnectionId()).toBeNull();
    expect(mockSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reports unauthenticated token refresh termination", async () => {
    const onTerminated = jest.fn();
    const error = { data: { code: "UNAUTHORIZED" } };
    const config = buildConfig({
      onTerminated,
      refreshCentrifugoTokenDesktop: jest.fn().mockRejectedValue(error),
    });
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    await expect(mockClientOptions?.getToken?.()).rejects.toBe(error);

    expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
    expect(bridge.getConnectionId()).toBeNull();
  });
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

  it("ignores command when targetConnectionId is undefined", async () => {
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

    expect(invoke).not.toHaveBeenCalledWith(
      "execute_stream_command",
      expect.anything(),
    );
  });

  it("ignores PTY control messages when targetConnectionId is undefined", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    (invoke as jest.Mock).mockClear();

    handler({
      data: {
        type: "pty_create",
        sessionId: "pty-1",
        command: "bash",
        cols: 80,
        rows: 24,
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(invoke).not.toHaveBeenCalledWith(
      "execute_pty_create",
      expect.anything(),
    );
  });
});

describe("command cancellation acknowledgement", () => {
  it.each([true, false])(
    "publishes the native cancellation result when invoke returns %s",
    async (nativeResult) => {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      const handler = getPublicationHandler();
      (bridge as unknown as { activeCommands: Set<string> }).activeCommands.add(
        "cmd-cancel",
      );
      mockInvokeHandler = async (cmd: string) => {
        if (cmd === "cancel_stream_command") return nativeResult;
        return undefined;
      };

      handler({
        data: {
          type: "command_cancel",
          commandId: "cmd-cancel",
          targetConnectionId: "conn-123",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockSubscription.publish).toHaveBeenCalledWith({
        type: "command_cancel_result",
        commandId: "cmd-cancel",
        canceled: nativeResult,
      });
    },
  );

  it("publishes false when native cancellation throws", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();
    (bridge as unknown as { activeCommands: Set<string> }).activeCommands.add(
      "cmd-cancel",
    );
    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "cancel_stream_command") {
        throw new Error("native transport failed");
      }
      return undefined;
    };

    handler({
      data: {
        type: "command_cancel",
        commandId: "cmd-cancel",
        targetConnectionId: "conn-123",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "command_cancel_result",
      commandId: "cmd-cancel",
      canceled: false,
    });
  });
});

// ── native desktop file relay ─────────────────────────────────────────

describe("native desktop file relay", () => {
  it("handles file_read with the local desktop file server", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "get_cmd_server_info") {
        return { port: 49152, token: "file-token" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        path: "C:\\repo\\app.ts",
        sizeBytes: 12,
        totalLines: 1,
        content: "hello world\n",
        startLine: 1,
        truncated: false,
      }),
    } as Response);

    handler({
      data: {
        type: "file_read",
        requestId: "file-req-1",
        path: "C:\\repo\\app.ts",
        range: [1, 1],
        maxFullBytes: 1024,
        maxResultBytes: 1024,
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/files/read",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer file-token",
        }),
        body: JSON.stringify({
          path: "C:\\repo\\app.ts",
          range_start: 1,
          range_end: 1,
          max_full_bytes: 1024,
          max_result_bytes: 1024,
        }),
      }),
    );
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_read_result",
      requestId: "file-req-1",
      path: "C:\\repo\\app.ts",
      sizeBytes: 12,
      totalLines: 1,
      content: "hello world\n",
      startLine: 1,
    });
  });

  it("handles file_write without executing a shell command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    (invoke as jest.Mock).mockClear();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "get_cmd_server_info") {
        return { port: 49152, token: "file-token" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    handler({
      data: {
        type: "file_write",
        requestId: "file-req-2",
        path: "C:\\repo\\app.ts",
        content: "updated",
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(invoke).not.toHaveBeenCalledWith(
      "execute_stream_command",
      expect.anything(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/files/write",
      expect.objectContaining({
        body: JSON.stringify({
          path: "C:\\repo\\app.ts",
          content: "updated",
          is_base64: false,
        }),
      }),
    );
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_ok",
      requestId: "file-req-2",
    });
  });

  it("passes base64 append requests through to the local file server", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "get_cmd_server_info") {
        return { port: 49152, token: "file-token" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    handler({
      data: {
        type: "file_append",
        requestId: "file-req-3",
        path: "C:\\repo\\asset.bin",
        content: "AAEC",
        isBase64: true,
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/files/append",
      expect.objectContaining({
        body: JSON.stringify({
          path: "C:\\repo\\asset.bin",
          content: "AAEC",
          is_base64: true,
        }),
      }),
    );
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_ok",
      requestId: "file-req-3",
    });
  });
});

// ── extractUserIdFromToken ────────────────────────────────────────────

describe("extractUserIdFromToken", () => {
  it("extracts sub from a valid JWT", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    expect(mockClient.newSubscription).toHaveBeenCalledWith(
      "sandbox:connection:conn-123#user-456",
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
      "[desktop-bridge]",
      expect.stringContaining("desktop_stream_exit_code_missing"),
    );
    warnSpy.mockRestore();
  });

  it("ignores a late stream chunk after the bridge stops", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();
    handler({
      data: {
        type: "command",
        commandId: "cmd-late",
        command: "test",
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capturedChannel?.onmessage).toBeDefined();

    await bridge.stop();
    const publishCountAfterStop = mockSubscription.publish.mock.calls.length;

    await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });

    expect(mockSubscription.publish).toHaveBeenCalledTimes(
      publishCountAfterStop,
    );
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

    // With debounce buffering, rapid chunks are batched into fewer publishes.
    // Verify the concatenated content preserves order (FIFO).
    const receivedContent = publishOrder.join("");
    expect(receivedContent).toEqual(chunks.join(""));
  });
});
