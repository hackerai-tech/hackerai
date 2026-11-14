import { sampleDiagnosticOperation } from "@/lib/analytics/diagnostic-sampling";
jest.mock("@/lib/analytics/diagnostic-sampling", () => ({
  sampleDiagnosticOperation: jest.fn(() => true),
}));
import { cancelDesktopRunLocally } from "../desktop-command-cancellation";
import { waitFor } from "@testing-library/dom";
import { DesktopSandboxBridge } from "../desktop-sandbox-bridge";
import {
  CentrifugoMessageReassembler,
  isCentrifugoTransportFragment,
} from "@/packages/local/src/centrifugo-transport";
import {
  captureAuthenticatedEvent,
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "@/lib/analytics/client";
import type * as TauriCore from "@tauri-apps/api/core";
import { DesktopRelayTelemetry } from "@/lib/analytics/desktop-relay";
import { sanitizeDesktopAckEvent } from "@/lib/analytics/desktop-ack-privacy";
import {
  NATIVE_AUTHORIZATION_CAUSE_PROPERTIES,
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
} from "@/lib/analytics/native-authorization-diagnostics";
import { LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS } from "@/lib/centrifugo/presence";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockSubscription = {
  on: jest.fn(),
  subscribe: jest.fn(),
  unsubscribe: jest.fn(),
  removeAllListeners: jest.fn(),
  publish: jest.fn().mockResolvedValue(undefined),
  ready: jest.fn().mockResolvedValue(undefined),
  presence: jest
    .fn()
    .mockResolvedValue({ clients: { worker: { user: "user-456" } } }),
};

const mockClient = {
  newSubscription: jest.fn().mockReturnValue(mockSubscription),
  connect: jest.fn(),
  disconnect: jest.fn(),
  removeSubscription: jest.fn(),
  on: jest.fn(),
  ready: jest.fn().mockResolvedValue(undefined),
};
let mockClientOptions: {
  getToken?: () => Promise<string>;
  emulationEndpoint?: string;
} | null = null;
let mockClientEndpoint: unknown = null;

jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn().mockImplementation((endpoint, options) => {
    mockClientEndpoint = endpoint;
    mockClientOptions = options;
    return mockClient;
  }),
  errorCodes: {
    timeout: 1,
    connectionClosed: 11,
  },
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn().mockReturnValue(true),
  captureQueuedAuthenticatedEvent: jest.fn().mockReturnValue(true),
  getIdentifiedAnalyticsUserId: jest.fn().mockReturnValue("user-456"),
  subscribeAuthenticatedAnalytics: jest.fn(() => () => {}),
}));

// Mock Tauri IPC
let mockInvokeHandler: (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
let mockUseAuthorizedNative = false;
let capturedChannel: { onmessage?: (event: unknown) => void } | null = null;
const originalFetch = global.fetch;

jest.mock("@tauri-apps/api/core", () => {
  const invoke = jest.fn(
    (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (!mockUseAuthorizedNative) {
        if (cmd === "probe_desktop_file_bridge") {
          return invoke("desktop_file_request", {
            request: { type: "file_stat", path: "." },
          });
        }
        const message = args?.message as Record<string, unknown> | undefined;
        if (cmd === "authorized_desktop_file_request" && message) {
          const range = message.range as [number, number] | undefined;
          return invoke("desktop_file_request", {
            request: {
              type: message.type,
              path: message.path,
              ...(message.type === "file_read"
                ? {
                    range_start: range?.[0],
                    range_end: range?.[1],
                    max_full_bytes: message.maxFullBytes,
                    max_result_bytes: message.maxResultBytes,
                  }
                : {}),
              ...(message.type === "file_write" ||
              message.type === "file_append"
                ? {
                    content: message.content,
                    is_base64: Boolean(message.isBase64),
                    allowed_root: message.allowedRoot,
                  }
                : {}),
            },
          });
        }
        if (cmd === "execute_authorized_stream_command" && message) {
          return invoke("execute_stream_command", {
            commandId: message.commandId,
            command: message.command,
            cwd: message.cwd,
            env: message.env,
            ...(message.stdin !== undefined
              ? {
                  stdin: message.stdin,
                  stdinEncoding: message.stdinEncoding ?? "utf8",
                }
              : {}),
            timeoutMs: message.timeout ?? 30_000,
            onEvent: args?.onEvent,
          });
        }
        const ptyCommands: Record<string, string> = {
          execute_authorized_pty_create: "execute_pty_create",
          execute_authorized_pty_input: "execute_pty_input",
          execute_authorized_pty_resize: "execute_pty_resize",
          execute_authorized_pty_kill: "execute_pty_kill",
        };
        if (ptyCommands[cmd] && message) {
          return invoke(ptyCommands[cmd], {
            sessionId: message.sessionId,
            command: message.command,
            data: message.data,
            cols: message.cols ?? 80,
            rows: message.rows ?? 24,
            cwd: message.cwd,
            env: message.env,
            onData: args?.onData,
          });
        }
      }
      return mockInvokeHandler(cmd, args);
    },
  );
  return {
    invoke,
    Channel: jest.fn().mockImplementation(() => {
      const ch = {
        onmessage: undefined as ((event: unknown) => void) | undefined,
        cleanupCallback: jest.fn(),
      };
      capturedChannel = ch;
      return ch;
    }),
  };
});

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
    heartbeatDesktop: jest.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function getClientHandler(
  eventName: string,
): (ctx: Record<string, unknown>) => void {
  const call = mockClient.on.mock.calls.find(([event]) => event === eventName);
  if (!call) throw new Error(`No client ${eventName} handler registered`);
  return call[1];
}

function getSubscriptionHandler(
  eventName: string,
): (ctx: Record<string, unknown>) => void {
  const call = mockSubscription.on.mock.calls.find(
    ([event]) => event === eventName,
  );
  if (!call) throw new Error(`No subscription ${eventName} handler registered`);
  return call[1];
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
  mockUseAuthorizedNative = false;
  capturedChannel = null;
  mockClientEndpoint = null;
  mockClientOptions = null;
  global.fetch = originalFetch;

  mockInvokeHandler = async (cmd: string) => {
    if (cmd === "desktop_file_request") {
      return { kind: "not_file", path: "." };
    }
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

it("publishes native file replies only on the requested operation channel", async () => {
  const bridge = new DesktopSandboxBridge(buildConfig());
  await bridge.start();
  const reply = {
    ...mockSubscription,
    on: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn(),
    removeAllListeners: jest.fn(),
  };
  mockClient.newSubscription.mockReturnValueOnce(reply);
  const native = mockInvokeHandler;
  mockInvokeHandler = async (cmd, args) => {
    if (cmd === "desktop_file_request")
      return {
        path: "/tmp/test",
        sizeBytes: 5,
        totalLines: 1,
        content: "hello",
      };
    return native(cmd, args);
  };
  try {
    getPublicationHandler()({
      data: {
        type: "file_read",
        requestId: "isolated-file",
        path: "/tmp/test",
        targetConnectionId: "conn-123",
        operationChannel: true,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockClient.newSubscription).toHaveBeenCalledWith(
      "sandbox:operation:conn-123:file:isolated-file#user-456",
    );
    expect(reply.publish).toHaveBeenCalledWith({
      type: "operation_ready",
      requestId: "isolated-file",
    });
    expect(reply.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "file_read_result", content: "hello" }),
    );
    expect(mockSubscription.publish).not.toHaveBeenCalled();
    expect(reply.unsubscribe).toHaveBeenCalled();
    expect(mockClient.removeSubscription).toHaveBeenCalledWith(reply);
  } finally {
    await bridge.stop();
  }
});

// ── desktop capability registration ───────────────────────────────────

describe("desktop capability registration", () => {
  it.each(["0.0.59", "0.0.72"])(
    "keeps published %s native commands usable without invoking commands outside its ACL",
    async (version) => {
      // Release-mode Tauri rejects commands absent from the installed binary's
      // manifest with this ACL error, rather than the debug 'not found' error.
      mockUseAuthorizedNative = true;
      const original = mockInvokeHandler;
      const invoked: string[] = [];
      mockInvokeHandler = async (cmd, args) => {
        invoked.push(cmd);
        if (cmd === "plugin:app|version") return version;
        if (
          cmd === "desktop_file_request" &&
          (args?.request as { path?: string })?.path === "/tmp/legacy-stat-qa"
        ) {
          return { kind: "file", path: "/tmp/legacy-stat-qa", sizeBytes: 7 };
        }
        if (
          cmd === "probe_desktop_file_bridge" ||
          cmd === "get_desktop_os_info" ||
          cmd.includes("authorized_")
        ) {
          throw new Error(`Command ${cmd} not allowed by ACL`);
        }
        return original(cmd, args);
      };
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        expect(config.connectDesktop).toHaveBeenCalledWith(
          expect.objectContaining({
            capabilities: expect.objectContaining({ files: true }),
          }),
        );
        getPublicationHandler()({
          data: {
            type: "file_stat",
            requestId: "published-native-stat",
            path: "/tmp/legacy-stat-qa",
            targetConnectionId: "conn-123",
          },
        });
        await waitFor(() => {
          expect(mockSubscription.publish).toHaveBeenCalledWith({
            type: "file_stat_result",
            requestId: "published-native-stat",
            kind: "file",
            path: "/tmp/legacy-stat-qa",
            sizeBytes: 7,
          });
        });
        expect(invoked).toContain("desktop_file_request");
        const { invoke } = await import("@tauri-apps/api/core");
        expect(invoke).toHaveBeenCalledWith("desktop_file_request", {
          request: { type: "file_stat", path: "/tmp/legacy-stat-qa" },
        });
        expect(invoked).not.toContain("probe_desktop_file_bridge");
        expect(invoked).not.toContain("authorized_desktop_file_request");
        expect(invoked).not.toContain("get_desktop_os_info");
      } finally {
        await bridge.stop();
      }
    },
  );

  it.each(["0.0.0", "0.0.73", "unknown"])(
    "does not downgrade a native authorization denial for %s",
    async (version) => {
      mockUseAuthorizedNative = true;
      const original = mockInvokeHandler;
      const invoked: string[] = [];
      mockInvokeHandler = async (cmd, args) => {
        invoked.push(cmd);
        if (cmd === "plugin:app|version") return version;
        if (cmd === "get_desktop_os_info")
          return {
            platform: "darwin",
            arch: "arm64",
            release: "qa",
            hostname: "qa",
          };
        if (cmd === "probe_desktop_file_bridge")
          return { kind: "not_file", path: "." };
        if (cmd === "authorized_desktop_file_request") {
          // Debug ACL errors can also contain 'Command not found'. That must
          // never turn a permission denial into a legacy command invocation.
          throw new Error(
            "authorized_desktop_file_request not allowed. Command not found",
          );
        }
        return original(cmd, args);
      };
      const bridge = new DesktopSandboxBridge(buildConfig());
      try {
        await bridge.start();
        getPublicationHandler()({
          data: {
            type: "file_stat",
            requestId: "native-denied-stat",
            path: ".",
            targetConnectionId: "conn-123",
            authorizationId: "test-authorization",
          },
        });
        await waitFor(() => {
          expect(mockSubscription.publish).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "file_error",
              requestId: "native-denied-stat",
            }),
          );
        });
        expect(invoked).toContain("authorized_desktop_file_request");
        expect(invoked).not.toContain("desktop_file_request");
      } finally {
        await bridge.stop();
      }
    },
  );

  it.each([
    "Command get_environment_id not allowed by ACL",
    "Command get_environment_id not found",
    "Unknown command: get_environment_id",
    "get_environment_id is not registered",
  ])(
    "keeps legacy Desktop usable when native identity is unavailable: %s",
    async (message) => {
      const original = mockInvokeHandler;
      mockInvokeHandler = async (cmd, args) => {
        if (cmd === "get_environment_id") throw new Error(message);
        return original(cmd, args);
      };
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      await bridge.start();
      expect(config.connectDesktop).toHaveBeenCalledWith(
        expect.not.objectContaining({ environmentId: expect.anything() }),
      );
      expect(bridge.getEnvironmentId()).toBeUndefined();
      await bridge.stop();
    },
  );

  it("registers the persistent native identity and waits for relay readiness before heartbeating", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) =>
      cmd === "get_environment_id" ? "native-environment" : original(cmd, args);
    let finishSubscription!: () => void;
    let subscriptionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      subscriptionEntered = resolve;
    });
    mockSubscription.ready.mockImplementationOnce(() => {
      subscriptionEntered();
      return new Promise<void>((resolve) => {
        finishSubscription = resolve;
      });
    });
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    const started = bridge.start();
    // Wait until registration has reached the subscription readiness barrier.
    await entered;
    expect(config.connectDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "native-environment" }),
    );
    expect(config.heartbeatDesktop).not.toHaveBeenCalled();
    finishSubscription();
    await started;
    expect(bridge.getEnvironmentId()).toBe("native-environment");
    expect(config.heartbeatDesktop).toHaveBeenCalledWith({
      connectionId: "conn-123",
    });
    await bridge.stop();
  });

  it("exposes this computer's identity even when backend registration fails", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) =>
      cmd === "get_environment_id" ? "native-environment" : original(cmd, args);
    const onConnectionState = jest.fn();
    const config = buildConfig({
      onConnectionState,
      connectDesktop: jest.fn().mockRejectedValue(new Error("offline")),
    });
    const bridge = new DesktopSandboxBridge(config);

    await expect(bridge.start()).rejects.toThrow("offline");

    expect(onConnectionState).toHaveBeenCalledWith(
      "connecting",
      "native-environment",
    );
    expect(onConnectionState).not.toHaveBeenCalledWith("connected");
    expect(config.heartbeatDesktop).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("fails closed when native identity storage is corrupt", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "get_environment_id")
        throw new Error("Invalid environment identity version");
      return original(cmd, args);
    };
    const config = buildConfig();
    await expect(new DesktopSandboxBridge(config).start()).rejects.toThrow(
      "Invalid environment identity",
    );
    expect(config.connectDesktop).not.toHaveBeenCalled();
  });

  it("does not register a connection after stopping during the file probe", async () => {
    let finishProbe!: () => void;
    let enteredProbe!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProbe = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request") {
        enteredProbe();
        await pending;
      }
      return original(cmd, args);
    };
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    const stopped = expect(bridge.start()).rejects.toThrow(
      "stopped during startup",
    );
    await entered;
    await bridge.stop();
    finishProbe();
    await stopped;
    expect(config.connectDesktop).not.toHaveBeenCalled();
    expect(mockClient.connect).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "disconnects a late registration without reviving it (restart=%s)",
    async (restart) => {
      let finishConnect!: () => void;
      let enteredConnect!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredConnect = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        finishConnect = resolve;
      });
      const response = {
        connectionId: "new-connection",
        centrifugoToken: createTestJwt("user-456"),
        centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
      };
      const config = buildConfig({
        connectDesktop: jest
          .fn()
          .mockImplementationOnce(async () => {
            enteredConnect();
            await pending;
            return { ...response, connectionId: "late-connection" };
          })
          .mockResolvedValue(response),
      });
      const bridge = new DesktopSandboxBridge(config);
      const stopped = expect(bridge.start()).rejects.toThrow(
        "stopped during startup",
      );
      await entered;
      await bridge.stop();
      await bridge.stop();
      if (restart) await bridge.start();
      finishConnect();
      await stopped;
      expect(config.disconnectDesktop).toHaveBeenCalledTimes(1);
      expect(config.disconnectDesktop).toHaveBeenCalledWith({
        connectionId: "late-connection",
      });
      expect(bridge.getConnectionId()).toBe(restart ? "new-connection" : null);
      expect(mockClient.connect).toHaveBeenCalledTimes(restart ? 1 : 0);
      await bridge.stop();
    },
  );
  it("advertises native file relay support for updated desktop builds", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    expect(config.connectDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: {
          commands: true,
          pty: true,
          files: true,
          operationChannels: true,
        },
      }),
    );
  });

  it("advertises stdin only after native support is confirmed", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) =>
      cmd === "get_command_stdin_support" ? true : original(cmd, args);
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();
    expect(config.connectDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: expect.objectContaining({ commandStdin: true }),
      }),
    );
    await bridge.stop();
  });

  it("selects command-based files when the legacy file transport is broken, and reprobes on reconnect", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request")
        throw new Error("Command desktop_file_request not found");
      if (cmd === "get_cmd_server_info")
        return { port: 49152, token: "private-token" };
      return original(cmd, args);
    };
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Load failed"));
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();
    expect(config.connectDesktop).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capabilities: {
          commands: true,
          pty: true,
          files: false,
          operationChannels: true,
        },
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/files/stat",
      expect.objectContaining({ body: JSON.stringify({ path: "." }) }),
    );
    expect(
      JSON.stringify((captureAuthenticatedEvent as jest.Mock).mock.calls),
    ).not.toContain("private-token");
    await bridge.stop();
    mockInvokeHandler = original;
    await bridge.start();
    expect(config.connectDesktop).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capabilities: {
          commands: true,
          pty: true,
          files: true,
          operationChannels: true,
        },
      }),
    );
    await bridge.stop();
  });

  it("preserves the unavailable native API and failed HTTP causes on a same-connection probe", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request")
        throw new Error("Command desktop_file_request not found");
      if (cmd === "get_cmd_server_info")
        return { port: 49152, token: "PRIVATE_TOKEN" };
      return original(cmd, args);
    };
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Load failed"));
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "desktop_file_bridge_probe_failed",
      expect.objectContaining({
        native_failure: "native_ipc_unavailable",
        file_failure: "legacy_http_transport",
      }),
    );
    getPublicationHandler()({
      data: {
        type: "file_stat",
        requestId: "broken-probe",
        path: ".",
        targetConnectionId: "conn-123",
      },
    });
    await waitFor(() =>
      expect(mockSubscription.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_error",
          requestId: "broken-probe",
          fileFailure: "legacy_http_transport",
          message: expect.stringContaining("Update and fully reopen"),
        }),
      ),
    );
    expect(
      JSON.stringify((captureAuthenticatedEvent as jest.Mock).mock.calls),
    ).not.toContain("PRIVATE_TOKEN");
    await bridge.stop();
  });

  it("recovers a transient startup file probe before advertising missing capability", async () => {
    const original = mockInvokeHandler;
    let probes = 0;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request" && ++probes === 1)
        throw new TypeError("Load failed");
      return original(cmd, args);
    };
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();
    expect(config.connectDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: expect.objectContaining({ files: true }),
      }),
    );
    expect(probes).toBe(2);
    await bridge.stop();
  });

  it("keeps native permission denials on the native adapter", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request")
        throw new Error("Metadata error: Permission denied");
      return original(cmd, args);
    };
    global.fetch = jest.fn();
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();
    expect(config.connectDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: {
          commands: true,
          pty: true,
          files: true,
          operationChannels: true,
        },
      }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it.each([
    "Command desktop_file_request not allowed by ACL",
    "desktop_file_request not allowed. Command not found",
  ])(
    "refuses to register an ACL-denied Desktop and recovers after reopening (%s)",
    async (denial) => {
      const original = mockInvokeHandler;
      mockInvokeHandler = async (cmd, args) => {
        if (cmd === "plugin:app|version") return "0.0.59";
        if (cmd === "desktop_file_request") throw new Error(denial);
        return original(cmd, args);
      };
      global.fetch = jest.fn();
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      await expect(bridge.start()).rejects.toMatchObject({
        fileFailure: "native_ipc_denied",
      });
      expect(config.connectDesktop).not.toHaveBeenCalled();
      expect(mockClient.connect).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
        "desktop_file_bridge_probe_failed",
        expect.objectContaining({
          native_app_version: "0.0.59",
          native_platform: "darwin",
          file_failure: "native_ipc_denied",
        }),
      );
      await bridge.stop();
      mockInvokeHandler = original;
      await bridge.start();
      expect(config.connectDesktop).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: expect.objectContaining({ files: true }),
        }),
      );
      await bridge.stop();
    },
  );

  it.each(["MINGW64_NT-10.0-22631", "MINGW32_NT-6.1", "MSYS_NT-10.0-22631"])(
    "publishes Windows identity when the native shell reports %s",
    async (platform) => {
      const original = mockInvokeHandler;
      mockInvokeHandler = async (cmd, args) => {
        if (
          cmd === "execute_command" &&
          String(args?.command).startsWith("uname")
        ) {
          return {
            stdout: `${platform} 3.5.4 x86_64\r\nqa-host\r\n`,
            stderr: "",
            exit_code: 0,
          };
        }
        return original(cmd, args);
      };
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        expect(config.connectDesktop).toHaveBeenCalledWith(
          expect.objectContaining({
            osInfo: expect.objectContaining({
              platform: "win32",
              arch: "x86_64",
              hostname: "qa-host",
            }),
          }),
        );
      } finally {
        await bridge.stop();
      }
    },
  );

  it.each([
    ["windows", "win32", "windows"],
    ["macos", "darwin", "darwin"],
    ["linux", "linux", "linux"],
  ])(
    "registers 0.0.74 native OS %s as %s and reports it after a native denial",
    async (rustOs, platform, nativePlatform) => {
      const original = mockInvokeHandler;
      let denyFiles = true;
      mockInvokeHandler = async (cmd, args) => {
        if (cmd === "plugin:app|version") return "0.0.74";
        // Exact Rust shape: platform is std::env::consts::OS.
        if (cmd === "get_desktop_os_info")
          return {
            platform: rustOs,
            arch: "x64",
            release: "10.0.26100",
            hostname: "qa-host",
          };
        if (cmd === "execute_command")
          throw new Error("native OS info must not fall back to a shell");
        if (denyFiles && cmd === "desktop_file_request")
          throw new Error("Command desktop_file_request not allowed by ACL");
        return original(cmd, args);
      };
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      try {
        await expect(bridge.start()).rejects.toMatchObject({
          fileFailure: "native_ipc_denied",
        });
        expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
          "desktop_file_bridge_probe_failed",
          expect.objectContaining({
            native_app_version: "0.0.74",
            native_platform: nativePlatform,
          }),
        );
        await bridge.stop();
        denyFiles = false;
        await bridge.start();
        expect(config.connectDesktop).toHaveBeenCalledWith(
          expect.objectContaining({
            osInfo: {
              platform,
              arch: "x64",
              release: "10.0.26100",
              hostname: "qa-host",
            },
          }),
        );
      } finally {
        await bridge.stop();
        mockInvokeHandler = original;
      }
    },
  );

  it("records Windows native diagnostics without trusting the browser user agent", async () => {
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request")
        throw new Error("Command desktop_file_request not allowed by ACL");
      if (cmd === "execute_command") {
        const command = (args as { command: string }).command;
        if (command.startsWith("uname"))
          return { stdout: "", stderr: "", exit_code: 1 };
        return {
          stdout: command.startsWith("ver")
            ? "Microsoft Windows [Version 10.0.22631.4890]\nqa-host"
            : "AMD64",
          stderr: "",
          exit_code: 0,
        };
      }
      return original(cmd, args);
    };
    const bridge = new DesktopSandboxBridge(buildConfig());
    await expect(bridge.start()).rejects.toMatchObject({
      fileFailure: "native_ipc_denied",
    });
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "desktop_file_bridge_probe_failed",
      expect.objectContaining({ native_platform: "windows" }),
    );
    await bridge.stop();
  });

  it.each(["PRIVATE_TOKEN /private/customer/file", undefined])(
    "does not trust invalid native version diagnostics (%s)",
    async (version) => {
      const original = mockInvokeHandler;
      mockInvokeHandler = async (cmd, args) => {
        if (cmd === "plugin:app|version") return version;
        if (cmd === "desktop_file_request")
          throw new Error("Command desktop_file_request not allowed by ACL");
        return original(cmd, args);
      };
      const bridge = new DesktopSandboxBridge(buildConfig());
      await expect(bridge.start()).rejects.toMatchObject({
        fileFailure: "native_ipc_denied",
      });
      expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
        "desktop_file_bridge_probe_failed",
        expect.objectContaining({ native_app_version: "unknown" }),
      );
      expect(
        JSON.stringify((captureAuthenticatedEvent as jest.Mock).mock.calls),
      ).not.toContain("PRIVATE_TOKEN");
      await bridge.stop();
    },
  );

  it("allows a slow successful probe its original startup budget", async () => {
    jest.useFakeTimers();
    const original = mockInvokeHandler;
    let probes = 0;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request") {
        probes++;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return original(cmd, args);
    };
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    try {
      const started = bridge.start();
      await jest.advanceTimersByTimeAsync(2001);
      await started;
      expect(config.connectDesktop).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: expect.objectContaining({ files: true }),
        }),
      );
      expect(probes).toBe(1);
    } finally {
      await bridge.stop();
      jest.useRealTimers();
    }
  });

  it("does not block terminal startup on a hung file probe", async () => {
    jest.useFakeTimers();
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "desktop_file_request") return new Promise(() => {});
      return original(cmd, args);
    };
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    try {
      const started = bridge.start();
      await jest.advanceTimersByTimeAsync(3_001);
      await started;
      expect(config.connectDesktop).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: {
            commands: true,
            pty: true,
            files: false,
            operationChannels: true,
          },
        }),
      );
    } finally {
      await bridge.stop();
      jest.useRealTimers();
    }
  });
});

it("waits for the relay and subscription before reporting ready", async () => {
  const onConnectionState = jest.fn();
  const config = buildConfig({ onConnectionState });
  const bridge = new DesktopSandboxBridge(config);

  await bridge.start();
  await Promise.resolve();

  expect(mockClientEndpoint).toEqual([
    {
      transport: "websocket",
      endpoint: "ws://localhost:8000/connection/websocket",
    },
    {
      transport: "http_stream",
      endpoint: "http://localhost:8000/connection/http_stream",
    },
  ]);
  expect(mockClientOptions?.emulationEndpoint).toBe(
    "http://localhost:8000/emulation",
  );
  expect(mockClient.ready).toHaveBeenCalledWith(15_000);
  expect(mockSubscription.ready).toHaveBeenCalledWith(15_000);
  expect(config.heartbeatDesktop).toHaveBeenCalledWith({
    connectionId: "conn-123",
  });
  expect(onConnectionState).toHaveBeenCalledWith("connected");

  await bridge.stop();
});

it("reports reconnecting and restored subscription state", async () => {
  const onConnectionState = jest.fn();
  const config = buildConfig({ onConnectionState });
  const bridge = new DesktopSandboxBridge(config);
  await bridge.start();

  getClientHandler("connecting")({ code: 1, reason: "transport closed" });
  getSubscriptionHandler("subscribing")({
    code: 1,
    reason: "transport closed",
  });
  getSubscriptionHandler("subscribed")({
    recovered: true,
    wasRecovering: true,
  });

  expect(onConnectionState).toHaveBeenNthCalledWith(2, "connecting");
  expect(onConnectionState).toHaveBeenNthCalledWith(3, "connecting");
  expect(onConnectionState).toHaveBeenLastCalledWith("connected");
  expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
    "desktop_bridge_relay_state_changed",
    expect.objectContaining({
      state: "connected",
      source: "subscription",
      recovered: true,
    }),
  );

  await bridge.stop();
});

it("requests a fresh bridge after a terminal transport disconnect", async () => {
  const onTerminated = jest.fn();
  const config = buildConfig({ onTerminated });
  const bridge = new DesktopSandboxBridge(config);
  await bridge.start();

  getClientHandler("disconnected")({ code: 3500, reason: "transport closed" });

  expect(onTerminated).toHaveBeenCalledWith("transport_disconnected");
  expect(bridge.getConnectionId()).toBeNull();
  expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
    "desktop_bridge_relay_state_changed",
    expect.objectContaining({ state: "disconnected", code: 3500 }),
  );
});

it("summarizes repeated relay errors on stop without changing recovery callbacks", async () => {
  const bridge = new DesktopSandboxBridge(buildConfig());
  await bridge.start();
  const error = getClientHandler("error");
  for (let i = 0; i < 20; i++)
    error({ type: "transport", error: { code: 2, message: "offline" } });
  const captures = jest.mocked(captureAuthenticatedEvent);
  expect(
    captures.mock.calls.filter(
      ([event]) => event === "desktop_bridge_relay_error",
    ),
  ).toHaveLength(1);
  await bridge.stop();
  const errors = captures.mock.calls.filter(
    ([event]) => event === "desktop_bridge_relay_error",
  );
  expect(errors).toHaveLength(2);
  expect(errors[1][1]).toMatchObject({
    telemetry_summary: true,
    telemetry_occurrences: 19,
  });
  expect(mockClient.disconnect).toHaveBeenCalled();
});

it("keeps one telemetry window across replacement bridges", async () => {
  jest.useFakeTimers();
  const relayTelemetry = new DesktopRelayTelemetry(captureAuthenticatedEvent);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      mockClient.on.mockClear();
      const bridge = new DesktopSandboxBridge({
        ...buildConfig(),
        relayTelemetry,
      });
      await bridge.start();
      getClientHandler("error")({
        type: "transport",
        error: { code: 2, message: "transport closed" },
      });
      await bridge.stop();
    }
    const errors = () =>
      jest
        .mocked(captureAuthenticatedEvent)
        .mock.calls.filter(([event]) => event === "desktop_bridge_relay_error");
    expect(errors()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(errors()).toHaveLength(2);
    expect(errors()[1][1]).toMatchObject({ telemetry_occurrences: 5 });
  } finally {
    relayTelemetry.flush();
    jest.useRealTimers();
  }
});

describe("terminal connection state", () => {
  it("notifies the owner when the server terminates the connection", async () => {
    const onTerminated = jest.fn();
    mockSubscription.unsubscribe.mockImplementationOnce(() => {
      throw new Error("already unsubscribed");
    });
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
    expect(mockSubscription.removeAllListeners).toHaveBeenCalledTimes(1);
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

  it("correlates unauthenticated token refresh without copying error text", async () => {
    const onTerminated = jest.fn();
    const error = Object.assign(
      new Error(
        "[CONVEX M(localSandbox:refreshCentrifugoTokenDesktop)] [Request ID: 0123456789abcdef] Server Error: private-token-canary",
      ),
      { data: { code: "UNAUTHORIZED" } },
    );
    const config = buildConfig({
      onTerminated,
      refreshCentrifugoTokenDesktop: jest.fn().mockRejectedValue(error),
    });
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    await expect(mockClientOptions?.getToken?.()).rejects.toBe(error);

    expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
    expect(bridge.getConnectionId()).toBeNull();
    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "sandbox_connection_terminated",
      expect.objectContaining({
        native_auth_diagnostic_version: 1,
        heartbeat_backpressure_version: 1,
        convex_function: "localSandbox:refreshCentrifugoTokenDesktop",
        convex_request_id: "0123456789abcdef",
      }),
    );
    expect(
      JSON.stringify(jest.mocked(captureAuthenticatedEvent).mock.calls),
    ).not.toContain("private-token-canary");
  });

  it.each([
    ["0123456789abcdef", "0123456789abcdef"],
    ["private-token-canary", undefined],
    ["0123456789abcdef0123456789abcdef", undefined],
  ])(
    "keeps heartbeat auth termination safe for request marker %s",
    async (marker, expectedId) => {
      jest.useFakeTimers();
      const onTerminated = jest.fn();
      const config = buildConfig({ onTerminated });
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        config.heartbeatDesktop.mockRejectedValueOnce(
          Object.assign(
            new Error(
              `[CONVEX M(localSandbox:heartbeatDesktop)] [Request ID: ${marker}] Server Error: private-token-canary`,
            ),
            { data: { code: "UNAUTHORIZED" } },
          ),
        );
        await jest.advanceTimersByTimeAsync(60_000);
        expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
        expect(config.heartbeatDesktop).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(config.heartbeatDesktop).toHaveBeenCalledTimes(2);
        const authCapture = jest
          .mocked(captureAuthenticatedEvent)
          .mock.calls.find(
            ([event, properties]) =>
              event === "desktop_bridge_relay_state_changed" &&
              properties?.reason === "heartbeat_unauthenticated",
          );
        expect(authCapture?.[1]).toMatchObject({
          native_auth_diagnostic_version: 1,
          heartbeat_backpressure_version: 1,
          convex_function: "localSandbox:heartbeatDesktop",
        });
        expect(authCapture?.[1]?.convex_request_id).toBe(expectedId);
        expect(
          JSON.stringify(jest.mocked(captureAuthenticatedEvent).mock.calls),
        ).not.toContain("private-token-canary");
      } finally {
        await bridge.stop();
        jest.useRealTimers();
      }
    },
  );
});

describe("native auth frontend state on authentication stops", () => {
  const UNAUTHORIZED = { data: { code: "UNAUTHORIZED" } };
  const FRONTEND_STATES = [
    "owner_absent",
    "owner_present_convex_loading",
    "owner_present_convex_authenticated",
    "owner_present_convex_unauthenticated",
    "unavailable",
  ];

  function authStopCapture(path: "heartbeat" | "token refresh") {
    return jest
      .mocked(captureAuthenticatedEvent)
      .mock.calls.find(([event, properties]) =>
        path === "heartbeat"
          ? event === "desktop_bridge_relay_state_changed" &&
            properties?.reason === "heartbeat_unauthenticated"
          : event === "sandbox_connection_terminated" &&
            properties?.reason === "unauthenticated",
      )?.[1];
  }

  function nativeAuthCaptures() {
    return jest
      .mocked(captureAuthenticatedEvent)
      .mock.calls.filter(
        ([, properties]) =>
          properties !== undefined &&
          ("native_auth_frontend_state" in properties ||
            "native_auth_request_frontend_state" in properties),
      );
  }

  // Leaves the callback pending so the test can change the foreground state
  // between invocation and the existing catch-time stop.
  async function invokePendingCallback(
    path: "heartbeat" | "token refresh",
    config: ReturnType<typeof buildConfig>,
  ) {
    let rejectCallback!: (reason: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectCallback = reject;
    });
    let tokenRequest: Promise<string> | undefined;
    if (path === "heartbeat") {
      config.heartbeatDesktop.mockReturnValueOnce(pending);
      await jest.advanceTimersByTimeAsync(LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS);
    } else {
      (config.refreshCentrifugoTokenDesktop as jest.Mock).mockReturnValueOnce(
        pending,
      );
      tokenRequest = mockClientOptions?.getToken?.();
      await jest.advanceTimersByTimeAsync(0);
    }
    return async (error: unknown) => {
      rejectCallback(error);
      if (tokenRequest) {
        // The original error, not a diagnostic failure, must reach Centrifuge.
        await expect(tokenRequest).rejects.toBe(error);
      } else {
        await jest.advanceTimersByTimeAsync(0);
      }
    };
  }

  describe.each(["heartbeat", "token refresh"] as const)("%s", (path) => {
    it.each(FRONTEND_STATES)(
      "reports %s from callback invocation separately from the stop",
      async (state) => {
        jest.useFakeTimers();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        let current = "owner_present_convex_authenticated";
        const readNativeAuthFrontendState = jest.fn(() => current);
        const onTerminated = jest.fn();
        const config = buildConfig({
          onTerminated,
          readNativeAuthFrontendState,
        });
        const bridge = new DesktopSandboxBridge(config);
        // Every value appears at invocation and, from the next case, at catch.
        const later =
          FRONTEND_STATES[
            (FRONTEND_STATES.indexOf(state) + 1) % FRONTEND_STATES.length
          ];
        try {
          await bridge.start();
          await jest.advanceTimersByTimeAsync(
            LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS,
          );
          // The foreground state can change after startup; neither field may
          // report a value captured when the bridge was created.
          current = state;
          const rejectCallback = await invokePendingCallback(path, config);
          current = later;
          await rejectCallback(UNAUTHORIZED);

          expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
          expect(bridge.getConnectionId()).toBeNull();
          expect(authStopCapture(path)).toMatchObject({
            native_auth_diagnostic_version: 1,
            native_auth_frontend_state: later,
            native_auth_request_state_version: 1,
            native_auth_request_frontend_state: state,
            convex_function:
              path === "heartbeat"
                ? "localSandbox:heartbeatDesktop"
                : "localSandbox:refreshCentrifugoTokenDesktop",
          });
          // Healthy callbacks before the stop attach no diagnostic state.
          expect(nativeAuthCaptures()).toHaveLength(1);
          const heartbeats = config.heartbeatDesktop.mock.calls.length;
          await jest.advanceTimersByTimeAsync(
            LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS * 4,
          );
          expect(config.heartbeatDesktop).toHaveBeenCalledTimes(heartbeats);
          expect(onTerminated).toHaveBeenCalledTimes(1);
        } finally {
          await bridge.stop();
          jest.useRealTimers();
          warn.mockRestore();
        }
      },
    );

    it.each([
      ["missing", undefined],
      [
        "throwing",
        () => {
          throw new Error("private-reader-canary");
        },
      ],
      ["private string", () => "private-account-canary@example.com"],
      ["near-miss string", () => "OWNER_ABSENT"],
      ["boxed string", () => new String("owner_absent")],
      ["object", () => ({ state: "owner_absent" })],
    ])(
      "reports unavailable for a %s reader without changing the stop",
      async (_label, readNativeAuthFrontendState) => {
        jest.useFakeTimers();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const onTerminated = jest.fn();
        const config = buildConfig({
          onTerminated,
          ...(readNativeAuthFrontendState && { readNativeAuthFrontendState }),
        });
        const bridge = new DesktopSandboxBridge(config);
        const error = Object.assign(
          new Error(
            "[CONVEX M(localSandbox:heartbeatDesktop)] [Request ID: 0123456789abcdef] Server Error",
          ),
          UNAUTHORIZED,
        );
        try {
          await bridge.start();
          const rejectCallback = await invokePendingCallback(path, config);
          await rejectCallback(error);

          expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
          expect(bridge.getConnectionId()).toBeNull();
          expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
          expect(authStopCapture(path)).toMatchObject({
            native_auth_frontend_state: "unavailable",
            native_auth_diagnostic_version: 1,
            native_auth_request_frontend_state: "unavailable",
            native_auth_request_state_version: 1,
          });
          const captured = JSON.stringify([
            jest.mocked(captureAuthenticatedEvent).mock.calls,
            warn.mock.calls,
          ]);
          expect(captured).not.toContain("canary");
          expect(captured).not.toContain("OWNER_ABSENT");
        } finally {
          await bridge.stop();
          jest.useRealTimers();
          warn.mockRestore();
        }
      },
    );
  });

  it("attributes a heartbeat follow-up auth failure to the token callback it invoked", async () => {
    jest.useFakeTimers();
    let current = "owner_present_convex_authenticated";
    const onTerminated = jest.fn();
    const config = buildConfig({
      onTerminated,
      readNativeAuthFrontendState: () => current,
    });
    const bridge = new DesktopSandboxBridge(config);
    let resolveHeartbeat!: (value: { success: boolean }) => void;
    let rejectToken!: (reason: unknown) => void;
    const error = Object.assign(
      new Error(
        "[CONVEX M(localSandbox:refreshCentrifugoTokenDesktop)] [Request ID: fedcba9876543210] Server Error: private-token-canary",
      ),
      UNAUTHORIZED,
    );
    try {
      await bridge.start();
      config.heartbeatDesktop.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveHeartbeat = resolve;
        }),
      );
      (config.refreshCentrifugoTokenDesktop as jest.Mock).mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectToken = reject;
        }),
      );
      await jest.advanceTimersByTimeAsync(LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS);
      expect(config.refreshCentrifugoTokenDesktop).not.toHaveBeenCalled();

      // The earlier heartbeat succeeded at the transport level; the follow-up
      // token callback is the one whose authentication failure stops the bridge.
      current = "owner_present_convex_loading";
      resolveHeartbeat({ success: false });
      await jest.advanceTimersByTimeAsync(0);
      expect(config.refreshCentrifugoTokenDesktop).toHaveBeenCalledWith({
        connectionId: "conn-123",
      });
      current = "owner_absent";
      rejectToken(error);
      await jest.advanceTimersByTimeAsync(0);

      expect(onTerminated).toHaveBeenCalledTimes(1);
      expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
      expect(bridge.getConnectionId()).toBeNull();
      expect(nativeAuthCaptures()).toEqual([
        [
          "desktop_bridge_relay_state_changed",
          expect.objectContaining({
            reason: "heartbeat_unauthenticated",
            native_auth_diagnostic_version: 1,
            convex_function: "localSandbox:refreshCentrifugoTokenDesktop",
            convex_request_id: "fedcba9876543210",
            native_auth_request_state_version: 1,
            native_auth_request_frontend_state: "owner_present_convex_loading",
            native_auth_frontend_state: "owner_absent",
          }),
        ],
      ]);
      expect(
        JSON.stringify(jest.mocked(captureAuthenticatedEvent).mock.calls),
      ).not.toContain("private-token-canary");
    } finally {
      resolveHeartbeat?.({ success: true });
      await bridge.stop();
      jest.useRealTimers();
    }
  });

  it("keeps each pending token callback's invocation state separate", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let current = "owner_present_convex_authenticated";
    const onTerminated = jest.fn();
    const config = buildConfig({
      onTerminated,
      readNativeAuthFrontendState: () => current,
    });
    const bridge = new DesktopSandboxBridge(config);
    let rejectFirst!: (reason: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    try {
      await bridge.start();
      (config.refreshCentrifugoTokenDesktop as jest.Mock)
        .mockReturnValueOnce(
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
        );
      const first = mockClientOptions?.getToken?.();
      current = "owner_present_convex_unauthenticated";
      const second = mockClientOptions?.getToken?.();
      current = "owner_absent";

      // A later invocation must not overwrite the failing call's snapshot.
      rejectFirst(UNAUTHORIZED);
      await expect(first).rejects.toBe(UNAUTHORIZED);
      resolveSecond({ ok: true, centrifugoToken: "late-token" });
      await expect(second).resolves.toBe("late-token");

      expect(onTerminated).toHaveBeenCalledTimes(1);
      expect(nativeAuthCaptures()).toEqual([
        [
          "sandbox_connection_terminated",
          expect.objectContaining({
            convex_function: "localSandbox:refreshCentrifugoTokenDesktop",
            native_auth_request_frontend_state:
              "owner_present_convex_authenticated",
            native_auth_frontend_state: "owner_absent",
          }),
        ],
      ]);
    } finally {
      await bridge.stop();
      jest.useRealTimers();
      warn.mockRestore();
    }
  });

  it("attaches no state outside authentication stops", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const readNativeAuthFrontendState = jest.fn(
      () => "owner_present_convex_authenticated",
    );
    const onTerminated = jest.fn();
    const config = buildConfig({ onTerminated, readNativeAuthFrontendState });
    const bridge = new DesktopSandboxBridge(config);
    try {
      await bridge.start();
      config.heartbeatDesktop.mockRejectedValueOnce(new Error("offline"));
      await jest.advanceTimersByTimeAsync(LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS);
      (config.refreshCentrifugoTokenDesktop as jest.Mock).mockRejectedValueOnce(
        new Error("offline"),
      );
      await expect(mockClientOptions?.getToken?.()).rejects.toThrow("offline");
      expect(bridge.getConnectionId()).toBe("conn-123");

      // A stale generation's authentication failure is not this bridge's stop.
      let rejectOld!: (reason: unknown) => void;
      config.heartbeatDesktop.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
      );
      await jest.advanceTimersByTimeAsync(LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS);
      await bridge.stop();
      await bridge.start();
      rejectOld(UNAUTHORIZED);
      await jest.advanceTimersByTimeAsync(0);
      expect(onTerminated).not.toHaveBeenCalled();

      config.heartbeatDesktop.mockResolvedValueOnce({ success: false });
      await jest.advanceTimersByTimeAsync(LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS);
      expect(onTerminated).toHaveBeenCalledWith("connection_inactive");

      await bridge.start();
      (config.refreshCentrifugoTokenDesktop as jest.Mock).mockResolvedValueOnce(
        {
          ok: false,
          terminated: true,
          reason: "ownership_mismatch",
          connectionId: "conn-123",
          clientVersion: null,
          status: null,
          disconnectReason: null,
          msSinceDisconnected: null,
          msSinceLastHeartbeat: null,
          msSinceCreated: null,
        },
      );
      await expect(mockClientOptions?.getToken?.()).rejects.toThrow(
        "Centrifugo refresh aborted: ownership_mismatch",
      );
      expect(onTerminated).toHaveBeenLastCalledWith("ownership_mismatch");

      const captures = jest.mocked(captureAuthenticatedEvent).mock.calls;
      expect(captures).toEqual(
        expect.arrayContaining([
          ["desktop_bridge_relay_error", expect.anything()],
          [
            "desktop_bridge_relay_state_changed",
            expect.objectContaining({
              reason: "heartbeat_connection_inactive",
            }),
          ],
          [
            "sandbox_connection_terminated",
            expect.objectContaining({ reason: "ownership_mismatch" }),
          ],
        ]),
      );
      // Invocation reads are retained only for an authentication stop; these
      // paths keep their existing events and gain no diagnostic properties.
      expect(captures.map(([event]) => event)).toEqual([
        "desktop_bridge_relay_error",
        "desktop_bridge_relay_state_changed",
        "desktop_bridge_relay_state_changed",
        "sandbox_connection_terminated",
      ]);
      expect(nativeAuthCaptures()).toEqual([]);
      expect(JSON.stringify(captures)).not.toContain("native_auth");
    } finally {
      await bridge.stop();
      jest.useRealTimers();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("heartbeat backpressure", () => {
  it.each(["success", "transient failure"])(
    "does not queue heartbeats while pending and resumes after %s",
    async (outcome) => {
      jest.useFakeTimers();
      let resolve!: (value: { success: boolean }) => void;
      let reject!: (reason: unknown) => void;
      const pending = new Promise<{ success: boolean }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const config = buildConfig();
      config.heartbeatDesktop.mockReturnValueOnce(pending);
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(config.heartbeatDesktop).toHaveBeenCalledTimes(1);
        if (outcome === "success") resolve({ success: true });
        else reject(new Error("Network request failed"));
        await jest.advanceTimersByTimeAsync(30_000);
        expect(config.heartbeatDesktop).toHaveBeenCalledTimes(2);
        expect(bridge.getConnectionId()).toBe("conn-123");
      } finally {
        resolve({ success: true });
        await bridge.stop();
        jest.useRealTimers();
      }
    },
  );

  it("stops after a pending heartbeat rejects authentication without draining a backlog", async () => {
    jest.useFakeTimers();
    let reject!: (reason: unknown) => void;
    const pending = new Promise<{ success: boolean }>((_resolve, rej) => {
      reject = rej;
    });
    const onTerminated = jest.fn();
    const config = buildConfig({ onTerminated });
    config.heartbeatDesktop.mockReturnValueOnce(pending);
    const bridge = new DesktopSandboxBridge(config);
    try {
      await bridge.start();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(config.heartbeatDesktop).toHaveBeenCalledTimes(1);
      reject({ data: { code: "UNAUTHORIZED" } });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
      expect(bridge.getConnectionId()).toBeNull();
      expect(config.heartbeatDesktop).toHaveBeenCalledTimes(1);
    } finally {
      reject({ data: { code: "UNAUTHORIZED" } });
      await bridge.stop();
      jest.useRealTimers();
    }
  });

  it.each(["success", "authentication failure"])(
    "ignores stale %s without unblocking the replacement heartbeat",
    async (outcome) => {
      jest.useFakeTimers();
      let resolveOld!: (value: { success: boolean }) => void;
      let rejectOld!: (reason: unknown) => void;
      let resolveNew!: (value: { success: boolean }) => void;
      const oldPending = new Promise<{ success: boolean }>((res, rej) => {
        resolveOld = res;
        rejectOld = rej;
      });
      const newPending = new Promise<{ success: boolean }>((res) => {
        resolveNew = res;
      });
      const onTerminated = jest.fn();
      const config = buildConfig({ onTerminated });
      config.heartbeatDesktop
        .mockReturnValueOnce(oldPending)
        .mockReturnValueOnce(newPending);
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        await bridge.stop();
        config.connectDesktop.mockResolvedValueOnce({
          connectionId: "conn-new",
          centrifugoToken: createTestJwt("user-456"),
          centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
        });
        await bridge.start();
        if (outcome === "success") resolveOld({ success: true });
        else rejectOld({ data: { code: "UNAUTHORIZED" } });
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(config.heartbeatDesktop).toHaveBeenCalledTimes(2);
        expect(onTerminated).not.toHaveBeenCalled();
        expect(bridge.getConnectionId()).toBe("conn-new");
        resolveNew({ success: true });
        await jest.advanceTimersByTimeAsync(30_000);
        expect(config.heartbeatDesktop).toHaveBeenLastCalledWith({
          connectionId: "conn-new",
        });
        expect(config.heartbeatDesktop).toHaveBeenCalledTimes(3);
      } finally {
        resolveOld({ success: true });
        resolveNew({ success: true });
        await bridge.stop();
        jest.useRealTimers();
      }
    },
  );
});

// ── targetConnectionId filtering ──────────────────────────────────────

describe("targetConnectionId filtering", () => {
  it("sends a server-authorized command to the native broker", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    mockUseAuthorizedNative = true;
    mockInvokeHandler = async (cmd) => {
      if (cmd !== "execute_authorized_stream_command") {
        throw new Error(`Unexpected native command: ${cmd}`);
      }
      capturedChannel?.onmessage?.({ type: "exit", exitCode: 0 });
    };
    const authorizationId = "a".repeat(64);
    getPublicationHandler()({
      data: {
        type: "command",
        commandId: "authorized-command",
        command: "printf safe",
        authorizationId,
        targetConnectionId: "conn-123",
      },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "execute_authorized_stream_command",
        expect.objectContaining({ authorizationId }),
      ),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_stream_command",
      expect.anything(),
    );
    await bridge.stop();
  });

  it("preserves PTY input order across authorization round trips", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    mockUseAuthorizedNative = true;
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observed: string[] = [];
    mockInvokeHandler = async (cmd, args) => {
      if (cmd !== "execute_authorized_pty_input")
        throw new Error(`Unexpected native command: ${cmd}`);
      const data = (args?.message as { data: string }).data;
      observed.push(data);
      if (data === "first") await firstPending;
    };

    const handler = getPublicationHandler();
    for (const data of ["first", "second"]) {
      handler({
        data: {
          type: "pty_input",
          sessionId: "ordered-pty",
          data,
          authorizationId: data === "first" ? "a".repeat(64) : "b".repeat(64),
          targetConnectionId: "conn-123",
        },
      });
    }
    await waitFor(() => expect(observed).toEqual(["first"]));
    releaseFirst();
    await waitFor(() => expect(observed).toEqual(["first", "second"]));
    await bridge.stop();
  });

  it("passes stdin as native IPC data without adding it to the command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    let invoked!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      invoked = resolve;
    });
    mockInvokeHandler = async (cmd) => {
      if (cmd === "execute_stream_command") {
        capturedChannel?.onmessage?.({ type: "exit", exitCode: 0 });
        invoked();
      }
    };
    getPublicationHandler()({
      data: {
        type: "command",
        commandId: "stdin-command",
        command: "node helper.js",
        stdin: "private-response",
        stdinEncoding: "utf8",
        targetConnectionId: "conn-123",
      },
    });
    await dispatched;
    expect(invoke).toHaveBeenCalledWith(
      "execute_stream_command",
      expect.objectContaining({
        command: "node helper.js",
        stdin: "private-response",
        stdinEncoding: "utf8",
      }),
    );
    await bridge.stop();
  });
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
  it("acknowledges cancellation when the command already exited", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();
    const invokeHandler = jest.fn().mockResolvedValue(undefined);
    mockInvokeHandler = invokeHandler;

    handler({
      data: {
        type: "command_cancel",
        commandId: "cmd-already-gone",
        targetConnectionId: "conn-123",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeHandler).not.toHaveBeenCalled();
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "command_cancel_result",
      commandId: "cmd-already-gone",
      canceled: true,
    });
  });

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
  it("recovers the reply after a real append succeeds without appending twice", async () => {
    jest.useFakeTimers();
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-ack-test-"));
    const file = path.join(dir, "out.txt");
    const bridge = new DesktopSandboxBridge(buildConfig());
    try {
      await bridge.start();
      const append = jest.fn(async () => {
        await fs.appendFile(file, "once\n");
        return { ok: true };
      });
      mockInvokeHandler = async (cmd) => {
        if (cmd === "desktop_file_request") return append();
        throw new Error("unexpected native command");
      };
      let loseReply = true;
      mockSubscription.publish.mockImplementation(async (message) => {
        if (message.type === "file_ok" && loseReply) {
          loseReply = false;
          throw { code: 1 };
        }
      });
      const start = {
        type: "file_append",
        requestId: "append-ack",
        targetConnectionId: "conn-123",
        operationChannel: true,
        fileResponseAck: true,
        path: file,
        content: "once\n",
      };
      getPublicationHandler()({ data: start });
      // The only mocked native boundary actually mutates a disposable file.
      await jest.advanceTimersByTimeAsync(0);
      await append.mock.results[0].value;
      await jest.advanceTimersByTimeAsync(0);
      getPublicationHandler()({ data: start });
      await jest.advanceTimersByTimeAsync(1000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(file, "utf8")).toBe("once\n");
      expect(
        mockSubscription.publish.mock.calls.filter(
          ([m]) => m.type === "file_ok",
        ),
      ).toHaveLength(2);
      expect(
        mockSubscription.publish.mock.calls.some(
          ([m]) => m.type === "file_error",
        ),
      ).toBe(false);
      for (const [event, handler] of mockSubscription.on.mock.calls) {
        if (event === "publication")
          handler({
            data: {
              type: "file_response_ack",
              requestId: "append-ack",
              targetConnectionId: "conn-123",
            },
          });
      }
      expect(mockClient.removeSubscription).toHaveBeenCalled();
    } finally {
      await bridge.stop();
      await fs.rm(dir, { recursive: true, force: true });
      mockSubscription.publish.mockReset().mockResolvedValue(undefined);
      jest.useRealTimers();
    }
  });

  it("discards a native reply that finishes after the bridge stops", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    let finish!: (value: unknown) => void;
    mockInvokeHandler = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    getPublicationHandler()({
      data: {
        type: "file_write",
        requestId: "late-file",
        targetConnectionId: "conn-123",
        path: "fixture",
        content: "once",
      },
    });
    await waitFor(() => expect(finish).toBeDefined());
    await bridge.stop();
    finish({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSubscription.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "late-file" }),
    );
  });

  it.each(["file_write", "file_append"])(
    "does not replay %s after an uncertain transport failure",
    async (type) => {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      const handler = getPublicationHandler();
      const invokeHandler = jest
        .fn()
        .mockRejectedValue(new TypeError("Load failed"));
      mockInvokeHandler = invokeHandler;
      global.fetch = jest.fn();
      handler({
        data: {
          type,
          requestId: "file-uncertain",
          targetConnectionId: "conn-123",
          path: "/private/user-path",
          content: "private-content",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(invokeHandler).toHaveBeenCalledTimes(1);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockSubscription.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_error",
          requestId: "file-uncertain",
          message: expect.stringContaining("verify the file before retrying"),
        }),
      );
      expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
        "desktop_file_bridge_transport_failed",
        {
          connectionId: "conn-123",
          operation: type,
          transport: "native_ipc",
        },
      );
      const telemetry = JSON.stringify(
        (captureAuthenticatedEvent as jest.Mock).mock.calls,
      );
      expect(telemetry).not.toContain("private-content");
      expect(telemetry).not.toContain("/private/user-path");
      await bridge.stop();
    },
  );
  it("handles file_read through native IPC without loopback HTTP", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        return {
          path: "C:\\repo\\app.ts",
          sizeBytes: 12,
          totalLines: 1,
          content: "hello world\n",
          startLine: 1,
          truncated: false,
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn();

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

    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).toHaveBeenCalledWith("desktop_file_request", {
      request: {
        path: "C:\\repo\\app.ts",
        range_start: 1,
        range_end: 1,
        max_full_bytes: 1024,
        max_result_bytes: 1024,
        type: "file_read",
      },
    });
    expect(global.fetch).not.toHaveBeenCalled();
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

  it("answers a same-connection file probe after startup timed out without re-registering", async () => {
    jest.useFakeTimers();
    const original = mockInvokeHandler;
    mockInvokeHandler = (cmd, args) =>
      cmd === "desktop_file_request"
        ? new Promise(() => {})
        : original(cmd, args);
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    try {
      const starting = bridge.start();
      await jest.advanceTimersByTimeAsync(3000);
      await starting;
      expect(config.connectDesktop).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: expect.objectContaining({ files: false }),
        }),
      );
      mockInvokeHandler = original;
      getPublicationHandler()({
        data: {
          type: "file_stat",
          requestId: "recovery-probe",
          path: ".",
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockSubscription.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_stat_result",
          requestId: "recovery-probe",
          kind: "not_file",
        }),
      );
      expect(config.connectDesktop).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
      jest.useRealTimers();
    }
  });

  it("handles file_stat through the same structured native bridge", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        return {
          kind: "file",
          path: "C:\\repo\\app.ts",
          sizeBytes: 12,
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    handler({
      data: {
        type: "file_stat",
        requestId: "file-stat-1",
        path: "C:\\repo\\app.ts",
        targetConnectionId: "conn-123",
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_stat_result",
      requestId: "file-stat-1",
      kind: "file",
      path: "C:\\repo\\app.ts",
      sizeBytes: 12,
    });
  });

  it("fragments oversized file_read responses below the relay limit", async () => {
    mockSubscription.publish.mockResolvedValue(undefined);
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();
    const content = "large file line\n".repeat(6_000);

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        return {
          path: "C:\\repo\\large.txt",
          sizeBytes: content.length,
          totalLines: 6_000,
          content,
          startLine: 1,
          truncated: false,
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn();

    handler({
      data: {
        type: "file_read",
        requestId: "file-req-large",
        path: "C:\\repo\\large.txt",
        maxFullBytes: 1024 * 1024,
        maxResultBytes: 1024 * 1024,
        targetConnectionId: "conn-123",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fragments = mockSubscription.publish.mock.calls
      .map(([message]: [unknown]) => message)
      .filter(isCentrifugoTransportFragment);
    expect(fragments.length).toBeGreaterThan(1);
    expect(
      fragments.every(
        (fragment) =>
          new TextEncoder().encode(JSON.stringify(fragment)).byteLength <
          64 * 1024,
      ),
    ).toBe(true);

    const reassembler = new CentrifugoMessageReassembler();
    let reassembled: unknown = null;
    for (const fragment of fragments) {
      reassembled = reassembler.accept(fragment) ?? reassembled;
    }
    expect(reassembled).toEqual({
      type: "file_read_result",
      requestId: "file-req-large",
      path: "C:\\repo\\large.txt",
      sizeBytes: content.length,
      totalLines: 6_000,
      content,
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
      if (cmd === "desktop_file_request") {
        return { ok: true };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn();

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
    expect(invoke).toHaveBeenCalledWith("desktop_file_request", {
      request: {
        path: "C:\\repo\\app.ts",
        content: "updated",
        is_base64: false,
        allowed_root: undefined,
        type: "file_write",
      },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_ok",
      requestId: "file-req-2",
    });
  });

  it("forwards the allowed project root to native IPC", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        return { ok: true };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

    handler({
      data: {
        type: "file_write",
        requestId: "file-req-root",
        path: "C:\\repo\\app.ts",
        content: "updated",
        allowedRoot: "C:\\repo",
        targetConnectionId: "conn-123",
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).toHaveBeenCalledWith("desktop_file_request", {
      request: {
        path: "C:\\repo\\app.ts",
        content: "updated",
        is_base64: false,
        allowed_root: "C:\\repo",
        type: "file_write",
      },
    });
  });

  it("passes base64 append requests through native IPC", async () => {
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();

    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        return { ok: true };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };

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

    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).toHaveBeenCalledWith("desktop_file_request", {
      request: {
        path: "C:\\repo\\asset.bin",
        content: "AAEC",
        is_base64: true,
        allowed_root: undefined,
        type: "file_append",
      },
    });
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_ok",
      requestId: "file-req-3",
    });
  });

  it("falls back to the loopback bridge for older desktop binaries", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        throw new Error("Command desktop_file_request not found");
      }
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
        requestId: "file-legacy-1",
        path: "C:\\repo\\legacy.txt",
        content: "compatible",
        targetConnectionId: "conn-123",
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/files/write",
      expect.objectContaining({
        body: JSON.stringify({
          path: "C:\\repo\\legacy.txt",
          content: "compatible",
          is_base64: false,
        }),
      }),
    );
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_ok",
      requestId: "file-legacy-1",
    });
  });

  it("does not bypass a native ACL denial through loopback HTTP", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        throw new Error("Command desktop_file_request not allowed by ACL");
      }
      if (cmd === "get_cmd_server_info") {
        return { port: 49152, token: "file-token" };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    const publicationPublished = new Promise<void>((resolve) => {
      mockSubscription.publish.mockImplementationOnce(async () => {
        resolve();
      });
    });

    handler({
      data: {
        type: "file_write",
        requestId: "file-acl-fallback-1",
        path: "C:\\repo\\transcript.json",
        content: "compatible",
        targetConnectionId: "conn-123",
      },
    });
    await publicationPublished;

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSubscription.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "file_error",
        requestId: "file-acl-fallback-1",
        fileFailure: "native_ipc_denied",
        message: expect.stringContaining("Update and fully reopen"),
      }),
    );
  });

  it.each(["file_write", "file_append"])(
    "refuses %s scoped writes on legacy handlers that may ignore allowedRoot",
    async (type) => {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      mockInvokeHandler = async () => {
        throw new Error("Command desktop_file_request not found");
      };
      global.fetch = jest.fn();
      getPublicationHandler()({
        data: {
          type,
          requestId: "scoped-legacy",
          path: "/project/output.txt",
          allowedRoot: "/project",
          content: "private",
          targetConnectionId: "conn-123",
        },
      });
      await waitFor(() =>
        expect(mockSubscription.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "file_error",
            requestId: "scoped-legacy",
            fileFailure: "scoped_write_requires_native",
          }),
        ),
      );
      expect(global.fetch).not.toHaveBeenCalled();
      await bridge.stop();
    },
  );

  it("does not interpret a filesystem path as a missing IPC command", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    mockInvokeHandler = async () => {
      throw new Error("Open error: /private/desktop_file_request/not found");
    };
    global.fetch = jest.fn();
    getPublicationHandler()({
      data: {
        type: "file_stat",
        requestId: "path-error",
        path: "/private",
        targetConnectionId: "conn-123",
      },
    });
    await waitFor(() =>
      expect(mockSubscription.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_error",
          requestId: "path-error",
          fileFailure: "filesystem",
        }),
      ),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("does not fall back when native IPC reports a real file error", async () => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const handler = getPublicationHandler();

    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request") {
        throw new Error("Write error: Permission denied");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    };
    global.fetch = jest.fn();

    handler({
      data: {
        type: "file_write",
        requestId: "file-denied-1",
        path: "/root/denied.txt",
        content: "nope",
        targetConnectionId: "conn-123",
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSubscription.publish).toHaveBeenCalledWith({
      type: "file_error",
      requestId: "file-denied-1",
      message: "Write error: Permission denied",
      fileFailure: "filesystem",
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
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
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
      {
        type: "stdout",
        commandId: "cmd-fwd",
        data: "hello world",
        sequence: 0,
      },
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
      { type: "exit", commandId: "cmd-fwd", exitCode: -1, sequence: 0 },
    ]);
  });

  it("publishes correct exitCode when provided", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "exit", exitCode: 42 },
    ]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: 42, sequence: 0 },
    ]);
  });

  it("forwards exitCode 0 for successful commands", async () => {
    const calls = await startBridgeAndForwardChunks([
      { type: "exit", exitCode: 0 },
    ]);

    expect(calls).toContainEqual([
      { type: "exit", commandId: "cmd-fwd", exitCode: 0, sequence: 0 },
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

  it("drops a queued stream chunk when the bridge stops before publishing it", async () => {
    let releaseFirstPublish!: () => void;
    const firstPublishBlocked = new Promise<void>((resolve) => {
      releaseFirstPublish = resolve;
    });
    let firstPublishStarted!: () => void;
    const firstPublishStartedPromise = new Promise<void>((resolve) => {
      firstPublishStarted = resolve;
    });
    mockSubscription.publish.mockImplementationOnce(async () => {
      firstPublishStarted();
      await firstPublishBlocked;
    });

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      const handler = getPublicationHandler();

      mockInvokeHandler = async () => undefined;
      handler({
        data: {
          type: "command",
          commandId: "cmd-queued-stop",
          command: "test",
          targetConnectionId: "conn-123",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const firstChunk = capturedChannel!.onmessage!({
        type: "stdout",
        data: "first",
      }) as unknown as Promise<void>;
      await firstPublishStartedPromise;
      const queuedChunk = capturedChannel!.onmessage!({
        type: "stderr",
        data: "queued",
      }) as unknown as Promise<void>;

      await bridge.stop();
      releaseFirstPublish();

      await expect(Promise.all([firstChunk, queuedChunk])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(mockSubscription.publish).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalledWith(
        "[DesktopSandboxBridge] Failed to publish result:",
        expect.anything(),
      );
    } finally {
      releaseFirstPublish();
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      label: "structured connection closed",
      publishError: { code: 11, message: "connection closed" },
      directForwardFailure: undefined,
      reason: "connection_closed",
    },
    {
      label: "JSON-encoded Error timeout",
      publishError: new Error(JSON.stringify({ code: 1, message: "timeout" })),
      directForwardFailure: undefined,
      reason: "timeout",
    },
    {
      label: "plain connection closed message",
      publishError: undefined,
      directForwardFailure: "connection closed",
      reason: "connection_closed",
    },
  ])(
    "exhausts retries for $label and reports the command once",
    async ({ publishError, directForwardFailure, reason }) => {
      jest.useFakeTimers();
      let finishCommand!: () => void;
      const commandFinished = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      mockInvokeHandler = async (cmd: string) => {
        if (cmd === "desktop_file_request")
          return { kind: "not_file", path: "." };
        if (cmd === "execute_stream_command") {
          await commandFinished;
          return undefined;
        }
        return undefined;
      };
      if (publishError !== undefined) {
        mockSubscription.publish.mockRejectedValue(publishError);
      }
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let forwardChunkSpy: jest.SpyInstance | null = null;

      try {
        const bridge = new DesktopSandboxBridge(buildConfig());
        await bridge.start();
        if (directForwardFailure !== undefined) {
          forwardChunkSpy = jest
            .spyOn(
              bridge as unknown as {
                forwardChunk: (
                  commandId: string,
                  chunk: unknown,
                ) => Promise<void>;
              },
              "forwardChunk",
            )
            .mockRejectedValue(directForwardFailure);
        }
        const handler = getPublicationHandler();
        handler({
          data: {
            type: "command",
            commandId: "cmd-publish-failure",
            command: "test",
            chatId: "chat-1",
            triggerRunId: "run-1",
            targetConnectionId: "conn-123",
          },
        });
        await jest.advanceTimersByTimeAsync(0);

        const firstChunk = capturedChannel!.onmessage!({
          type: "stdout",
          data: "first",
        }) as unknown as Promise<void>;
        await jest.advanceTimersByTimeAsync(250);
        await jest.advanceTimersByTimeAsync(500);
        await expect(firstChunk).resolves.toBeUndefined();
        expect(captureAuthenticatedEvent).toHaveBeenCalledTimes(2);
        expect(captureAuthenticatedEvent).toHaveBeenNthCalledWith(
          1,
          "desktop_stream_publish_failed",
          {
            connectionId: "conn-123",
            commandId: "cmd-publish-failure",
            chatId: "chat-1",
            triggerRunId: "run-1",
            chunkType: "stdout",
            reason,
            attempt: 1,
            maxAttempts: 3,
          },
        );
        expect(captureAuthenticatedEvent).toHaveBeenNthCalledWith(
          2,
          "desktop_stream_publish_recovery_exhausted",
          {
            connectionId: "conn-123",
            commandId: "cmd-publish-failure",
            chatId: "chat-1",
            triggerRunId: "run-1",
            chunkType: "stdout",
            reason,
            attempts: 3,
            exhaustionReason: "attempts",
            recoveryLatencyMs: 750,
          },
        );

        const structuredLog = warnSpy.mock.calls
          .map(([value]) => {
            try {
              return JSON.parse(String(value)) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .find((value) => value?.event === "desktop_stream_publish_failed");
        expect(structuredLog).toEqual(
          expect.objectContaining({
            timestamp: expect.any(String),
            level: "warn",
            event: "desktop_stream_publish_failed",
            service: "desktop_bridge",
            environment: "test",
            request_id: "cmd-publish-failure",
            connection_id: "conn-123",
            command_id: "cmd-publish-failure",
            chat_id: "chat-1",
            trigger_run_id: "run-1",
            chunk_type: "stdout",
            reason,
            attempt: 1,
            max_attempts: 3,
          }),
        );
      } finally {
        finishCommand();
        forwardChunkSpy?.mockRestore();
        mockSubscription.publish.mockResolvedValue(undefined);
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  it("recovers exhausted output in order before publishing the command exit", async () => {
    jest.useFakeTimers();
    let finishCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    let executions = 0;
    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
      if (cmd === "execute_stream_command") {
        executions += 1;
        await commandFinished;
      }
      return undefined;
    };
    const publishError = { code: 11, message: "connection closed" };
    mockSubscription.publish
      .mockRejectedValueOnce(publishError)
      .mockRejectedValueOnce(publishError)
      .mockRejectedValueOnce(publishError)
      .mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    const bridge = new DesktopSandboxBridge(buildConfig());

    try {
      await bridge.start();
      getPublicationHandler()({
        data: {
          type: "command",
          commandId: "cmd-sequence-after-exhaustion",
          command: "test",
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      const firstChunk = capturedChannel!.onmessage!({
        type: "stdout",
        data: "retained",
      }) as unknown as Promise<void>;
      await jest.advanceTimersByTimeAsync(750);
      await expect(firstChunk).resolves.toBeUndefined();
      await capturedChannel!.onmessage!({ type: "stderr", data: "later" });
      await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });

      // Later output must not create a sequence gap while the first chunk is missing.
      expect(mockSubscription.publish).toHaveBeenCalledTimes(3);
      finishCommand();
      await jest.advanceTimersByTimeAsync(0);
      expect(
        mockSubscription.publish.mock.calls
          .slice(3)
          .map(([message]) => message),
      ).toEqual([
        {
          type: "stdout",
          commandId: "cmd-sequence-after-exhaustion",
          data: "retained",
          sequence: 0,
        },
        {
          type: "stderr",
          commandId: "cmd-sequence-after-exhaustion",
          data: "later",
          sequence: 1,
        },
        {
          type: "exit",
          commandId: "cmd-sequence-after-exhaustion",
          exitCode: 0,
          sequence: 2,
        },
      ]);
      expect(executions).toBe(1);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
        "desktop_stream_command_settled",
        expect.objectContaining({
          outcome: "recovered",
          observedChunks: 3,
          publishedChunks: 3,
          exhaustedChunks: 0,
          terminalChunkPublished: true,
          sequenceComplete: true,
        }),
      );
    } finally {
      finishCommand();
      await bridge.stop();
      mockSubscription.publish.mockResolvedValue(undefined);
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(["finished", "running", "late callbacks"])(
    "recovers output after a prolonged outage while native command is %s",
    async (nativeState) => {
      jest.useFakeTimers();
      let finishCommand!: () => void;
      const done = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      let executions = 0;
      mockInvokeHandler = async (cmd) => {
        if (cmd === "desktop_file_request")
          return { kind: "not_file", path: "." };
        if (cmd === "execute_stream_command") {
          executions++;
          await done;
        }
        return undefined;
      };
      let online = false;
      const delivered: unknown[] = [];
      mockSubscription.publish.mockImplementation(async (message) => {
        if (!online) throw { code: 1, message: "timeout" };
        delivered.push(message);
      });
      const onTerminated = jest.fn();
      const bridge = new DesktopSandboxBridge(buildConfig({ onTerminated }));
      const spies = ["warn", "error", "info"].map((method) =>
        jest.spyOn(console, method as "warn").mockImplementation(() => {}),
      );
      try {
        await bridge.start();
        getPublicationHandler()({
          data: {
            type: "command",
            commandId: "cmd-long-outage",
            command: "test",
            timeout: 30_000,
            targetConnectionId: "conn-123",
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        getSubscriptionHandler("subscribing")({
          code: 1,
          reason: "transport closed",
        });
        if (nativeState === "late callbacks") {
          finishCommand();
          await jest.advanceTimersByTimeAsync(0);
        }
        capturedChannel!.onmessage!({ type: "stdout", data: "before" });
        await jest.advanceTimersByTimeAsync(750);
        capturedChannel!.onmessage!({ type: "stderr", data: "after" });
        if (nativeState !== "running") {
          capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
          finishCommand();
        }
        await jest.advanceTimersByTimeAsync(40_000);
        expect(onTerminated).not.toHaveBeenCalled();
        expect(delivered).toEqual([]);
        online = true;
        getSubscriptionHandler("subscribed")({
          recovered: true,
          wasRecovering: true,
        });
        await jest.advanceTimersByTimeAsync(2_000);
        expect(delivered.slice(0, 2)).toEqual([
          {
            type: "stdout",
            commandId: "cmd-long-outage",
            data: "before",
            sequence: 0,
          },
          {
            type: "stderr",
            commandId: "cmd-long-outage",
            data: "after",
            sequence: 1,
          },
        ]);
        if (nativeState === "running") {
          capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
          finishCommand();
          await jest.advanceTimersByTimeAsync(0);
        }
        expect(delivered).toHaveLength(3);
        expect(delivered[2]).toEqual({
          type: "exit",
          commandId: "cmd-long-outage",
          exitCode: 0,
          sequence: 2,
        });
        expect(executions).toBe(1);
        expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
          "desktop_stream_command_settled",
          expect.objectContaining({
            sequenceComplete: true,
            publishedChunks: 3,
          }),
        );
      } finally {
        finishCommand();
        await bridge.stop();
        await jest.advanceTimersByTimeAsync(5_000);
        spies.forEach((spy) => spy.mockRestore());
        jest.useRealTimers();
      }
    },
  );

  it.each([true, false])(
    "waits for a late terminal outcome after stdout recovers (terminal arrives: %s)",
    async (terminalArrives) => {
      jest.useFakeTimers();
      let finishCommand!: () => void;
      const done = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      mockInvokeHandler = async (cmd) => {
        if (cmd === "desktop_file_request")
          return { kind: "not_file", path: "." };
        if (cmd === "execute_stream_command") await done;
        return undefined;
      };
      let fail = true;
      mockSubscription.publish.mockImplementation(async () => {
        if (fail) throw { code: 1, message: "timeout" };
      });
      const bridge = new DesktopSandboxBridge(buildConfig());
      const spies = ["warn", "error", "info"].map((method) =>
        jest.spyOn(console, method as "warn").mockImplementation(() => {}),
      );
      try {
        await bridge.start();
        getPublicationHandler()({
          data: {
            type: "command",
            commandId: "cmd-late-terminal",
            command: "test",
            timeout: 30_000,
            targetConnectionId: "conn-123",
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        capturedChannel!.onmessage!({ type: "stdout", data: "retained" });
        await jest.advanceTimersByTimeAsync(750);
        fail = false;
        await jest.advanceTimersByTimeAsync(2_000);
        finishCommand();
        await jest.advanceTimersByTimeAsync(0);
        expect(captureAuthenticatedEvent).not.toHaveBeenCalledWith(
          "desktop_stream_command_settled",
          expect.anything(),
        );
        fail = true;
        if (terminalArrives)
          capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
        await jest.advanceTimersByTimeAsync(65_000);
        const settlements = (
          captureAuthenticatedEvent as jest.Mock
        ).mock.calls.filter(
          ([event]) => event === "desktop_stream_command_settled",
        );
        expect(settlements).toHaveLength(1);
        expect(settlements[0][1]).toMatchObject({
          outcome: terminalArrives ? "incomplete" : "interrupted",
          terminalChunkPublished: false,
        });
      } finally {
        finishCommand();
        await bridge.stop();
        await jest.advanceTimersByTimeAsync(5_000);
        spies.forEach((spy) => spy.mockRestore());
        jest.useRealTimers();
      }
    },
  );

  it.each(["initial", "settlement"])(
    "does not publish an old command after restart during its %s retry wait",
    async (phase) => {
      jest.useFakeTimers();
      let finishCommand!: () => void;
      const done = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      mockInvokeHandler = async (cmd) => {
        if (cmd === "desktop_file_request")
          return { kind: "not_file", path: "." };
        if (cmd === "execute_stream_command") await done;
        return undefined;
      };
      const error = { code: 1, message: "timeout" };
      mockSubscription.publish.mockRejectedValue(error);
      const spies = ["warn", "error", "info"].map((method) =>
        jest.spyOn(console, method as "warn").mockImplementation(() => {}),
      );
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        getPublicationHandler()({
          data: {
            type: "command",
            commandId: "cmd-old-connection",
            command: "test",
            targetConnectionId: "conn-123",
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        capturedChannel!.onmessage!({ type: "stdout", data: "retained" });
        await jest.advanceTimersByTimeAsync(phase === "settlement" ? 750 : 0);
        if (phase === "settlement") {
          await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
          finishCommand();
          await jest.advanceTimersByTimeAsync(0);
        }
        const attempts = phase === "settlement" ? 4 : 1;
        expect(mockSubscription.publish).toHaveBeenCalledTimes(attempts);
        await bridge.stop();
        config.connectDesktop.mockResolvedValue({
          connectionId: "new-connection",
          centrifugoToken: createTestJwt("user-456"),
          centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
        });
        mockSubscription.publish.mockResolvedValue(undefined);
        await bridge.start();
        await jest.advanceTimersByTimeAsync(1_000);
        finishCommand();
        await jest.advanceTimersByTimeAsync(0);
        expect(bridge.getConnectionId()).toBe("new-connection");
        expect(mockSubscription.publish).toHaveBeenCalledTimes(attempts);
        expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
          "desktop_stream_command_settled",
          expect.objectContaining({
            terminalChunkPublished: false,
            sequenceComplete: false,
          }),
        );
      } finally {
        finishCommand();
        await bridge.stop();
        mockSubscription.publish.mockResolvedValue(undefined);
        spies.forEach((spy) => spy.mockRestore());
        jest.useRealTimers();
      }
    },
  );

  it("recovers retained output on its isolated operation channel", async () => {
    jest.useFakeTimers();
    let finishCommand!: () => void;
    const done = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    let executions = 0;
    mockInvokeHandler = async (cmd) => {
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
      if (cmd === "execute_stream_command") {
        executions += 1;
        await done;
      }
      return undefined;
    };
    const bridge = new DesktopSandboxBridge(buildConfig());
    const spies = ["warn", "error", "info"].map((method) =>
      jest.spyOn(console, method as "warn").mockImplementation(() => {}),
    );
    try {
      await bridge.start();
      const reply = {
        ...mockSubscription,
        on: jest.fn(),
        publish: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn(),
        removeAllListeners: jest.fn(),
      };
      mockClient.newSubscription.mockReturnValueOnce(reply);
      getPublicationHandler()({
        data: {
          type: "command",
          commandId: "cmd-isolated-recovery",
          command: "test",
          targetConnectionId: "conn-123",
          operationChannel: true,
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      const error = { code: 1, message: "timeout" };
      reply.publish
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error);
      capturedChannel!.onmessage!({ type: "stdout", data: "retained" });
      await jest.advanceTimersByTimeAsync(750);
      await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
      finishCommand();
      await jest.advanceTimersByTimeAsync(0);
      expect(
        reply.publish.mock.calls.slice(4).map(([message]) => message),
      ).toEqual([
        {
          type: "stdout",
          commandId: "cmd-isolated-recovery",
          data: "retained",
          sequence: 0,
        },
        {
          type: "exit",
          commandId: "cmd-isolated-recovery",
          exitCode: 0,
          sequence: 1,
        },
      ]);
      expect(executions).toBe(1);
      expect(mockSubscription.publish).not.toHaveBeenCalled();
      expect(reply.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      finishCommand();
      await bridge.stop();
      spies.forEach((spy) => spy.mockRestore());
      jest.useRealTimers();
    }
  });

  it.each(["absent", "lookup failure"])(
    "retains recovered output while receiver presence is %s",
    async (presenceState) => {
      jest.useFakeTimers();
      let finishCommand!: () => void;
      const done = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      let executions = 0;
      mockInvokeHandler = async (cmd) => {
        if (cmd === "desktop_file_request")
          return { kind: "not_file", path: "." };
        if (cmd === "execute_stream_command") {
          executions += 1;
          await done;
        }
        return undefined;
      };
      const bridge = new DesktopSandboxBridge(buildConfig());
      const spies = ["warn", "error", "info"].map((method) =>
        jest.spyOn(console, method as "warn").mockImplementation(() => {}),
      );
      try {
        await bridge.start();
        const reply = {
          ...mockSubscription,
          on: jest.fn(),
          publish: jest.fn().mockResolvedValue(undefined),
          presence: jest.fn().mockResolvedValue({
            clients: { desktop: { connInfo: { connectionId: "conn-123" } } },
          }),
          unsubscribe: jest.fn(),
          removeAllListeners: jest.fn(),
        };
        if (presenceState === "lookup failure")
          reply.presence.mockRejectedValue(new Error("presence unavailable"));
        mockClient.newSubscription.mockReturnValueOnce(reply);
        getPublicationHandler()({
          data: {
            type: "command",
            commandId: "receiver-late",
            command: "test",
            targetConnectionId: "conn-123",
            operationChannel: true,
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        capturedChannel!.onmessage!({ type: "stdout", data: "before" });
        await jest.advanceTimersByTimeAsync(0);
        getClientHandler("connected")({ transport: "websocket" });
        capturedChannel!.onmessage!({ type: "stdout", data: "after" });
        capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
        finishCommand();
        await jest.advanceTimersByTimeAsync(5_000);
        // A successful broker publish would silently drop these while only the
        // Desktop subscription is present (the relay stores no history).
        expect(reply.publish.mock.calls.map(([m]) => m.type)).toEqual([
          "operation_ready",
          "stdout",
        ]);
        expect(reply.unsubscribe).not.toHaveBeenCalled();
        reply.presence.mockResolvedValue({
          clients: {
            desktop: { connInfo: { connectionId: "conn-123" } },
            worker: { user: "user-456" },
          },
        });
        await jest.advanceTimersByTimeAsync(2_000);
        expect(reply.publish.mock.calls.map(([m]) => m.type)).toEqual([
          "operation_ready",
          "stdout",
          "stdout",
          "exit",
        ]);
        expect(
          reply.publish.mock.calls.slice(2).map(([m]) => m.sequence),
        ).toEqual([1, 2]);
        expect(reply.unsubscribe).toHaveBeenCalledTimes(1);
        expect(executions).toBe(1);
      } finally {
        finishCommand();
        await bridge.stop();
        spies.forEach((spy) => spy.mockRestore());
        jest.useRealTimers();
      }
    },
  );

  it.each(["unavailable", "expired", "stopped", "byte limit", "chunk limit"])(
    "keeps incomplete delivery truthful when recovery is %s",
    async (failure) => {
      jest.useFakeTimers();
      let finishCommand!: () => void;
      const done = new Promise<void>((resolve) => {
        finishCommand = resolve;
      });
      let executions = 0;
      mockInvokeHandler = async (cmd) => {
        if (cmd === "desktop_file_request")
          return { kind: "not_file", path: "." };
        if (cmd === "execute_stream_command") {
          executions += 1;
          await done;
        }
        return undefined;
      };
      const error = { code: 1, message: "timeout" };
      mockSubscription.publish
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue(undefined);
      const spies = ["warn", "error", "info"].map((method) =>
        jest.spyOn(console, method as "warn").mockImplementation(() => {}),
      );
      const bridge = new DesktopSandboxBridge(buildConfig());
      try {
        await bridge.start();
        getPublicationHandler()({
          data: {
            type: "command",
            commandId: "cmd-bounded",
            command: "test",
            timeout: 1_000,
            targetConnectionId: "conn-123",
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        capturedChannel!.onmessage!({ type: "stdout", data: "retained" });
        await jest.advanceTimersByTimeAsync(750);
        if (failure === "byte limit")
          await capturedChannel!.onmessage!({
            type: "stdout",
            data: "😀".repeat(66_000),
          });
        if (failure === "chunk limit") {
          for (let i = 0; i < 256; i++)
            await capturedChannel!.onmessage!({ type: "stdout", data: "x" });
        }
        await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
        if (failure === "unavailable" || failure === "expired")
          mockSubscription.publish.mockRejectedValue(error);
        if (failure === "expired") await jest.advanceTimersByTimeAsync(40_000);
        if (failure === "stopped") await bridge.stop();
        finishCommand();
        // Recovery now continues through the bounded delivery grace period.
        await jest.advanceTimersByTimeAsync(40_000);
        expect(executions).toBe(1);
        expect(
          mockSubscription.publish.mock.calls.some(
            ([message]) => message.type === "exit",
          ),
        ).toBe(false);
        expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
          "desktop_stream_command_settled",
          expect.objectContaining({
            outcome: "incomplete",
            terminalChunkPublished: false,
            sequenceComplete: false,
          }),
        );
        if (failure.endsWith("limit")) {
          expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
            "desktop_stream_buffer_limit_exceeded",
            expect.objectContaining({
              pendingBytes: expect.any(Number),
              pendingChunks: expect.any(Number),
            }),
          );
        }
      } finally {
        finishCommand();
        await bridge.stop();
        mockSubscription.publish.mockResolvedValue(undefined);
        spies.forEach((spy) => spy.mockRestore());
        jest.useRealTimers();
      }
    },
  );

  it("does not apply the recovery buffer limit to healthy large output", async () => {
    let finishCommand!: () => void;
    const done = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    mockInvokeHandler = async (cmd) => {
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
      if (cmd === "execute_stream_command") await done;
      return undefined;
    };
    mockSubscription.publish.mockResolvedValue(undefined);
    const bridge = new DesktopSandboxBridge(buildConfig());
    try {
      await bridge.start();
      getPublicationHandler()({
        data: {
          type: "command",
          commandId: "cmd-healthy-large",
          command: "test",
          targetConnectionId: "conn-123",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let i = 0; i < 300; i++)
        await capturedChannel!.onmessage!({
          type: "stdout",
          data: "x".repeat(1024),
        });
      await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
      finishCommand();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockSubscription.publish).toHaveBeenCalledTimes(301);
      expect(mockSubscription.publish).toHaveBeenLastCalledWith({
        type: "exit",
        commandId: "cmd-healthy-large",
        sequence: 300,
        exitCode: 0,
      });
      expect(captureAuthenticatedEvent).not.toHaveBeenCalledWith(
        "desktop_stream_buffer_limit_exceeded",
        expect.anything(),
      );
    } finally {
      finishCommand();
      await bridge.stop();
    }
  });

  it("retries a transient publish after reconnect and reports recovery", async () => {
    jest.useFakeTimers();
    let finishCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
      if (cmd === "execute_stream_command") {
        await commandFinished;
      }
      return undefined;
    };
    mockSubscription.publish
      .mockRejectedValueOnce({ code: 11, message: "connection closed" })
      .mockResolvedValue(undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});

    try {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      const handler = getPublicationHandler();
      handler({
        data: {
          type: "command",
          commandId: "cmd-publish-recovery",
          command: "test",
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);

      const chunk = capturedChannel!.onmessage!({
        type: "stdout",
        data: "recovered",
      }) as unknown as Promise<void>;
      await jest.advanceTimersByTimeAsync(250);
      await expect(chunk).resolves.toBeUndefined();

      expect(mockClient.ready).toHaveBeenCalledWith(5_000);
      expect(mockSubscription.ready).toHaveBeenCalledWith(5_000);
      expect(mockSubscription.publish).toHaveBeenNthCalledWith(1, {
        type: "stdout",
        commandId: "cmd-publish-recovery",
        data: "recovered",
        sequence: 0,
      });
      expect(mockSubscription.publish).toHaveBeenNthCalledWith(2, {
        type: "stdout",
        commandId: "cmd-publish-recovery",
        data: "recovered",
        sequence: 0,
      });
      expect(captureAuthenticatedEvent).toHaveBeenNthCalledWith(
        1,
        "desktop_stream_publish_failed",
        expect.objectContaining({
          commandId: "cmd-publish-recovery",
          reason: "connection_closed",
          attempt: 1,
          maxAttempts: 3,
        }),
      );
      expect(captureAuthenticatedEvent).toHaveBeenNthCalledWith(
        2,
        "desktop_stream_publish_recovered",
        expect.objectContaining({
          commandId: "cmd-publish-recovery",
          reason: "connection_closed",
          attempts: 2,
          recoveryLatencyMs: 250,
        }),
      );

      await capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
      finishCommand();
      await jest.advanceTimersByTimeAsync(0);
      expect(captureAuthenticatedEvent).toHaveBeenNthCalledWith(
        3,
        "desktop_stream_command_settled",
        {
          connectionId: "conn-123",
          commandId: "cmd-publish-recovery",
          outcome: "recovered",
          observedChunks: 2,
          publishedChunks: 2,
          exhaustedChunks: 0,
          terminalChunkObserved: "exit",
          terminalChunkPublished: true,
          sequenceComplete: true,
          durationMs: 250,
        },
      );
      expect(
        infoSpy.mock.calls
          .map(([value]) => {
            try {
              return JSON.parse(String(value)) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .find((value) => value?.event === "desktop_stream_command_settled"),
      ).toEqual(
        expect.objectContaining({
          level: "info",
          outcome: "recovered",
          observed_chunks: 2,
          published_chunks: 2,
          exhausted_chunks: 0,
          terminal_chunk_observed: "exit",
          terminal_chunk_published: true,
          sequence_complete: true,
          duration_ms: 250,
        }),
      );
    } finally {
      finishCommand();
      mockSubscription.publish.mockResolvedValue(undefined);
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it("stops retrying when the command recovery deadline is reached", async () => {
    jest.useFakeTimers();
    let finishCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
      if (cmd === "execute_stream_command") {
        await commandFinished;
      }
      return undefined;
    };
    mockSubscription.publish.mockRejectedValue({
      code: 11,
      message: "connection closed",
    });
    const rejectAtTimeout = (timeoutMs: number) =>
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("ready timeout")), timeoutMs);
      });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      mockClient.ready.mockImplementationOnce(rejectAtTimeout);
      mockSubscription.ready.mockImplementationOnce(rejectAtTimeout);
      const handler = getPublicationHandler();
      handler({
        data: {
          type: "command",
          commandId: "cmd-publish-deadline",
          command: "test",
          timeout: 1_000,
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(27_000);

      const chunk = capturedChannel!.onmessage!({
        type: "stdout",
        data: "late",
      }) as unknown as Promise<void>;
      await jest.advanceTimersByTimeAsync(250);
      await jest.advanceTimersByTimeAsync(3_750);
      await expect(chunk).resolves.toBeUndefined();

      expect(mockSubscription.publish).toHaveBeenCalledTimes(1);
      expect(mockClient.ready).toHaveBeenCalledWith(3_750);
      expect(mockSubscription.ready).toHaveBeenCalledWith(3_750);
      expect(captureAuthenticatedEvent).toHaveBeenNthCalledWith(
        2,
        "desktop_stream_publish_recovery_exhausted",
        expect.objectContaining({
          commandId: "cmd-publish-deadline",
          attempts: 1,
          exhaustionReason: "deadline",
          recoveryLatencyMs: 4_000,
        }),
      );
    } finally {
      finishCommand();
      mockSubscription.publish.mockResolvedValue(undefined);
      mockClient.ready.mockResolvedValue(undefined);
      mockSubscription.ready.mockResolvedValue(undefined);
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it("preserves unexpected publish rejections for error tracking", async () => {
    let finishCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    mockInvokeHandler = async (cmd: string) => {
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
      if (cmd === "execute_stream_command") {
        await commandFinished;
      }
      return undefined;
    };
    mockSubscription.publish.mockRejectedValue({
      code: 999,
      message: "unexpected publish failure",
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      const handler = getPublicationHandler();
      handler({
        data: {
          type: "command",
          commandId: "cmd-unknown-publish-failure",
          command: "test",
          targetConnectionId: "conn-123",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const firstChunk = capturedChannel!.onmessage!({
        type: "stdout",
        data: "first",
      }) as unknown as Promise<void>;
      const secondChunk = capturedChannel!.onmessage!({
        type: "stderr",
        data: "second",
      }) as unknown as Promise<void>;
      await expect(firstChunk).rejects.toThrow("unexpected publish failure");
      await expect(secondChunk).rejects.toThrow("unexpected publish failure");
      expect(captureAuthenticatedEvent).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls).not.toContainEqual([
        expect.stringContaining("desktop_stream_publish_failed"),
      ]);
    } finally {
      finishCommand();
      mockSubscription.publish.mockResolvedValue(undefined);
      warnSpy.mockRestore();
    }
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
      if (cmd === "desktop_file_request")
        return { kind: "not_file", path: "." };
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

describe("desktop lifecycle recovery", () => {
  it("restarts a stuck relay after 30 seconds even if only the socket reconnects", async () => {
    jest.useFakeTimers();
    const onTerminated = jest.fn();
    const bridge = new DesktopSandboxBridge(buildConfig({ onTerminated }));
    try {
      await bridge.start();
      getSubscriptionHandler("subscribing")({
        code: 1,
        reason: "transport closed",
      });
      await jest.advanceTimersByTimeAsync(20_000);
      getClientHandler("connected")({ transport: "websocket" });
      getClientHandler("connecting")({ code: 3, reason: "subscribe timeout" });
      await jest.advanceTimersByTimeAsync(9_999);
      expect(onTerminated).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(onTerminated).toHaveBeenCalledTimes(1);
      expect(onTerminated).toHaveBeenCalledWith("transport_disconnected");
      expect(bridge.getConnectionId()).toBeNull();
    } finally {
      await bridge.stop();
      jest.useRealTimers();
    }
  });

  it.each(["recovered", "stopped"])(
    "cancels stuck-relay recovery when %s",
    async (outcome) => {
      jest.useFakeTimers();
      const onTerminated = jest.fn();
      const bridge = new DesktopSandboxBridge(buildConfig({ onTerminated }));
      try {
        await bridge.start();
        getClientHandler("connecting")({ code: 1, reason: "transport closed" });
        await jest.advanceTimersByTimeAsync(20_000);
        if (outcome === "recovered") {
          getSubscriptionHandler("subscribed")({
            recovered: true,
            wasRecovering: true,
          });
        } else {
          await bridge.stop();
        }
        await jest.advanceTimersByTimeAsync(30_000);
        expect(onTerminated).not.toHaveBeenCalled();
      } finally {
        await bridge.stop();
        jest.useRealTimers();
      }
    },
  );

  it("finishes local shutdown while the remote disconnect stays offline", async () => {
    let resolveDisconnect!: (value: { success: boolean }) => void;
    const pending = new Promise<{ success: boolean }>((resolve) => {
      resolveDisconnect = resolve;
    });
    const config = buildConfig({ disconnectDesktop: jest.fn(() => pending) });
    const bridge = new DesktopSandboxBridge(config);
    await bridge.start();
    await bridge.stop();
    expect(bridge.getConnectionId()).toBeNull();
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    await bridge.stop();
    expect(config.disconnectDesktop).toHaveBeenCalledTimes(1);
    resolveDisconnect({ success: true });
    await pending;
  });

  it.each(["token", "heartbeat"])(
    "keeps session replacement terminal when detected by %s",
    async (source) => {
      const onTerminated = jest.fn();
      const config = buildConfig({
        onTerminated,
        heartbeatDesktop: jest
          .fn()
          .mockResolvedValue({ success: source !== "heartbeat" }),
        refreshCentrifugoTokenDesktop: jest.fn().mockResolvedValue({
          ok: false,
          reason: "connection_inactive",
          disconnectReason: "desktop_kicked_by_new_session",
        }),
      });
      const bridge = new DesktopSandboxBridge(config);
      await bridge.start();
      if (source === "token") {
        await expect(mockClientOptions?.getToken?.()).rejects.toThrow();
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(onTerminated).toHaveBeenCalledWith("session_replaced");
      expect(bridge.getConnectionId()).toBeNull();
      await bridge.stop();
    },
  );

  it("still recovers a heartbeat rejected after presence expiry", async () => {
    const onTerminated = jest.fn();
    const bridge = new DesktopSandboxBridge(
      buildConfig({
        onTerminated,
        heartbeatDesktop: jest.fn().mockResolvedValue({ success: false }),
        refreshCentrifugoTokenDesktop: jest.fn().mockResolvedValue({
          ok: false,
          reason: "connection_inactive",
          disconnectReason: "presence_sweep",
        }),
      }),
    );
    await bridge.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(onTerminated).toHaveBeenCalledWith("connection_inactive");
    await bridge.stop();
  });

  it.each([false, true])(
    "publishes readiness before native output and an immediate PTY exit (isolated=%s)",
    async (operationChannel) => {
      const bridge = new DesktopSandboxBridge(buildConfig());
      await bridge.start();
      const original = mockInvokeHandler;
      mockInvokeHandler = async (cmd, args) => {
        if (cmd === "execute_pty_create") {
          capturedChannel?.onmessage?.("early output");
          capturedChannel?.onmessage?.(
            JSON.stringify({
              type: "exit",
              exitCode: 7,
              sessionId: "fast-pty",
            }),
          );
          return { pid: 123, session_id: "fast-pty" };
        }
        return original(cmd, args);
      };
      getPublicationHandler()({
        data: {
          type: "pty_create",
          operationChannel,
          sessionId: "fast-pty",
          command: "exit 7",
          targetConnectionId: "conn-123",
        },
      });
      await waitFor(() => {
        expect(
          mockSubscription.publish.mock.calls.map(([message]) => message.type),
        ).toEqual([
          ...(operationChannel ? ["operation_ready"] : []),
          "pty_ready",
          "pty_data",
          "pty_exit",
        ]);
      });
      const messages = mockSubscription.publish.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type !== "operation_ready");
      expect(messages.map((message) => message.type)).toEqual([
        "pty_ready",
        "pty_data",
        "pty_exit",
      ]);
      expect(messages[1].data).toBe("early output");
      expect(messages[2].exitCode).toBe(7);
      await bridge.stop();
    },
  );
});

it.each([
  "bridge_stop",
  "transport_disconnected",
  "connection_inactive",
  "session_replaced",
  "unauthenticated",
] as const)(
  "records the pending-output stop source without changing shutdown: %s",
  async (source) => {
    jest.useFakeTimers();
    const spies = ["warn", "error", "info"].map((method) =>
      jest.spyOn(console, method as "warn").mockImplementation(() => {}),
    );
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    let executions = 0;
    const native = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "execute_stream_command") {
        executions++;
        capturedChannel!.onmessage!({ type: "stdout", data: "PRIVATE" });
        capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
        return;
      }
      return native(cmd, args);
    };
    try {
      await bridge.start();
      getPublicationHandler()({
        data: {
          type: "command",
          commandId: "pending-stop-source",
          command: "PRIVATE",
          timeout: 120_000,
          outputProtocol: "ack-v1",
          operationChannel: true,
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(executions).toBe(1);
      if (source === "bridge_stop") await bridge.stop();
      else if (source === "transport_disconnected") {
        getClientHandler("disconnected")({
          code: 1,
          reason: "transport closed",
        });
      } else {
        config.heartbeatDesktop.mockResolvedValue({ success: false });
        if (source === "unauthenticated") {
          config.heartbeatDesktop.mockRejectedValue({
            data: { code: "UNAUTHORIZED" },
          });
        } else {
          config.refreshCentrifugoTokenDesktop.mockResolvedValue({
            ok: false,
            reason: "connection_inactive",
            disconnectReason:
              source === "session_replaced"
                ? "desktop_kicked_by_new_session"
                : "presence_sweep",
          } as never);
        }
        await jest.advanceTimersByTimeAsync(
          LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS,
        );
      }
      await jest.advanceTimersByTimeAsync(0);
      await bridge.stop();
      const finals = jest
        .mocked(captureQueuedAuthenticatedEvent)
        .mock.calls.filter(
          ([event]) => event.event === "desktop_ack_command_settled",
        );
      expect(finals).toHaveLength(1);
      expect(finals[0][0].properties).toMatchObject({
        outcome: "incomplete",
        reason: "stopped",
        stopSource: source,
        terminalAcknowledged: false,
        pendingFrames: 2,
        acknowledgedFrames: 0,
      });
      expect(JSON.stringify(finals)).not.toContain("PRIVATE");
      expect(executions).toBe(1);
      expect(bridge.getConnectionId()).toBeNull();
      if (source === "session_replaced" || source === "connection_inactive") {
        expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
          "desktop_bridge_relay_state_changed",
          expect.objectContaining({
            reason: "heartbeat_connection_inactive",
            terminationReason: source,
          }),
        );
      }
    } finally {
      await bridge.stop();
      mockInvokeHandler = native;
      spies.forEach((spy) => spy.mockRestore());
      jest.useRealTimers();
    }
  },
);

it.each(["ack", "cancel"])(
  "keeps native exit available until %s and never reexecutes",
  async (mode) => {
    jest.useFakeTimers();
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const reply = {
      ...mockSubscription,
      on: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    mockClient.newSubscription.mockReturnValueOnce(reply);
    let executions = 0;
    const native = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "execute_stream_command") {
        executions++;
        capturedChannel!.onmessage!({
          type: "stdout",
          data: "actual native output",
        });
        capturedChannel!.onmessage!({ type: "exit", exitCode: 0 });
        return;
      }
      return native(cmd, args);
    };
    try {
      const request = {
        type: "command",
        commandId: "ack-native",
        command: "bounded",
        outputProtocol: "ack-v1",
        targetConnectionId: "conn-123",
        operationChannel: true,
      };
      getPublicationHandler()({ data: request });
      await jest.advanceTimersByTimeAsync(0);
      expect(executions).toBe(1);
      expect(reply.unsubscribe).not.toHaveBeenCalled();
      const publication = reply.on.mock.calls.find(
        ([event]) => event === "publication",
      )![1];
      publication({
        data: {
          type: "command_output_resume",
          commandId: "ack-native",
          sequence: -1,
          targetConnectionId: "conn-123",
        },
      });
      getPublicationHandler()({ data: request });
      await jest.advanceTimersByTimeAsync(1000);
      expect(executions).toBe(1);
      expect(
        reply.publish.mock.calls.filter(([frame]) => frame.type === "exit")
          .length,
      ).toBeGreaterThan(1);
      publication({
        data: {
          type: mode === "ack" ? "command_output_ack" : "command_cancel",
          commandId: "ack-native",
          sequence: 1,
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "desktop_ack_command_started",
          properties: expect.objectContaining({
            commandId: "ack-native",
            outputProtocol: "ack-v1",
          }),
        }),
      );
      expect(captureQueuedAuthenticatedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "desktop_ack_command_settled",
          properties: expect.objectContaining({
            commandId: "ack-native",
            outcome: mode === "ack" ? "acknowledged" : "canceled",
            terminalAcknowledged: mode === "ack",
            replayAttempts: expect.any(Number),
          }),
        }),
      );
      if (mode === "ack") {
        expect(reply.unsubscribe).toHaveBeenCalledTimes(1);
      } else {
        const outputCount = reply.publish.mock.calls.filter(
          ([frame]) => frame.sequence !== undefined,
        ).length;
        await jest.advanceTimersByTimeAsync(2000);
        expect(
          reply.publish.mock.calls.filter(
            ([frame]) => frame.sequence !== undefined,
          ),
        ).toHaveLength(outputCount);
        publication({
          data: {
            type: "command_cancel",
            commandId: "ack-native",
            targetConnectionId: "conn-123",
          },
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(
          reply.publish.mock.calls.filter(
            ([frame]) => frame.type === "command_cancel_result",
          ),
        ).toHaveLength(2);
        expect(reply.unsubscribe).not.toHaveBeenCalled();
      }
      expect(reply.presence).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
      jest.useRealTimers();
    }
  },
);

it.each(["before readiness", "while publishing"])(
  "bounds native PTY output %s and kills only that session",
  async (phase) => {
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const native = mockInvokeHandler;
    const kills: string[] = [];
    let releaseCreate!: () => void;
    let releasePublish!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "execute_pty_create") {
        if (phase === "before readiness") await createGate;
        return { pid: 123, session_id: "bounded-pty" };
      }
      if (cmd === "execute_pty_kill") {
        kills.push(args!.sessionId as string);
        return;
      }
      return native(cmd, args);
    };
    mockSubscription.publish.mockImplementation(
      async (value: { type: string }) => {
        if (value.type === "pty_data") await publishGate;
      },
    );
    try {
      getPublicationHandler()({
        data: {
          type: "pty_create",
          sessionId: "bounded-pty",
          command: "bash",
          targetConnectionId: "conn-123",
        },
      });
      await waitFor(() => expect(capturedChannel?.onmessage).toBeDefined());
      if (phase === "while publishing") {
        await waitFor(() =>
          expect(mockSubscription.publish).toHaveBeenCalledWith(
            expect.objectContaining({ type: "pty_ready" }),
          ),
        );
      }
      // More than four MiB with an unavailable consumer, including callbacks
      // that arrive before the native create RPC returns.
      for (let i = 0; i < 260; i++)
        capturedChannel!.onmessage!("x".repeat(16 * 1024));
      await waitFor(() => expect(kills).toContain("bounded-pty"));
      await waitFor(() =>
        expect(mockSubscription.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "pty_error",
            sessionId: "bounded-pty",
            message: expect.stringContaining("incomplete"),
          }),
        ),
      );
      releaseCreate();
      releasePublish();
      capturedChannel!.onmessage!(
        JSON.stringify({ type: "exit", sessionId: "bounded-pty", exitCode: 0 }),
      );
      await waitFor(() =>
        expect(
          mockSubscription.publish.mock.calls.filter(
            ([value]) => value.type === "pty_error",
          ),
        ).toHaveLength(1),
      );
      expect(mockSubscription.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "pty_exit" }),
      );
      expect(kills.every((id) => id === "bounded-pty")).toBe(true);
    } finally {
      releaseCreate();
      releasePublish();
      await bridge.stop();
      mockSubscription.publish.mockReset().mockResolvedValue(undefined);
    }
  },
);

it("reports ACK expiry while the native invocation is still pending", async () => {
  jest.useFakeTimers();
  const bridge = new DesktopSandboxBridge(buildConfig());
  await bridge.start();
  const reply = {
    ...mockSubscription,
    on: jest.fn(),
    publish: jest.fn().mockResolvedValue(undefined),
    unsubscribe: jest.fn(),
    removeAllListeners: jest.fn(),
  };
  mockClient.newSubscription.mockReturnValueOnce(reply);
  const original = mockInvokeHandler;
  let finishNative: (() => void) | undefined;
  mockInvokeHandler = async (cmd, args) => {
    if (cmd === "execute_stream_command") {
      capturedChannel!.onmessage!({
        type: "stdout",
        data: "private native output",
      });
      await new Promise<void>((resolve) => {
        finishNative = resolve;
      });
      return;
    }
    return original(cmd, args);
  };
  try {
    getPublicationHandler()({
      data: {
        type: "command",
        commandId: "ack-hung-native",
        command: "private command",
        timeout: 1000,
        outputProtocol: "ack-v1",
        targetConnectionId: "conn-123",
        operationChannel: true,
      },
    });
    await jest.advanceTimersByTimeAsync(31_000);
    const settlements = jest
      .mocked(captureQueuedAuthenticatedEvent)
      .mock.calls.filter(
        ([event]) =>
          event.event === "desktop_ack_command_settled" &&
          event.properties?.commandId === "ack-hung-native",
      );
    expect(settlements).toHaveLength(1);
    expect(settlements[0][0].properties).toMatchObject({
      outcome: "incomplete",
      reason: "deadline_exceeded",
      terminalAcknowledged: false,
      pendingFrames: 1,
      acknowledgedFrames: 0,
    });
    expect(JSON.stringify(settlements)).not.toContain("private");
    finishNative!();
    await jest.advanceTimersByTimeAsync(0);
    expect(
      jest
        .mocked(captureQueuedAuthenticatedEvent)
        .mock.calls.filter(
          ([event]) =>
            event.event === "desktop_ack_command_settled" &&
            event.properties?.commandId === "ack-hung-native",
        ),
    ).toHaveLength(1);
  } finally {
    finishNative?.();
    mockInvokeHandler = original;
    await bridge.stop();
    jest.useRealTimers();
  }
});
it.each([false, true])(
  "cancels only the stopped run locally while relay delivery hangs (ack: %s)",
  async (acknowledged) => {
    jest.useFakeTimers();
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    const running = new Map<string, () => void>();
    const executed: string[] = [];
    const canceled: string[] = [];
    const native = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      const id = args?.commandId as string;
      if (cmd === "execute_stream_command") {
        executed.push(id);
        const channel = capturedChannel!;
        return new Promise<void>((resolve) =>
          running.set(id, () => {
            channel.onmessage!({ type: "exit", exitCode: 130 });
            resolve();
          }),
        );
      }
      if (cmd === "cancel_stream_command") {
        canceled.push(id);
        running.get(id)?.();
        running.delete(id);
        return true;
      }
      return native(cmd, args);
    };
    let publication = getPublicationHandler();
    const send = (id: string, chatId: string, triggerRunId: string) =>
      publication({
        data: {
          type: "command",
          commandId: id,
          command: "sleep 120",
          chatId,
          triggerRunId,
          targetConnectionId: "conn-123",
          ...(acknowledged
            ? { outputProtocol: "ack-v1", operationChannel: true }
            : {}),
        },
      });
    try {
      send("target", "chat-a", `run-a-${acknowledged}`);
      send("other-chat", "chat-b", "run-b");
      send("newer-run", "chat-a", "run-new");
      await jest.advanceTimersByTimeAsync(0);
      expect(executed).toEqual(["target", "other-chat", "newer-run"]);
      mockSubscription.publish.mockImplementation(() => new Promise(() => {}));
      // Native execution survives a terminal relay disconnect. Stop must too.
      await bridge.stop();
      await cancelDesktopRunLocally("chat-a", `run-a-${acknowledged}`);
      expect(canceled).toEqual(["target"]);
      expect([...running.keys()]).toEqual(["other-chat", "newer-run"]);
      // A command already queued by the stopped worker must not execute on reconnect.
      mockSubscription.publish.mockReset().mockResolvedValue(undefined);
      await bridge.start();
      publication = mockSubscription.on.mock.calls
        .filter(([event]: [string]) => event === "publication")
        .at(-1)![1];
      send("late-target", "chat-a", `run-a-${acknowledged}`);
      await jest.advanceTimersByTimeAsync(0);
      expect(executed).toEqual(["target", "other-chat", "newer-run"]);
      expect(mockSubscription.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: "late-target",
          type: "exit",
          exitCode: 130,
        }),
      );
    } finally {
      for (const finish of running.values()) finish();
      await bridge.stop();
      mockSubscription.publish.mockReset().mockResolvedValue(undefined);
      jest.useRealTimers();
    }
  },
);

it.each([0, 2])(
  "preserves native ACK delivery while reducing routine telemetry (exit %i)",
  async (exitCode) => {
    jest.useFakeTimers();
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
    const bridge = new DesktopSandboxBridge(buildConfig());
    const native = mockInvokeHandler;
    try {
      await bridge.start();
      const reply = {
        ...mockSubscription,
        on: jest.fn(),
        publish: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn(),
        removeAllListeners: jest.fn(),
      };
      mockClient.newSubscription.mockReturnValueOnce(reply);
      let executions = 0;
      mockInvokeHandler = async (cmd, args) => {
        if (cmd === "execute_stream_command") {
          executions++;
          capturedChannel!.onmessage!({
            type: "stdout",
            data: "PRIVATE OUTPUT",
          });
          capturedChannel!.onmessage!({ type: "exit", exitCode });
          return;
        }
        return native(cmd, args);
      };
      getPublicationHandler()({
        data: {
          type: "command",
          commandId: "unsampled-native",
          command: "PRIVATE COMMAND",
          outputProtocol: "ack-v1",
          operationChannel: true,
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      const publication = reply.on.mock.calls.find(
        ([event]) => event === "publication",
      )![1];
      publication({
        data: {
          type: "command_output_ack",
          commandId: "unsampled-native",
          sequence: 1,
          targetConnectionId: "conn-123",
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(executions).toBe(1);
      expect(reply.unsubscribe).toHaveBeenCalledTimes(1);
      await bridge.stop();
      const captures = jest.mocked(captureQueuedAuthenticatedEvent).mock.calls;
      expect(
        captures.filter(
          ([event]) => event.event === "desktop_ack_command_started",
        ),
      ).toHaveLength(0);
      const finals = captures.filter(
        ([event]) => event.event === "desktop_ack_command_settled",
      );
      expect(finals).toHaveLength(exitCode === 0 ? 0 : 1);
      if (exitCode !== 0)
        expect(finals[0][0].properties).toMatchObject({
          terminalExitCode: exitCode,
          telemetry_sampled: false,
          telemetry_sample_rate: 1,
        });
      expect(
        captures.find(
          ([event]) => event.event === "desktop_ack_delivery_summary",
        )![0].properties,
      ).toMatchObject({
        startedCount: 1,
        settledCount: 1,
        acknowledgedCount: 1,
        nonzeroExitCount: exitCode === 0 ? 0 : 1,
      });
      expect(JSON.stringify(captures)).not.toContain("PRIVATE");
    } finally {
      await bridge.stop();
      mockInvokeHandler = native;
      jest.mocked(sampleDiagnosticOperation).mockReturnValue(true);
      jest.useRealTimers();
    }
  },
);

describe("native authorization send receipt", () => {
  type MockChannel = {
    onmessage?: (value: unknown) => void;
    cleanupCallback: jest.Mock;
  };
  type NativeCall = Record<string, unknown> & { cmd: string };
  const receipt = {
    version: 1,
    timeout: false,
    connect: true,
    request: false,
    elapsedMs: 42,
    originClass: "canonical_production",
    // Differs from the bridge's cached OS info ("darwin" in this harness).
    platform: "linux",
  };
  const unavailable = "Desktop operation authorization unavailable";
  const authorizationId = "a".repeat(64);
  const nativeKeys = (properties: Record<string, unknown> = {}) =>
    Object.keys(properties).filter((key) =>
      NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key),
    );
  const captures = () =>
    jest.mocked(captureQueuedAuthenticatedEvent).mock.calls.map(([e]) => e);
  const finals = () =>
    captures().filter((event) => event.event === "desktop_ack_command_settled");
  const sequencedFrames = (reply: { publish: jest.Mock }) =>
    reply.publish.mock.calls
      .map(([frame]) => frame)
      .filter((frame) => frame.sequence !== undefined);

  /** Runs commands through the real bridge, then acknowledges each terminal. */
  async function run(
    native: (call: NativeCall) => Promise<unknown>,
    options: {
      version?: string;
      commandIds?: string[];
      acknowledged?: boolean;
      beforeAck?: (bridge: DesktopSandboxBridge) => Promise<void>;
    } = {},
  ) {
    const {
      version = "0.0.80",
      commandIds = ["auth-send"],
      acknowledged = true,
    } = options;
    jest.useFakeTimers();
    const base = mockInvokeHandler;
    const calls: NativeCall[] = [];
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "plugin:app|version") return version;
      if (
        cmd === "execute_authorized_stream_command" ||
        cmd === "execute_stream_command"
      ) {
        const call = { cmd, ...args };
        calls.push(call);
        return native(call);
      }
      return base(cmd, args);
    };
    const bridge = new DesktopSandboxBridge(buildConfig());
    const replies: ReturnType<typeof makeReply>[] = [];
    function makeReply() {
      return {
        ...mockSubscription,
        on: jest.fn(),
        publish: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn(),
        removeAllListeners: jest.fn(),
      };
    }
    try {
      await bridge.start();
      mockUseAuthorizedNative = true;
      mockClient.newSubscription.mockImplementation(() => {
        const reply = makeReply();
        replies.push(reply);
        return reply;
      });
      for (const commandId of commandIds)
        getPublicationHandler()({
          data: {
            type: "command",
            commandId,
            command: "PRIVATE COMMAND",
            authorizationId,
            targetConnectionId: "conn-123",
            ...(acknowledged && {
              outputProtocol: "ack-v1",
              operationChannel: true,
            }),
          },
        });
      await jest.advanceTimersByTimeAsync(0);
      await options.beforeAck?.(bridge);
      await jest.advanceTimersByTimeAsync(0);
      for (const reply of replies) {
        const terminal = sequencedFrames(reply).at(-1);
        const publication = reply.on.mock.calls.find(
          ([event]) => event === "publication",
        )?.[1];
        if (terminal && publication)
          publication({
            data: {
              type: "command_output_ack",
              commandId: terminal.commandId,
              sequence: terminal.sequence,
              targetConnectionId: "conn-123",
            },
          });
      }
      await jest.advanceTimersByTimeAsync(0);
    } finally {
      await bridge.stop();
      mockInvokeHandler = base;
      mockClient.newSubscription.mockReset().mockReturnValue(mockSubscription);
      jest.useRealTimers();
    }
    return { calls, replies };
  }

  it("joins one same-invocation receipt to the existing terminal-error final", async () => {
    const { calls, replies } = await run(async (call) => {
      const diagnostic = call.onAuthorizationDiagnostic as MockChannel;
      diagnostic.onmessage!(receipt);
      // A duplicate cannot replace the first callback attempt.
      diagnostic.onmessage!({ ...receipt, timeout: true, connect: false });
      return Promise.reject(unavailable);
    });

    // One authorized invocation, no legacy downgrade, signed message unchanged.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "execute_authorized_stream_command",
      authorizationId,
      onEvent: expect.any(Object),
      onAuthorizationDiagnostic: expect.any(Object),
    });
    expect(calls[0].onAuthorizationDiagnostic).not.toBe(calls[0].onEvent);
    expect(Object.keys(calls[0].message as object)).not.toContain(
      "onAuthorizationDiagnostic",
    );
    // The product error is the identical single terminal frame.
    expect(replies).toHaveLength(1);
    expect(sequencedFrames(replies[0])).toEqual([
      expect.objectContaining({
        type: "error",
        message: unavailable,
        sequence: 0,
      }),
    ]);
    expect(replies[0].unsubscribe).toHaveBeenCalledTimes(1);

    expect(finals()).toHaveLength(1);
    const final = finals()[0];
    expect(final.properties).toMatchObject({
      outcome: "acknowledged",
      reason: "terminal_ack",
      terminalType: "error",
      telemetry_sample_rate: 1,
      native_authorization_diagnostic_version: 1,
      native_authorization_send_timeout: false,
      native_authorization_send_connect: true,
      native_authorization_send_request: false,
      native_authorization_send_elapsed_ms: 42,
      native_authorization_origin_class: "canonical_production",
      native_app_version: "0.0.80",
      // The same invocation's native platform, never the separate OS cache.
      native_platform: "linux",
    });
    const started = captures().find(
      (event) => event.event === "desktop_ack_command_started",
    );
    expect(nativeKeys(started?.properties)).toEqual([]);
    const enriched = sanitizeDesktopAckEvent({
      ...final,
      properties: { ...final.properties, $current_url: "PRIVATE" },
      $set: { email: "PRIVATE" },
    });
    expect(nativeKeys(enriched.properties)).toHaveLength(8);
    const serialized = JSON.stringify([captures(), enriched]);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain(authorizationId);
    expect(serialized).not.toContain(unavailable);
  });

  const reject = (message: string) => Promise.reject(message);
  it.each<[string, (call: NativeCall) => Promise<unknown>, object]>([
    [
      "an HTTP status rejection",
      () => reject("Desktop operation was not authorized"),
      { type: "error", message: "Desktop operation was not authorized" },
    ],
    [
      "an approval parse rejection",
      () => reject("Invalid Desktop authorization response"),
      { type: "error", message: "Invalid Desktop authorization response" },
    ],
    [
      "an older native app that ignores the channel",
      () => reject(unavailable),
      { type: "error", message: unavailable },
    ],
    [
      "a successful command with a stray receipt",
      async (call) => {
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt);
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      },
      { type: "exit", exitCode: 0 },
    ],
    [
      "an out-of-range receipt",
      (call) => {
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!({
          ...receipt,
          elapsedMs: 60_001,
        });
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
    [
      "a raw target OS name instead of the platform class",
      (call) => {
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!({
          ...receipt,
          platform: "macos",
        });
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
    [
      "a receipt without a platform",
      (call) => {
        const { platform: _platform, ...legacyShape } = receipt;
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!(legacyShape);
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
    [
      "a receipt with an extra private field",
      (call) => {
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!({
          ...receipt,
          message: "PRIVATE",
        });
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
    [
      "a receipt with a throwing getter",
      (call) => {
        const hostile = { ...receipt };
        Object.defineProperty(hostile, "timeout", {
          enumerable: true,
          get() {
            throw new Error("PRIVATE");
          },
        });
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!(hostile);
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
    [
      "a throwing proxy",
      (call) => {
        const fail = () => {
          throw new Error("PRIVATE");
        };
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!(
          new Proxy({}, { getPrototypeOf: fail, ownKeys: fail, get: fail }),
        );
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
    [
      "a malformed first attempt followed by a valid duplicate",
      (call) => {
        const diagnostic = call.onAuthorizationDiagnostic as MockChannel;
        diagnostic.onmessage!("PRIVATE");
        diagnostic.onmessage!(receipt);
        return reject(unavailable);
      },
      { type: "error", message: unavailable },
    ],
  ])("adds no receipt for %s", async (_case, native, terminal) => {
    const { calls, replies } = await run(native);
    expect(calls).toHaveLength(1);
    expect(sequencedFrames(replies[0])).toEqual([
      expect.objectContaining({ ...terminal, sequence: 0 }),
    ]);
    expect(finals()).toHaveLength(1);
    expect(finals()[0].properties).toMatchObject({
      outcome: "acknowledged",
      terminalType: (terminal as { type: string }).type,
    });
    expect(nativeKeys(finals()[0].properties)).toEqual([]);
    expect(JSON.stringify(captures())).not.toContain("PRIVATE");
  });

  it("drops a receipt after settlement and releases the optional callback", async () => {
    let diagnostic!: MockChannel;
    await run((call) => {
      diagnostic = call.onAuthorizationDiagnostic as MockChannel;
      return reject(unavailable);
    });
    expect(diagnostic.cleanupCallback).toHaveBeenCalledTimes(1);
    diagnostic.onmessage!(receipt);
    expect(finals()).toHaveLength(1);
    expect(nativeKeys(finals()[0].properties)).toEqual([]);
  });

  it("reports an unknown receipt platform as null, not the cached OS", async () => {
    await run((call) => {
      (call.onAuthorizationDiagnostic as MockChannel).onmessage!({
        ...receipt,
        platform: "unknown",
      });
      return reject(unavailable);
    });
    expect(finals()[0].properties).toMatchObject({
      native_authorization_diagnostic_version: 1,
      native_platform: null,
    });
  });

  it.each(["ignores", "ends"])(
    "releases the actual SDK callback after settlement when native %s the channel",
    async (mode) => {
      // Actual installed SDK Channel; only the webview callback registry is fake.
      const actual = jest.requireActual<typeof TauriCore>(
        "@tauri-apps/api/core",
      );
      const registry = new Map<number, (message: unknown) => void>();
      let nextId = 1;
      const host = window as unknown as { __TAURI_INTERNALS__?: unknown };
      const previous = host.__TAURI_INTERNALS__;
      host.__TAURI_INTERNALS__ = {
        transformCallback: (callback: (message: unknown) => void) => {
          const id = nextId++;
          registry.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => {
          registry.delete(id);
        },
      };
      const { Channel } = await import("@tauri-apps/api/core");
      jest
        .mocked(Channel)
        .mockImplementationOnce(
          (onmessage) => new actual.Channel(onmessage) as never,
        );
      let diagnostic!: TauriCore.Channel<unknown>;
      let registeredDuringInvoke = false;
      try {
        const { replies } = await run((call) => {
          diagnostic = call.onAuthorizationDiagnostic as TauriCore.Channel;
          registeredDuringInvoke = registry.has(diagnostic.id);
          if (mode === "ends") {
            // Rust message then drop of its Channel, as channel_on delivers them.
            registry.get(diagnostic.id)!({ message: receipt, index: 0 });
            registry.get(diagnostic.id)!({ end: true, index: 1 });
          }
          return reject(unavailable);
        });
        expect(diagnostic).toBeInstanceOf(actual.Channel);
        expect(registeredDuringInvoke).toBe(true);
        // Without a native end message, only the bridge can release it.
        expect(registry.has(diagnostic.id)).toBe(false);
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: unavailable }),
        ]);
        expect(finals()).toHaveLength(1);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(
          mode === "ends" ? 8 : 0,
        );
      } finally {
        host.__TAURI_INTERNALS__ = previous;
      }
    },
  );

  it("drops a receipt observed under another analytics owner", async () => {
    const identity = jest.mocked(getIdentifiedAnalyticsUserId);
    try {
      await run((call) => {
        const diagnostic = call.onAuthorizationDiagnostic as MockChannel;
        identity.mockReturnValue("another-user");
        diagnostic.onmessage!(receipt);
        // The closed latch keeps it from attaching after the owner returns.
        identity.mockReturnValue("user-456");
        diagnostic.onmessage!(receipt);
        return reject(unavailable);
      });
      // The existing ACK owner gate still emits the original owner's final.
      expect(finals()).toHaveLength(1);
      expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
      expect(nativeKeys(finals()[0].properties)).toEqual([]);
    } finally {
      identity.mockReturnValue("user-456");
    }
  });

  it("creates no optional channel without an identified analytics owner", async () => {
    const identity = jest.mocked(getIdentifiedAnalyticsUserId);
    const { Channel } = await import("@tauri-apps/api/core");
    identity.mockReturnValue(null);
    try {
      const { calls, replies } = await run(() => reject(unavailable));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveProperty("onEvent");
      expect(calls[0]).not.toHaveProperty("onAuthorizationDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationCauseDiagnostic");
      expect(jest.mocked(Channel)).toHaveBeenCalledTimes(1);
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(finals()).toHaveLength(0);
    } finally {
      identity.mockReturnValue("user-456");
    }
  });

  it("drops a receipt that arrives after the connection is stopped", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await run(
      async (call) => {
        await pending;
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt);
        return reject(unavailable);
      },
      {
        beforeAck: async (bridge) => {
          await bridge.stop();
          release();
        },
      },
    );
    expect(finals()).toHaveLength(1);
    expect(finals()[0].properties).toMatchObject({
      outcome: "incomplete",
      reason: "stopped",
      stopSource: "bridge_stop",
    });
    expect(nativeKeys(finals()[0].properties)).toEqual([]);
  });

  it("keeps overlapping invocations' receipts separate", async () => {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = await run(
      async (call) => {
        if (++arrived === 2) release();
        await both;
        if ((call.message as { commandId: string }).commandId === "timed-out")
          (call.onAuthorizationDiagnostic as MockChannel).onmessage!({
            ...receipt,
            timeout: true,
            connect: false,
            elapsedMs: 8000,
          });
        return reject(unavailable);
      },
      { commandIds: ["timed-out", "no-receipt"] },
    );
    expect(calls).toHaveLength(2);
    const byCommand = Object.fromEntries(
      finals().map((event) => [event.properties!.commandId, event.properties]),
    );
    expect(byCommand["timed-out"]).toMatchObject({
      native_authorization_send_timeout: true,
      native_authorization_send_connect: false,
      native_authorization_send_elapsed_ms: 8000,
    });
    expect(nativeKeys(byCommand["no-receipt"])).toEqual([]);
  });

  it("keeps the command unchanged when the optional channel cannot be created", async () => {
    const { Channel } = await import("@tauri-apps/api/core");
    jest.mocked(Channel).mockImplementationOnce(() => {
      throw new Error("channel unavailable");
    });
    const { calls, replies } = await run(() => reject(unavailable));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty("onEvent");
    expect(calls[0]).not.toHaveProperty("onAuthorizationDiagnostic");
    expect(calls[0]).not.toHaveProperty("onAuthorizationCauseDiagnostic");
    expect(sequencedFrames(replies[0])).toEqual([
      expect.objectContaining({ type: "error", message: unavailable }),
    ]);
    expect(nativeKeys(finals()[0].properties)).toEqual([]);
  });

  describe("closed IO cause", () => {
    const cause = {
      version: 1,
      ioKind: "connection_reset",
      sourceDepth: 3,
      sourceChainTruncated: false,
    };
    const causeGroup = {
      native_authorization_cause_version: 1,
      native_authorization_cause_io_kind: "connection_reset",
      native_authorization_cause_source_depth: 3,
      native_authorization_cause_source_chain_truncated: false,
    };
    const causeKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key),
      );
    const channels = (call: NativeCall) => ({
      receipt: call.onAuthorizationDiagnostic as MockChannel,
      cause: call.onAuthorizationCauseDiagnostic as MockChannel,
    });

    it.each(["receipt first", "cause first"])(
      "joins one cause from its own one-shot channel with %s",
      async (order) => {
        const { calls, replies } = await run(async (call) => {
          const { receipt: v1, cause: v2 } = channels(call);
          if (order === "receipt first") {
            v1.onmessage!(receipt);
            v2.onmessage!(cause);
          } else {
            v2.onmessage!(cause);
            v1.onmessage!(receipt);
          }
          // Each latch closes only itself, on its own first attempt.
          v1.onmessage!({ ...receipt, timeout: true });
          v2.onmessage!({ ...cause, ioKind: "broken_pipe" });
          return Promise.reject(unavailable);
        });

        expect(calls).toHaveLength(1);
        const { receipt: v1, cause: v2 } = channels(calls[0]);
        expect(v2).toBeDefined();
        expect(v2).not.toBe(v1);
        expect(v2).not.toBe(calls[0].onEvent);
        expect(Object.keys(calls[0].message as object)).not.toContain(
          "onAuthorizationCauseDiagnostic",
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: unavailable }),
        ]);
        expect(finals()).toHaveLength(1);
        const final = finals()[0];
        expect(final.properties).toMatchObject({
          terminalType: "error",
          native_authorization_send_timeout: false,
          native_platform: "linux",
          ...causeGroup,
        });
        expect(nativeKeys(final.properties)).toHaveLength(8);
        const enriched = sanitizeDesktopAckEvent({
          ...final,
          properties: { ...final.properties, $current_url: "PRIVATE" },
        });
        expect(enriched.properties).toMatchObject(causeGroup);
        expect(causeKeys(enriched.properties)).toHaveLength(4);
        expect(JSON.stringify([captures(), enriched])).not.toContain("PRIVATE");
      },
    );

    it("keeps the original v1 diagnostic when an older native app sends no cause", async () => {
      await run((call) => {
        channels(call).receipt.onmessage!(receipt);
        return reject(unavailable);
      });
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(causeKeys(finals()[0].properties)).toEqual([]);
    });

    it("reports no cause without the same invocation's v1 receipt", async () => {
      await run((call) => {
        channels(call).cause.onmessage!(cause);
        return reject(unavailable);
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
      expect(nativeKeys(finals()[0].properties)).toEqual([]);
      expect(causeKeys(finals()[0].properties)).toEqual([]);
    });

    it.each<[string, () => unknown]>([
      ["an extra private field", () => ({ ...cause, message: "PRIVATE" })],
      [
        "a missing field",
        () => ({ ...cause, sourceChainTruncated: undefined }),
      ],
      ["an unlisted kind", () => ({ ...cause, ioKind: "connection_refused" })],
      ["a private kind", () => ({ ...cause, ioKind: "PRIVATE" })],
      ["an unbounded depth", () => ({ ...cause, sourceDepth: 9 })],
      [
        "an exposed kind on a truncated walk",
        () => ({ ...cause, sourceChainTruncated: true }),
      ],
      ["a v1 receipt on the cause channel", () => receipt],
      ["a string", () => "PRIVATE"],
      [
        "a class instance",
        () =>
          Object.assign(Object.create({ message: "PRIVATE" }) as object, cause),
      ],
      [
        "a throwing getter",
        () => {
          const hostile = { ...cause };
          Object.defineProperty(hostile, "ioKind", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE");
            },
          });
          return hostile;
        },
      ],
      [
        "a throwing proxy",
        () => {
          const fail = () => {
            throw new Error("PRIVATE");
          };
          return new Proxy(
            {},
            { getPrototypeOf: fail, ownKeys: fail, get: fail },
          );
        },
      ],
    ])(
      "drops only the cause for %s and keeps the v1 diagnostic",
      async (_case, value) => {
        const { replies } = await run((call) => {
          const { receipt: v1, cause: v2 } = channels(call);
          v1.onmessage!(receipt);
          v2.onmessage!(value());
          // The malformed first attempt closed the cause latch.
          v2.onmessage!(cause);
          return reject(unavailable);
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: unavailable }),
        ]);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
        expect(causeKeys(finals()[0].properties)).toEqual([]);
        expect(JSON.stringify(captures())).not.toContain("PRIVATE");
      },
    );

    it("adds no cause to a successful command", async () => {
      await run(async (call) => {
        const { receipt: v1, cause: v2 } = channels(call);
        v1.onmessage!(receipt);
        v2.onmessage!(cause);
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
      expect(nativeKeys(finals()[0].properties)).toEqual([]);
      expect(causeKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a cause after settlement and releases both callbacks", async () => {
      let call!: NativeCall;
      await run((native) => {
        call = native;
        channels(call).receipt.onmessage!(receipt);
        return reject(unavailable);
      });
      const { receipt: v1, cause: v2 } = channels(call);
      expect(v1.cleanupCallback).toHaveBeenCalledTimes(1);
      expect(v2.cleanupCallback).toHaveBeenCalledTimes(1);
      v2.onmessage!(cause);
      expect(finals()).toHaveLength(1);
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(causeKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a cause observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        await run((call) => {
          const { receipt: v1, cause: v2 } = channels(call);
          v1.onmessage!(receipt);
          identity.mockReturnValue("another-user");
          v2.onmessage!(cause);
          identity.mockReturnValue("user-456");
          v2.onmessage!(cause);
          return reject(unavailable);
        });
        expect(finals()).toHaveLength(1);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
        expect(causeKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("drops a cause that arrives after the connection is stopped", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          channels(call).receipt.onmessage!(receipt);
          await pending;
          channels(call).cause.onmessage!(cause);
          return reject(unavailable);
        },
        {
          beforeAck: async (bridge) => {
            await bridge.stop();
            release();
          },
        },
      );
      expect(finals()).toHaveLength(1);
      expect(finals()[0].properties).toMatchObject({
        outcome: "incomplete",
        reason: "stopped",
      });
      expect(causeKeys(finals()[0].properties)).toEqual([]);
    });

    it("keeps interleaved invocations' causes separate", async () => {
      let arrived = 0;
      let release!: () => void;
      const both = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          const { receipt: v1, cause: v2 } = channels(call);
          const commandId = (call.message as { commandId: string }).commandId;
          if (commandId === "reset") v2.onmessage!(cause);
          if (++arrived === 2) release();
          await both;
          v1.onmessage!(receipt);
          if (commandId === "eof")
            v2.onmessage!({
              ...cause,
              ioKind: "unexpected_eof",
              sourceDepth: 4,
            });
          return reject(unavailable);
        },
        { commandIds: ["reset", "eof", "v1-only"] },
      );
      const byCommand = Object.fromEntries(
        finals().map((event) => [
          event.properties!.commandId,
          event.properties,
        ]),
      );
      expect(byCommand.reset).toMatchObject(causeGroup);
      expect(byCommand.eof).toMatchObject({
        native_authorization_cause_io_kind: "unexpected_eof",
        native_authorization_cause_source_depth: 4,
      });
      expect(nativeKeys(byCommand["v1-only"])).toHaveLength(8);
      expect(causeKeys(byCommand["v1-only"])).toEqual([]);
    });

    it("keeps the v1 channel when only the cause channel cannot be created", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      const create = jest.mocked(Channel).getMockImplementation()!;
      jest
        .mocked(Channel)
        .mockImplementationOnce(create)
        .mockImplementationOnce(() => {
          throw new Error("channel unavailable");
        });
      const { calls } = await run((call) => {
        channels(call).receipt.onmessage!(receipt);
        return reject(unavailable);
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveProperty("onAuthorizationDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationCauseDiagnostic");
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(causeKeys(finals()[0].properties)).toEqual([]);
    });
  });

  it.each<
    [string, Parameters<typeof run>[1], (call: NativeCall) => Promise<unknown>]
  >([
    [
      "a published legacy native app",
      { version: "0.0.72" },
      async (call) =>
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 }),
    ],
    [
      "a native app missing the authorized command",
      {},
      async (call) => {
        if (call.cmd === "execute_authorized_stream_command")
          throw new Error(
            "Command execute_authorized_stream_command not found",
          );
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      },
    ],
    [
      "the unacknowledged output path",
      { acknowledged: false },
      async (call) =>
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 }),
    ],
  ])(
    "never sends the optional channel through %s",
    async (_case, options, native) => {
      const { Channel } = await import("@tauri-apps/api/core");
      const { calls } = await run(native, options);
      // Only a possible authorized acknowledged invocation constructs the
      // optional receipt and cause channels besides the output channel.
      expect(jest.mocked(Channel)).toHaveBeenCalledTimes(
        options?.version || options?.acknowledged === false ? 1 : 3,
      );
      const legacy = calls.filter(
        (call) => call.cmd === "execute_stream_command",
      );
      const authorized = calls.filter(
        (call) => call.cmd === "execute_authorized_stream_command",
      );
      if (options?.acknowledged === false) {
        expect(authorized).toHaveLength(1);
        expect(authorized[0]).not.toHaveProperty("onAuthorizationDiagnostic");
        expect(authorized[0]).not.toHaveProperty(
          "onAuthorizationCauseDiagnostic",
        );
      } else {
        expect(legacy).toHaveLength(1);
        expect(legacy[0]).toHaveProperty("onEvent");
        expect(legacy[0]).not.toHaveProperty("onAuthorizationDiagnostic");
        expect(legacy[0]).not.toHaveProperty("onAuthorizationCauseDiagnostic");
        expect(authorized).toHaveLength(options?.version ? 0 : 1);
      }
    },
  );
});
