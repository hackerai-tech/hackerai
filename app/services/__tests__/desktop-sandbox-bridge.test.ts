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
  getPermittedAnalyticsUserId,
} from "@/lib/analytics/client";
import type * as TauriCore from "@tauri-apps/api/core";
import { DesktopRelayTelemetry } from "@/lib/analytics/desktop-relay";
import { sanitizeDesktopAckEvent } from "@/lib/analytics/desktop-ack-privacy";
import {
  applyDesktopRuntimeIdentity,
  startDesktopRuntimeIdentityLookup,
} from "@/lib/analytics/desktop-runtime-identity";
import { DESKTOP_TERMINAL_ERROR_PROPERTIES } from "@/lib/analytics/desktop-terminal-error-diagnostics";
import {
  DESKTOP_INVOCATION_ADMISSION_PROPERTIES,
  DESKTOP_INVOCATION_REJECTION_PROPERTIES,
  DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES,
  DESKTOP_INVOCATION_UNKNOWN_PROPERTIES,
} from "@/lib/analytics/desktop-invocation-rejection-diagnostics";
import {
  NATIVE_AUTHORIZATION_CAUSE_PROPERTIES,
  NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES,
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  NATIVE_AUTHORIZATION_IO_PROPERTIES,
  NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES,
  NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES,
} from "@/lib/analytics/native-authorization-diagnostics";
import { LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS } from "@/lib/centrifugo/presence";
import {
  beginConvexAuthTokenDecision,
  createConvexAuthTokenDecisionOwner,
  publishConvexAuthProviderState,
} from "@/lib/auth/convex-auth-diagnostics";

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
  getPermittedAnalyticsUserId: jest.fn().mockReturnValue("user-456"),
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

// ── operation readiness diagnostics ───────────────────────────────────

describe("operation readiness failure diagnostics", () => {
  const connectionId = "0193a5b2-7c41-7a10-8f00-111111111111";
  const commandId = "0193a5b2-7c41-7a10-8f00-222222222222";
  const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  const readinessEvents = () =>
    jest
      .mocked(captureAuthenticatedEvent)
      .mock.calls.filter(
        ([event, properties]) =>
          event === "desktop_bridge_relay_error" &&
          properties?.errorType === "operation_readiness",
      );

  beforeEach(() => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "A".repeat(40);
    jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-456");
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-456");
  });

  afterEach(() => {
    if (originalBuild === undefined)
      delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    else process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuild;
    jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-456");
    jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-456");
  });

  async function startWithOperation(
    configure: (operation: typeof mockSubscription) => void,
  ) {
    const bridge = new DesktopSandboxBridge(
      buildConfig({
        connectDesktop: jest.fn().mockResolvedValue({
          connectionId,
          centrifugoToken: createTestJwt("user-456"),
          centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
        }),
      }),
    );
    await bridge.start();
    const operation = {
      ...mockSubscription,
      on: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      removeAllListeners: jest.fn(),
      publish: jest.fn().mockResolvedValue(undefined),
      ready: jest.fn().mockResolvedValue(undefined),
    };
    configure(operation);
    mockClient.newSubscription.mockReturnValueOnce(operation);
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const deliver = () =>
      getPublicationHandler()({
        data: {
          type: "command",
          commandId,
          command: "cat /home/PRIVATE/secret.txt",
          cwd: "/home/PRIVATE",
          targetConnectionId: connectionId,
          operationChannel: true,
        },
      });
    return { bridge, operation, consoleError, deliver };
  }

  it.each([
    [
      "subscription_ready",
      "subscription_unsubscribed",
      (operation: typeof mockSubscription) =>
        operation.ready.mockRejectedValue(
          Object.assign(new Error("PRIVATE ready reason"), { code: 7 }),
        ),
    ],
    [
      "readiness_publish",
      "transport_closed",
      // The relay client's plain-object rejection, wrapped by the publish queue.
      (operation: typeof mockSubscription) =>
        operation.publish.mockRejectedValue({
          code: 2,
          message: "PRIVATE publish",
        }),
    ],
  ] as const)(
    "reports one bounded %s failure on the existing relay error event",
    async (phase, rejectionCode, configure) => {
      const { bridge, operation, consoleError, deliver } =
        await startWithOperation(configure);
      try {
        deliver();
        await waitFor(() =>
          expect(consoleError).toHaveBeenCalledWith(
            "[DesktopSandboxBridge] Operation subscription failed:",
            expect.any(Error),
          ),
        );
        expect(readinessEvents()).toEqual([
          [
            "desktop_bridge_relay_error",
            {
              state: "error",
              clientSurface: "desktop_bridge",
              source: "operation_channel",
              errorType: "operation_readiness",
              connectionId,
              operation_readiness_version: 1,
              operation_readiness_phase: phase,
              operation_readiness_kind: "command",
              operation_readiness_operation_id: commandId,
              operation_readiness_rejection_code: rejectionCode,
              build_state: "measured",
              hackerai_frontend_build_commit: "a".repeat(40),
            },
          ],
        ]);
        expect(JSON.stringify(readinessEvents())).not.toMatch(/PRIVATE/);
        // The failed start was neither executed nor retried on redelivery.
        expect(mockClient.removeSubscription).toHaveBeenCalledWith(operation);
        deliver();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(
          mockClient.newSubscription.mock.calls.filter(([channel]) =>
            String(channel).startsWith("sandbox:operation:"),
          ),
        ).toHaveLength(1);
        expect(readinessEvents()).toHaveLength(1);
        const { invoke } = jest.requireMock<typeof TauriCore>(
          "@tauri-apps/api/core",
        );
        expect(
          jest
            .mocked(invoke)
            .mock.calls.filter(([command]) =>
              [
                "execute_authorized_stream_command",
                "execute_stream_command",
              ].includes(command),
            ),
        ).toEqual([]);
      } finally {
        consoleError.mockRestore();
        await bridge.stop();
      }
    },
  );

  it.each([
    [
      "the analytics owner switched accounts",
      () => {
        jest.mocked(getPermittedAnalyticsUserId).mockReturnValue("user-other");
        jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue("user-other");
      },
    ],
    [
      "identification was withdrawn",
      () => jest.mocked(getIdentifiedAnalyticsUserId).mockReturnValue(null),
    ],
    [
      "consent was withdrawn",
      () => jest.mocked(getPermittedAnalyticsUserId).mockReturnValue(null),
    ],
  ])("does not report when %s", async (_name, change) => {
    const { bridge, consoleError, deliver } = await startWithOperation(
      (operation) => operation.ready.mockRejectedValue(new Error("denied")),
    );
    try {
      change();
      deliver();
      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(readinessEvents()).toEqual([]);
    } finally {
      consoleError.mockRestore();
      await bridge.stop();
    }
  });

  it("does not report a readiness rejection that settles after the bridge stopped", async () => {
    let reject!: (error: Error) => void;
    const { bridge, operation, consoleError, deliver } =
      await startWithOperation((operation) =>
        operation.ready.mockReturnValue(
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
        ),
      );
    try {
      deliver();
      await waitFor(() => expect(operation.ready).toHaveBeenCalled());
      await bridge.stop();
      reject(new Error("unsubscribed"));
      await waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(readinessEvents()).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
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

  it("reports only validated native lifecycle fields and keeps the registration OS shape", async () => {
    const original = mockInvokeHandler;
    const valid = {
      launchId: "0123456789abcdef0123456789abcdef",
      previousExit: "unclean",
      previousWebProcessTermination: "memory_limit",
      pageGeneration: 2,
      webProcessTermination: "crashed",
    };
    let lifecycle: unknown = valid;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "plugin:app|version") return "0.0.81";
      if (cmd === "get_desktop_os_info")
        return {
          platform: "linux",
          arch: "x64",
          release: "6.8.0",
          hostname: "qa-host",
          ...(lifecycle === undefined ? {} : { lifecycle }),
        };
      return original(cmd, args);
    };
    // A fresh bridge per case keeps its relay telemetry's first event immediate.
    const relayPropertiesAfterStart = async () => {
      jest.mocked(captureAuthenticatedEvent).mockClear();
      mockSubscription.on.mockClear();
      const config = buildConfig();
      const bridge = new DesktopSandboxBridge(config);
      try {
        await bridge.start();
        // The backend validator accepts exactly these four OS fields.
        expect(config.connectDesktop).toHaveBeenCalledWith(
          expect.objectContaining({
            osInfo: {
              platform: "linux",
              arch: "x64",
              release: "6.8.0",
              hostname: "qa-host",
            },
          }),
        );
        getSubscriptionHandler("subscribed")({
          recovered: false,
          wasRecovering: false,
        });
        const relay = jest
          .mocked(captureAuthenticatedEvent)
          .mock.calls.find(
            ([event, properties]) =>
              event === "desktop_bridge_relay_state_changed" &&
              properties?.source === "subscription",
          );
        expect(relay).toBeDefined();
        return relay![1] as Record<string, unknown>;
      } finally {
        await bridge.stop();
      }
    };
    try {
      expect(await relayPropertiesAfterStart()).toEqual(
        expect.objectContaining({
          native_launch_id: valid.launchId,
          native_previous_exit: "unclean",
          native_previous_web_process_termination: "memory_limit",
          native_page_generation: 2,
          native_web_process_termination: "crashed",
        }),
      );
      for (const invalid of [
        undefined, // older native binaries
        null,
        { ...valid, launchId: "/home/user/project" },
        { ...valid, previousExit: "crash" },
        { ...valid, previousWebProcessTermination: "/home/user/project" },
        { ...valid, previousWebProcessTermination: undefined },
        { ...valid, pageGeneration: -1 },
        { ...valid, pageGeneration: 1.5 },
        { ...valid, webProcessTermination: "https://target.example/" },
      ]) {
        lifecycle = invalid;
        const properties = await relayPropertiesAfterStart();
        expect(
          Object.keys(properties).filter((key) =>
            /^native_(launch_id|previous_exit|previous_web_process_termination|page_generation|web_process_termination)$/.test(
              key,
            ),
          ),
        ).toEqual([]);
      }
    } finally {
      mockInvokeHandler = original;
    }
  });

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

  describe("provider provenance", () => {
    const PROVIDER_STATES = [
      "owner_absent",
      "authkit_loading",
      "token_recovery",
      "authkit_loading_and_token_recovery",
      "ready",
      "unavailable",
    ];
    const convexFunction = (path: "heartbeat" | "token refresh") =>
      path === "heartbeat"
        ? "localSandbox:heartbeatDesktop"
        : "localSandbox:refreshCentrifugoTokenDesktop";

    describe.each(["heartbeat", "token refresh"] as const)("%s", (path) => {
      it.each(PROVIDER_STATES)(
        "reports %s from callback invocation separately from the stop",
        async (state) => {
          jest.useFakeTimers();
          const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
          let provider = "ready";
          const onTerminated = jest.fn();
          // Convex loading at both reads; only provider provenance explains it.
          const config = buildConfig({
            onTerminated,
            readNativeAuthFrontendState: () => "owner_present_convex_loading",
            readNativeAuthProviderState: () => provider,
          });
          const bridge = new DesktopSandboxBridge(config);
          const later =
            PROVIDER_STATES[
              (PROVIDER_STATES.indexOf(state) + 1) % PROVIDER_STATES.length
            ];
          const error = Object.assign(
            new Error(
              `[CONVEX M(${convexFunction(path)})] [Request ID: 0123456789abcdef] Server Error`,
            ),
            UNAUTHORIZED,
          );
          try {
            await bridge.start();
            await jest.advanceTimersByTimeAsync(
              LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS,
            );
            provider = state;
            const rejectCallback = await invokePendingCallback(path, config);
            provider = later;
            await rejectCallback(error);

            expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
            expect(bridge.getConnectionId()).toBeNull();
            expect(authStopCapture(path)).toMatchObject({
              native_auth_diagnostic_version: 1,
              convex_function: convexFunction(path),
              convex_request_id: "0123456789abcdef",
              native_auth_request_state_version: 1,
              native_auth_request_frontend_state:
                "owner_present_convex_loading",
              native_auth_frontend_state: "owner_present_convex_loading",
              native_auth_provider_state_version: 1,
              native_auth_request_provider_state: state,
              native_auth_provider_state: later,
            });
            expect(nativeAuthCaptures()).toHaveLength(1);
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
        ["private string", () => "private-session-canary"],
        ["near-miss string", () => "READY"],
        ["boxed string", () => new String("ready")],
        ["object", () => ({ state: "ready" })],
        [
          "coercing object",
          () => ({
            toString: () => {
              throw new Error("private-coercion-canary");
            },
            [Symbol.toPrimitive]: () => {
              throw new Error("private-coercion-canary");
            },
          }),
        ],
        [
          "getter object",
          () =>
            Object.defineProperty({}, "state", {
              enumerable: true,
              get: () => {
                throw new Error("private-getter-canary");
              },
            }),
        ],
      ])(
        "reports unavailable for a %s provider reader without changing the stop",
        async (_label, readNativeAuthProviderState) => {
          jest.useFakeTimers();
          const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
          const onTerminated = jest.fn();
          const config = buildConfig({
            onTerminated,
            readNativeAuthFrontendState: () =>
              "owner_present_convex_authenticated",
            ...(readNativeAuthProviderState && { readNativeAuthProviderState }),
          });
          const bridge = new DesktopSandboxBridge(config);
          try {
            await bridge.start();
            const rejectCallback = await invokePendingCallback(path, config);
            await rejectCallback(UNAUTHORIZED);

            expect(onTerminated).toHaveBeenCalledTimes(1);
            expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
            expect(bridge.getConnectionId()).toBeNull();
            expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
            // A broken provider reader must not erase the existing fields.
            expect(authStopCapture(path)).toMatchObject({
              native_auth_request_frontend_state:
                "owner_present_convex_authenticated",
              native_auth_frontend_state: "owner_present_convex_authenticated",
              native_auth_provider_state_version: 1,
              native_auth_request_provider_state: "unavailable",
              native_auth_provider_state: "unavailable",
            });
            const captured = JSON.stringify(
              [
                jest.mocked(captureAuthenticatedEvent).mock.calls,
                warn.mock.calls,
              ],
              (_key, value: unknown) =>
                value instanceof Error
                  ? { message: value.message, stack: value.stack }
                  : value,
            );
            expect(captured).not.toContain("canary");
            expect(captured).not.toContain("READY");
          } finally {
            await bridge.stop();
            jest.useRealTimers();
            warn.mockRestore();
          }
        },
      );
    });

    it("attributes a heartbeat follow-up auth failure to the token callback's provider state", async () => {
      jest.useFakeTimers();
      let provider = "authkit_loading";
      const onTerminated = jest.fn();
      const config = buildConfig({
        onTerminated,
        readNativeAuthProviderState: () => provider,
      });
      const bridge = new DesktopSandboxBridge(config);
      let resolveHeartbeat!: (value: { success: boolean }) => void;
      let rejectToken!: (reason: unknown) => void;
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
        await jest.advanceTimersByTimeAsync(
          LOCAL_SANDBOX_HEARTBEAT_INTERVAL_MS,
        );
        provider = "token_recovery";
        resolveHeartbeat({ success: false });
        await jest.advanceTimersByTimeAsync(0);
        expect(config.refreshCentrifugoTokenDesktop).toHaveBeenCalled();
        provider = "owner_absent";
        rejectToken(UNAUTHORIZED);
        await jest.advanceTimersByTimeAsync(0);

        expect(onTerminated).toHaveBeenCalledTimes(1);
        expect(nativeAuthCaptures()).toEqual([
          [
            "desktop_bridge_relay_state_changed",
            expect.objectContaining({
              reason: "heartbeat_unauthenticated",
              convex_function: "localSandbox:refreshCentrifugoTokenDesktop",
              native_auth_request_provider_state: "token_recovery",
              native_auth_provider_state: "owner_absent",
            }),
          ],
        ]);
      } finally {
        resolveHeartbeat?.({ success: true });
        await bridge.stop();
        jest.useRealTimers();
      }
    });
  });

  describe("token decision provenance", () => {
    const UNAVAILABLE_TOKEN_FIELDS = {
      native_auth_token_decision_version: 1,
      native_auth_request_token_mode: "unavailable",
      native_auth_request_token_outcome: "unavailable",
      native_auth_request_token_result: "unavailable",
      native_auth_request_token_age: "unavailable",
      native_auth_request_token_context: "unavailable",
      native_auth_token_mode: "unavailable",
      native_auth_token_outcome: "unavailable",
      native_auth_token_result: "unavailable",
      native_auth_token_age: "unavailable",
      native_auth_token_context: "unavailable",
      native_auth_token_attempt: "unavailable",
    };

    // Every reported token field, so no unlisted or identity field can pass.
    function tokenFields(path: "heartbeat" | "token refresh") {
      return Object.fromEntries(
        Object.entries(authStopCapture(path) ?? {}).filter(([key]) =>
          /^native_auth_(request_)?token_/.test(key),
        ),
      );
    }

    describe.each(["heartbeat", "token refresh"] as const)("%s", (path) => {
      it.each([
        ["the same attempt settled", true, "same"],
        ["a newer attempt started", false, "changed"],
      ] as const)(
        "reports invocation and stop decisions when %s",
        async (_label, sameAttempt, comparison) => {
          jest.useFakeTimers();
          const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
          const requestAttempt = { private: "private-attempt-canary" };
          let decision: unknown = {
            mode: "ordinary",
            outcome: "pending",
            result: "pending",
            age: "lt_1s",
            context: "same",
            attempt: requestAttempt,
          };
          const onTerminated = jest.fn();
          const config = buildConfig({
            onTerminated,
            readNativeAuthProviderState: () => "ready",
            readNativeAuthTokenDecision: () => decision,
          });
          const bridge = new DesktopSandboxBridge(config);
          try {
            await bridge.start();
            const rejectCallback = await invokePendingCallback(path, config);
            decision = {
              mode: sameAttempt ? "ordinary" : "forced_refresh",
              outcome: sameAttempt ? "token" : "cooldown_fallback",
              result: sameAttempt ? "token" : "null",
              age: "lt_10s",
              context: "superseded",
              attempt: sameAttempt ? requestAttempt : {},
              token: "private-token-canary",
            };
            await rejectCallback(UNAUTHORIZED);

            expect(onTerminated).toHaveBeenCalledTimes(1);
            expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
            expect(bridge.getConnectionId()).toBeNull();
            expect(authStopCapture(path)).toMatchObject({
              native_auth_request_provider_state: "ready",
              native_auth_provider_state: "ready",
            });
            expect(tokenFields(path)).toEqual({
              native_auth_token_decision_version: 1,
              native_auth_request_token_mode: "ordinary",
              native_auth_request_token_outcome: "pending",
              native_auth_request_token_result: "pending",
              native_auth_request_token_age: "lt_1s",
              native_auth_request_token_context: "same",
              native_auth_token_mode: sameAttempt
                ? "ordinary"
                : "forced_refresh",
              native_auth_token_outcome: sameAttempt
                ? "token"
                : "cooldown_fallback",
              native_auth_token_result: sameAttempt ? "token" : "null",
              native_auth_token_age: "lt_10s",
              native_auth_token_context: "superseded",
              native_auth_token_attempt: comparison,
            });
            expect(nativeAuthCaptures()).toHaveLength(1);
            expect(
              JSON.stringify([
                jest.mocked(captureAuthenticatedEvent).mock.calls,
                warn.mock.calls,
              ]),
            ).not.toContain("canary");
          } finally {
            await bridge.stop();
            jest.useRealTimers();
            warn.mockRestore();
          }
        },
      );

      it("reads the committed provider's decision when no reader is configured", async () => {
        jest.useFakeTimers();
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        const owner = createConvexAuthTokenDecisionOwner();
        const clear = publishConvexAuthProviderState("ready", owner);
        const config = buildConfig({ onTerminated: jest.fn() });
        const bridge = new DesktopSandboxBridge(config);
        try {
          await bridge.start();
          const settle = beginConvexAuthTokenDecision(owner, "ordinary", true);
          const rejectCallback = await invokePendingCallback(path, config);
          settle("token", true);
          await rejectCallback(UNAUTHORIZED);

          expect(tokenFields(path)).toEqual({
            ...UNAVAILABLE_TOKEN_FIELDS,
            native_auth_request_token_mode: "ordinary",
            native_auth_request_token_outcome: "pending",
            native_auth_request_token_result: "pending",
            native_auth_token_result: "token",
            // The heartbeat timer fires one interval after the attempt began.
            native_auth_request_token_age:
              path === "heartbeat" ? "lt_1m" : "lt_1s",
            native_auth_request_token_context: "same",
            native_auth_token_mode: "ordinary",
            native_auth_token_outcome: "token",
            native_auth_token_age: "lt_1s",
            native_auth_token_context: "same",
            native_auth_token_attempt: "same",
          });
        } finally {
          clear();
          await bridge.stop();
          jest.useRealTimers();
          warn.mockRestore();
        }
      });

      it.each([
        ["no committed provider", undefined],
        [
          "throwing",
          () => {
            throw new Error("private-reader-canary");
          },
        ],
        ["private string", () => "private-token-canary"],
        [
          "malformed",
          () => ({
            mode: "ordinary",
            outcome: "private-error-canary",
            age: "lt_1s",
            context: "same",
            attempt: {},
          }),
        ],
        [
          "getter object",
          () =>
            Object.defineProperty({}, "outcome", {
              enumerable: true,
              get: () => {
                throw new Error("private-getter-canary");
              },
            }),
        ],
      ])(
        "reports an unmeasured decision for a %s reader without changing the stop",
        async (_label, readNativeAuthTokenDecision) => {
          jest.useFakeTimers();
          const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
          const onTerminated = jest.fn();
          const config = buildConfig({
            onTerminated,
            ...(readNativeAuthTokenDecision && { readNativeAuthTokenDecision }),
          });
          const bridge = new DesktopSandboxBridge(config);
          try {
            await bridge.start();
            const rejectCallback = await invokePendingCallback(path, config);
            await rejectCallback(UNAUTHORIZED);

            expect(onTerminated).toHaveBeenCalledTimes(1);
            expect(onTerminated).toHaveBeenCalledWith("unauthenticated");
            expect(bridge.getConnectionId()).toBeNull();
            expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
            expect(tokenFields(path)).toEqual(UNAVAILABLE_TOKEN_FIELDS);
            expect(
              JSON.stringify(
                [
                  jest.mocked(captureAuthenticatedEvent).mock.calls,
                  warn.mock.calls,
                ],
                (_key, value: unknown) =>
                  value instanceof Error
                    ? { message: value.message, stack: value.stack }
                    : value,
              ),
            ).not.toContain("canary");
          } finally {
            await bridge.stop();
            jest.useRealTimers();
            warn.mockRestore();
          }
        },
      );
    });
  });

  describe("registration before a connection ID", () => {
    function registrationCaptures() {
      return jest
        .mocked(captureAuthenticatedEvent)
        .mock.calls.filter(
          ([event, properties]) =>
            event === "desktop_bridge_relay_error" &&
            properties?.source === "registration",
        );
    }

    function withNativeVersion(version: string) {
      const original = mockInvokeHandler;
      mockInvokeHandler = async (cmd, args) =>
        cmd === "plugin:app|version" ? version : original(cmd, args);
    }

    it("records an authentication rejection and rethrows the same error", async () => {
      withNativeVersion("0.0.74");
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const error = Object.assign(
        new Error(
          "[CONVEX M(localSandbox:connectDesktop)] [Request ID: 0123456789abcdef] Server Error: private-error-canary",
        ),
        UNAUTHORIZED,
      );
      let frontend = "owner_present_convex_authenticated";
      let provider = "ready";
      const requestAttempt = {};
      let decision: unknown = {
        mode: "ordinary",
        outcome: "token",
        result: "token",
        age: "lt_10s",
        context: "same",
        attempt: requestAttempt,
      };
      const onTerminated = jest.fn();
      const config = buildConfig({
        onTerminated,
        readNativeAuthFrontendState: () => frontend,
        readNativeAuthProviderState: () => provider,
        readNativeAuthTokenDecision: () => decision,
        connectDesktop: jest.fn(async () => {
          // State changes while registration is pending.
          frontend = "owner_present_convex_loading";
          provider = "token_recovery";
          decision = {
            mode: "forced_refresh",
            outcome: "exception_fallback",
            result: "null",
            age: "lt_1s",
            context: "same",
            attempt: {},
          };
          throw error;
        }),
      });
      const bridge = new DesktopSandboxBridge(config);
      try {
        await expect(bridge.start()).rejects.toBe(error);

        expect(config.connectDesktop).toHaveBeenCalledTimes(1);
        expect(config.connectDesktop).toHaveBeenCalledWith({
          connectionName: "test-host",
          osInfo: {
            platform: "darwin",
            release: "24.0.0",
            arch: "arm64",
            hostname: "test-host",
          },
          capabilities: {
            commands: true,
            pty: true,
            files: true,
            operationChannels: true,
          },
        });
        expect(registrationCaptures()).toEqual([
          [
            "desktop_bridge_relay_error",
            {
              connectionId: null,
              clientSurface: "desktop_bridge",
              state: "error",
              reconnectAttempt: 0,
              source: "registration",
              errorType: "unauthenticated",
              native_app_version: "0.0.74",
              native_platform: "darwin",
              native_auth_diagnostic_version: 1,
              heartbeat_backpressure_version: 1,
              convex_function: "localSandbox:connectDesktop",
              convex_request_id: "0123456789abcdef",
              native_auth_request_state_version: 1,
              native_auth_request_frontend_state:
                "owner_present_convex_authenticated",
              native_auth_frontend_state: "owner_present_convex_loading",
              native_auth_provider_state_version: 1,
              native_auth_request_provider_state: "ready",
              native_auth_provider_state: "token_recovery",
              native_auth_token_decision_version: 1,
              native_auth_request_token_mode: "ordinary",
              native_auth_request_token_outcome: "token",
              native_auth_request_token_result: "token",
              native_auth_request_token_age: "lt_10s",
              native_auth_request_token_context: "same",
              native_auth_token_mode: "forced_refresh",
              native_auth_token_outcome: "exception_fallback",
              native_auth_token_result: "null",
              native_auth_token_age: "lt_1s",
              native_auth_token_context: "same",
              native_auth_token_attempt: "changed",
              telemetry_version: 2,
              telemetry_occurrences: 1,
              telemetry_summary: false,
              telemetry_window_started_at: expect.any(String),
              telemetry_last_seen_at: expect.any(String),
            },
          ],
        ]);
        // Observation only: no stop, retry, relay or second registration.
        expect(onTerminated).not.toHaveBeenCalled();
        expect(config.disconnectDesktop).not.toHaveBeenCalled();
        expect(config.heartbeatDesktop).not.toHaveBeenCalled();
        expect(mockClient.connect).not.toHaveBeenCalled();
        expect(bridge.getConnectionId()).toBeNull();
        expect(
          JSON.stringify([
            jest.mocked(captureAuthenticatedEvent).mock.calls,
            warn.mock.calls,
          ]),
        ).not.toContain("canary");
      } finally {
        await bridge.stop();
        warn.mockRestore();
      }
    });

    it("omits a request ID formatted for another function", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const error = Object.assign(
        new Error(
          "[CONVEX M(localSandbox:heartbeatDesktop)] [Request ID: 0123456789abcdef] Server Error",
        ),
        UNAUTHORIZED,
      );
      const config = buildConfig({
        connectDesktop: jest.fn().mockRejectedValue(error),
      });
      const bridge = new DesktopSandboxBridge(config);
      try {
        await expect(bridge.start()).rejects.toBe(error);
        const [[, properties]] = registrationCaptures();
        expect(properties).toMatchObject({
          convex_function: "localSandbox:connectDesktop",
          native_app_version: "unknown",
          native_auth_request_frontend_state: "unavailable",
          native_auth_request_provider_state: "unavailable",
          native_auth_request_token_mode: "unavailable",
          native_auth_token_attempt: "unavailable",
        });
        expect(properties).not.toHaveProperty("convex_request_id");
      } finally {
        await bridge.stop();
        warn.mockRestore();
      }
    });

    it("records nothing for a successful registration", async () => {
      const config = buildConfig({
        readNativeAuthFrontendState: () => "owner_present_convex_authenticated",
      });
      const bridge = new DesktopSandboxBridge(config);
      try {
        await expect(bridge.start()).resolves.toBe("conn-123");
        expect(config.connectDesktop).toHaveBeenCalledTimes(1);
        expect(registrationCaptures()).toEqual([]);
        expect(nativeAuthCaptures()).toEqual([]);
      } finally {
        await bridge.stop();
      }
    });

    it("records nothing for a non-authentication registration failure", async () => {
      const error = new Error("offline");
      const config = buildConfig({
        connectDesktop: jest.fn().mockRejectedValue(error),
      });
      const bridge = new DesktopSandboxBridge(config);
      try {
        await expect(bridge.start()).rejects.toBe(error);
        expect(config.connectDesktop).toHaveBeenCalledTimes(1);
        expect(registrationCaptures()).toEqual([]);
        expect(nativeAuthCaptures()).toEqual([]);
      } finally {
        await bridge.stop();
      }
    });

    it.each([false, true])(
      "records nothing for an authentication rejection after startup was stopped (restart=%s)",
      async (restart) => {
        let rejectConnect!: (reason: unknown) => void;
        let enteredConnect!: () => void;
        const entered = new Promise<void>((resolve) => {
          enteredConnect = resolve;
        });
        const config = buildConfig({
          connectDesktop: jest
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((_resolve, reject) => {
                  rejectConnect = reject;
                  enteredConnect();
                }),
            )
            .mockResolvedValue({
              connectionId: "new-connection",
              centrifugoToken: createTestJwt("user-456"),
              centrifugoWsUrl: "ws://localhost:8000/connection/websocket",
            }),
        });
        const bridge = new DesktopSandboxBridge(config);
        const first = bridge.start();
        try {
          await entered;
          await bridge.stop();
          if (restart) await bridge.start();
          rejectConnect(UNAUTHORIZED);
          await expect(first).rejects.toBe(UNAUTHORIZED);

          expect(config.connectDesktop).toHaveBeenCalledTimes(restart ? 2 : 1);
          expect(registrationCaptures()).toEqual([]);
          expect(nativeAuthCaptures()).toEqual([]);
          expect(config.disconnectDesktop).not.toHaveBeenCalled();
          expect(bridge.getConnectionId()).toBe(
            restart ? "new-connection" : null,
          );
        } finally {
          await bridge.stop();
        }
      },
    );
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

describe("file_stat receiver diagnostics", () => {
  const PRIVATE_PATH = "C:\\Users\\private\\secret.txt";
  const statMessage = (requestId: string) => ({
    type: "file_stat",
    requestId,
    path: PRIVATE_PATH,
    targetConnectionId: "conn-123",
    authorizationId: "private-authorization",
  });
  const legacyRequest = {
    request: { path: PRIVATE_PATH, type: "file_stat" },
  };

  /** Starts the real bridge as a given installed binary, then swaps stat-time IPC. */
  async function startAs(
    version: string,
    onStat: (cmd: string) => Promise<unknown> | undefined,
  ) {
    mockUseAuthorizedNative = true;
    const original = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) =>
      cmd === "plugin:app|version" ? version : original(cmd, args);
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    mockInvokeHandler = async (cmd, args) => onStat(cmd) ?? original(cmd, args);
    mockSubscription.publish.mockClear();
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as jest.Mock).mockClear();
    return { bridge, invoke: invoke as jest.Mock };
  }

  const fileErrors = () =>
    mockSubscription.publish.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "file_error");

  const reject = (message: string) => Promise.reject(new Error(message));
  const notFound = (cmd: string) => reject(`Command ${cmd} not found`);
  const loopbackInfo = { port: 49152, token: "PRIVATE_LOOPBACK_TOKEN" };

  it.each([
    {
      // Production 0.0.71 Windows shape: an unclassified native rejection.
      name: "published legacy native invoke",
      version: "0.0.71",
      onStat: (cmd: string) =>
        cmd === "desktop_file_request"
          ? reject("PRIVATE unexpected native failure")
          : undefined,
      error: { message: "PRIVATE unexpected native failure" },
      diagnostic: {
        stage: "native_invoke",
        adapter: "published_legacy_native",
        nativeVersionLookup: "resolved_published_legacy",
      },
      ipc: [["desktop_file_request", legacyRequest]],
    },
    {
      name: "authorized native invoke",
      version: "0.0.74",
      onStat: (cmd: string) =>
        cmd === "authorized_desktop_file_request"
          ? reject("Desktop operation was not authorized")
          : undefined,
      error: { message: "Desktop operation was not authorized" },
      diagnostic: {
        stage: "native_invoke",
        adapter: "authorized_native",
        nativeVersionLookup: "resolved_other",
      },
      ipc: [
        [
          "authorized_desktop_file_request",
          {
            authorizationId: "private-authorization",
            message: statMessage("stat-diagnostic"),
          },
        ],
      ],
    },
    {
      name: "compatibility native invoke",
      version: "0.0.0",
      onStat: (cmd: string) =>
        cmd === "authorized_desktop_file_request"
          ? notFound(cmd)
          : cmd === "desktop_file_request"
            ? reject("PRIVATE compatibility failure")
            : undefined,
      error: { message: "PRIVATE compatibility failure" },
      diagnostic: {
        stage: "native_invoke",
        adapter: "compatibility_native",
        nativeVersionLookup: "resolved_other",
      },
      ipc: [
        [
          "authorized_desktop_file_request",
          {
            authorizationId: "private-authorization",
            message: statMessage("stat-diagnostic"),
          },
        ],
        ["desktop_file_request", legacyRequest],
      ],
    },
    {
      name: "loopback server info",
      version: "0.0.71",
      onStat: (cmd: string) =>
        cmd === "desktop_file_request"
          ? notFound(cmd)
          : cmd === "get_cmd_server_info"
            ? reject("PRIVATE server info failure")
            : undefined,
      error: { message: "PRIVATE server info failure" },
      // The native attempt that fell back to loopback consulted the lookup.
      diagnostic: {
        stage: "loopback_info",
        adapter: "legacy_loopback",
        nativeVersionLookup: "resolved_published_legacy",
      },
    },
    {
      name: "loopback setup",
      version: "0.0.71",
      onStat: (cmd: string) =>
        cmd === "desktop_file_request"
          ? notFound(cmd)
          : cmd === "get_cmd_server_info"
            ? Promise.resolve({ port: 0, token: "" })
            : undefined,
      error: {
        message: expect.stringContaining("file server is not ready"),
        fileFailure: "legacy_http_rejected",
      },
      diagnostic: {
        stage: "loopback_setup",
        adapter: "legacy_loopback",
        nativeVersionLookup: "resolved_published_legacy",
      },
    },
    {
      name: "loopback request",
      version: "0.0.71",
      onStat: (cmd: string) =>
        cmd === "desktop_file_request"
          ? notFound(cmd)
          : cmd === "get_cmd_server_info"
            ? Promise.resolve(loopbackInfo)
            : undefined,
      loopback: () => Promise.reject(new TypeError("Load failed")),
      error: {
        message: expect.stringContaining("transport failed (legacy_http"),
        fileFailure: "legacy_http_transport",
      },
      diagnostic: {
        stage: "loopback_request",
        adapter: "legacy_loopback",
        nativeVersionLookup: "resolved_published_legacy",
      },
    },
    {
      name: "loopback response",
      version: "0.0.71",
      onStat: (cmd: string) =>
        cmd === "desktop_file_request"
          ? notFound(cmd)
          : cmd === "get_cmd_server_info"
            ? Promise.resolve(loopbackInfo)
            : undefined,
      loopback: () =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: "PRIVATE server rejection" }),
        }),
      error: {
        message: "PRIVATE server rejection",
        fileFailure: "legacy_http_rejected",
      },
      diagnostic: {
        stage: "loopback_response",
        adapter: "legacy_loopback",
        nativeVersionLookup: "resolved_published_legacy",
      },
    },
    {
      name: "stat reply validation",
      version: "0.0.74",
      onStat: (cmd: string) =>
        cmd === "authorized_desktop_file_request"
          ? Promise.resolve({ kind: "PRIVATE", path: PRIVATE_PATH })
          : undefined,
      error: {
        message: "Desktop file bridge returned an invalid stat payload",
        fileFailure: "invalid_response",
      },
      diagnostic: {
        stage: "stat_reply_validation",
        adapter: "authorized_native",
        nativeVersionLookup: "resolved_other",
      },
    },
  ])(
    "adds only the closed stage after a $name failure",
    async ({ version, onStat, loopback, error, diagnostic, ipc }) => {
      global.fetch = jest.fn(
        loopback ?? (() => Promise.reject(new Error("unexpected fetch"))),
      ) as unknown as typeof global.fetch;
      const { bridge, invoke } = await startAs(version, onStat);
      try {
        const data = statMessage("stat-diagnostic");
        getPublicationHandler()({ data });
        await waitFor(() => expect(fileErrors()).toHaveLength(1));

        // Original message/cause unchanged; the diagnostic is the only addition.
        expect(fileErrors()[0]).toEqual({
          type: "file_error",
          requestId: "stat-diagnostic",
          ...error,
          receiverDiagnostic: { version: 1, ...diagnostic },
        });
        expect(data).toEqual(statMessage("stat-diagnostic"));
        if (ipc) {
          const fileIpc = invoke.mock.calls.filter(([cmd]) =>
            String(cmd).includes("desktop_file_request"),
          );
          expect(fileIpc).toEqual(ipc);
        }
        expect(mockSubscription.publish).toHaveBeenCalledTimes(1);
      } finally {
        await bridge.stop();
      }
    },
  );

  /** Starts with a controlled version lookup; fake timers drive its deadline. */
  async function startWithLookup(lookup: () => Promise<unknown>) {
    mockUseAuthorizedNative = true;
    const original = mockInvokeHandler;
    mockInvokeHandler = (cmd, args) =>
      cmd === "plugin:app|version" ? lookup() : original(cmd, args);
    const config = buildConfig();
    const bridge = new DesktopSandboxBridge(config);
    const started = bridge.start();
    await jest.advanceTimersByTimeAsync(499);
    // The lookup deadline is still exactly 500ms before registration proceeds.
    const registeredBeforeDeadline =
      config.connectDesktop.mock.calls.length > 0;
    await jest.advanceTimersByTimeAsync(1);
    await started;
    // Neither adapter reports a missing command, so no fallback may occur.
    mockInvokeHandler = async (cmd, args) =>
      cmd === "authorized_desktop_file_request"
        ? reject("Desktop operation was not authorized")
        : cmd === "desktop_file_request"
          ? reject("PRIVATE legacy native failure")
          : original(cmd, args);
    mockSubscription.publish.mockClear();
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as jest.Mock).mockClear();
    return { bridge, registeredBeforeDeadline, invoke: invoke as jest.Mock };
  }

  const fileIpc = (invoke: jest.Mock) =>
    invoke.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => String(cmd).includes("desktop_file_request"));

  const legacyFailure = {
    message: "PRIVATE legacy native failure",
    adapter: "published_legacy_native",
    ipc: ["desktop_file_request"],
  };
  const authorizedDenial = {
    message: "Desktop operation was not authorized",
    adapter: "authorized_native",
    ipc: ["authorized_desktop_file_request"],
  };

  it.each([
    {
      name: "the last published legacy version",
      lookup: () => Promise.resolve("0.0.72"),
      nativeVersionLookup: "resolved_published_legacy",
      deadline: false,
      ...legacyFailure,
    },
    {
      name: "the first authorized version",
      lookup: () => Promise.resolve("0.0.73"),
      nativeVersionLookup: "resolved_other",
      deadline: false,
      ...authorizedDenial,
    },
    {
      name: "a rejected lookup",
      lookup: () => reject("PRIVATE lookup failure 0.0.72"),
      nativeVersionLookup: "rejected",
      deadline: false,
      ...authorizedDenial,
    },
    {
      name: "a lookup resolving undefined",
      lookup: () => Promise.resolve(undefined),
      nativeVersionLookup: "invalid",
      deadline: false,
      ...authorizedDenial,
    },
    {
      name: "a malformed version",
      lookup: () => Promise.resolve("0.0.72-PRIVATE"),
      nativeVersionLookup: "invalid",
      deadline: false,
      ...authorizedDenial,
    },
    {
      name: "a lookup that never settles",
      lookup: () => new Promise(() => {}),
      nativeVersionLookup: "timeout",
      deadline: true,
      ...authorizedDenial,
    },
  ])(
    "records $nativeVersionLookup for $name with the unchanged adapter",
    async ({
      lookup,
      nativeVersionLookup,
      deadline,
      message,
      adapter,
      ipc,
    }) => {
      jest.useFakeTimers();
      const started = await startWithLookup(lookup);
      try {
        // Only the timed-out lookup waits for the full deadline.
        expect(started.registeredBeforeDeadline).toBe(!deadline);
        getPublicationHandler()({ data: statMessage("stat-lookup") });
        await waitFor(() => expect(fileErrors()).toHaveLength(1));

        expect(fileErrors()[0]).toEqual({
          type: "file_error",
          requestId: "stat-lookup",
          message,
          receiverDiagnostic: {
            version: 1,
            stage: "native_invoke",
            adapter,
            nativeVersionLookup,
          },
        });
        // A denial never downgrades to the legacy command.
        expect(fileIpc(started.invoke)).toEqual(ipc);
        expect(JSON.stringify(fileErrors()[0].receiverDiagnostic)).not.toMatch(
          /0\.0\.7|PRIVATE/,
        );
      } finally {
        await started.bridge.stop();
        jest.useRealTimers();
      }
    },
  );

  it("keeps a timeout when the lookup resolves a legacy version late", async () => {
    jest.useFakeTimers();
    const started = await startWithLookup(
      () => new Promise((resolve) => setTimeout(() => resolve("0.0.72"), 600)),
    );
    try {
      getPublicationHandler()({ data: statMessage("stat-before-late") });
      await waitFor(() => expect(fileErrors()).toHaveLength(1));
      // The late result settles after startup and must not change selection.
      await jest.advanceTimersByTimeAsync(200);
      getPublicationHandler()({ data: statMessage("stat-after-late") });
      await waitFor(() => expect(fileErrors()).toHaveLength(2));

      expect(fileErrors().map((error) => error.receiverDiagnostic)).toEqual([
        {
          version: 1,
          stage: "native_invoke",
          adapter: "authorized_native",
          nativeVersionLookup: "timeout",
        },
        {
          version: 1,
          stage: "native_invoke",
          adapter: "authorized_native",
          nativeVersionLookup: "timeout",
        },
      ]);
      expect(fileIpc(started.invoke)).toEqual([
        "authorized_desktop_file_request",
        "authorized_desktop_file_request",
      ]);
    } finally {
      await started.bridge.stop();
      jest.useRealTimers();
    }
  });

  it("keeps a successful stat reply and other file errors unchanged", async () => {
    const { bridge } = await startAs("0.0.74", (cmd) =>
      cmd === "authorized_desktop_file_request"
        ? Promise.resolve({ kind: "file", path: PRIVATE_PATH, sizeBytes: 3 })
        : undefined,
    );
    try {
      getPublicationHandler()({ data: statMessage("stat-ok") });
      await waitFor(() =>
        expect(mockSubscription.publish).toHaveBeenCalledWith({
          type: "file_stat_result",
          requestId: "stat-ok",
          kind: "file",
          path: PRIVATE_PATH,
          sizeBytes: 3,
        }),
      );
      mockInvokeHandler = () => reject("Read error: PRIVATE");
      getPublicationHandler()({
        data: { ...statMessage("read-error"), type: "file_read" },
      });
      await waitFor(() =>
        expect(fileErrors()).toEqual([
          {
            type: "file_error",
            requestId: "read-error",
            message: "Read error: PRIVATE",
            fileFailure: "filesystem",
          },
        ]),
      );
    } finally {
      await bridge.stop();
    }
  });

  it("attributes a failed success-reply publication without changing its result", async () => {
    const { bridge } = await startAs("0.0.71", (cmd) =>
      cmd === "desktop_file_request"
        ? Promise.resolve({ kind: "missing", path: PRIVATE_PATH })
        : undefined,
    );
    try {
      mockSubscription.publish.mockImplementationOnce(() =>
        reject("PRIVATE broker rejection"),
      );
      getPublicationHandler()({ data: statMessage("stat-reply") });
      await waitFor(() => expect(fileErrors()).toHaveLength(1));
      expect(mockSubscription.publish.mock.calls[0][0]).toEqual({
        type: "file_stat_result",
        requestId: "stat-reply",
        kind: "missing",
        path: PRIVATE_PATH,
      });
      expect(fileErrors()[0]).toEqual({
        type: "file_error",
        requestId: "stat-reply",
        message: "PRIVATE broker rejection",
        receiverDiagnostic: {
          version: 1,
          stage: "reply_publication",
          adapter: "published_legacy_native",
          nativeVersionLookup: "resolved_published_legacy",
        },
      });
    } finally {
      await bridge.stop();
      mockSubscription.publish.mockReset().mockResolvedValue(undefined);
    }
  });

  it("isolates concurrent stats and drops a failure after stop", async () => {
    let failCompatibility!: (error: Error) => void;
    let failLate!: (error: Error) => void;
    const { bridge } = await startAs("0.0.0", () => undefined);
    const compatibility = new Promise((_, rejectNative) => {
      failCompatibility = rejectNative;
    });
    let authorizedCalls = 0;
    mockInvokeHandler = async (cmd) => {
      if (cmd === "authorized_desktop_file_request") {
        authorizedCalls++;
        if (authorizedCalls === 1) throw new Error(`Command ${cmd} not found`);
        if (authorizedCalls === 2)
          throw new Error("Desktop operation was not authorized");
        return new Promise((_, rejectNative) => {
          failLate = rejectNative;
        });
      }
      if (cmd === "desktop_file_request") return compatibility;
      throw new Error(`Unexpected command: ${cmd}`);
    };
    try {
      // The first stat waits on the compatibility adapter while a second stat
      // fails on the authorized adapter; neither may take the other's evidence.
      getPublicationHandler()({ data: statMessage("stat-compat") });
      await waitFor(() => expect(authorizedCalls).toBe(1));
      getPublicationHandler()({ data: statMessage("stat-authorized") });
      await waitFor(() => expect(fileErrors()).toHaveLength(1));
      failCompatibility(new Error("PRIVATE compatibility failure"));
      await waitFor(() => expect(fileErrors()).toHaveLength(2));
      expect(fileErrors()).toEqual([
        expect.objectContaining({
          requestId: "stat-authorized",
          receiverDiagnostic: {
            version: 1,
            stage: "native_invoke",
            adapter: "authorized_native",
            nativeVersionLookup: "resolved_other",
          },
        }),
        expect.objectContaining({
          requestId: "stat-compat",
          receiverDiagnostic: {
            version: 1,
            stage: "native_invoke",
            adapter: "compatibility_native",
            nativeVersionLookup: "resolved_other",
          },
        }),
      ]);

      getPublicationHandler()({ data: statMessage("stat-late") });
      await waitFor(() => expect(failLate).toBeDefined());
      await bridge.stop();
      failLate(new Error("PRIVATE late failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockSubscription.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "stat-late" }),
      );
    } finally {
      await bridge.stop();
    }
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

describe("Desktop session challenge", () => {
  const LAUNCH = "c".repeat(32);
  const NONCE = "b".repeat(32);
  const lifecycle = (pageGeneration: number) => ({
    launchId: LAUNCH,
    previousExit: "clean",
    previousWebProcessTermination: "none",
    pageGeneration,
    webProcessTermination: "none",
  });
  const challenge = (
    commandIds: string[],
    targetConnectionId = "conn-123",
  ) => ({
    type: "desktop_session_challenge",
    nonce: NONCE,
    targetConnectionId,
    commandIds,
  });
  const proofs = () =>
    mockSubscription.publish.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === "desktop_session_proof");

  async function startBridge(native: () => unknown) {
    jest.useFakeTimers();
    let osReads = 0;
    let executions = 0;
    const fallback = mockInvokeHandler;
    mockInvokeHandler = async (cmd, args) => {
      if (cmd === "get_desktop_os_info") {
        osReads++;
        return native();
      }
      // A running command: native execution never completes here.
      if (cmd === "execute_stream_command") {
        executions++;
        return new Promise(() => {});
      }
      return fallback(cmd, args);
    };
    const bridge = new DesktopSandboxBridge(buildConfig());
    await bridge.start();
    return {
      bridge,
      osReads: () => osReads,
      executions: () => executions,
    };
  }

  afterEach(() => jest.useRealTimers());

  it("answers with fresh native identity and only the command output it retains, never executing", async () => {
    let generation = 2;
    const host = await startBridge(() => ({
      platform: "darwin",
      arch: "arm64",
      release: "qa",
      hostname: "qa",
      lifecycle: lifecycle(generation),
    }));
    try {
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
          commandId: "running",
          command: "bounded",
          timeout: 120_000,
          outputProtocol: "ack-v1",
          targetConnectionId: "conn-123",
          operationChannel: true,
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(host.executions()).toBe(1);
      const startupReads = host.osReads();

      getPublicationHandler()({ data: challenge(["running", "unknown"]) });
      await jest.advanceTimersByTimeAsync(0);
      expect(host.osReads()).toBe(startupReads + 1);
      expect(proofs()).toEqual([
        {
          type: "desktop_session_proof",
          nonce: NONCE,
          connectionId: "conn-123",
          launchId: LAUNCH,
          pageGeneration: 2,
          retainedCommandIds: ["running"],
        },
      ]);

      // A later page generation cannot vouch for this page's commands.
      generation = 3;
      getPublicationHandler()({ data: challenge(["running"]) });
      await jest.advanceTimersByTimeAsync(0);
      expect(proofs().at(-1)).toEqual({
        type: "desktop_session_proof",
        nonce: NONCE,
        connectionId: "conn-123",
        unavailable: true,
      });

      // Another connection's challenge is never answered.
      getPublicationHandler()({ data: challenge([], "conn-other") });
      await jest.advanceTimersByTimeAsync(0);
      expect(proofs()).toHaveLength(2);
      expect(host.executions()).toBe(1);
    } finally {
      await host.bridge.stop();
    }
  });

  it("never claims a closed output window that remains mapped while native execution is pending", async () => {
    const host = await startBridge(() => ({
      platform: "darwin",
      arch: "arm64",
      release: "qa",
      hostname: "qa",
      lifecycle: lifecycle(2),
    }));
    const spies = ["warn", "error"].map((method) =>
      jest.spyOn(console, method as "warn").mockImplementation(() => {}),
    );
    try {
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
          commandId: "overflowed",
          command: "noisy",
          timeout: 120_000,
          outputProtocol: "ack-v1",
          targetConnectionId: "conn-123",
          operationChannel: true,
        },
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(host.executions()).toBe(1);
      // Unacknowledged, never-combined frames exceed the window: it closes
      // while the native invocation itself is still running.
      for (let i = 0; i <= 4096; i++)
        capturedChannel!.onmessage!({
          type: i % 2 ? "stderr" : "stdout",
          data: "x",
        });
      await jest.advanceTimersByTimeAsync(0);

      getPublicationHandler()({ data: challenge(["overflowed"]) });
      await jest.advanceTimersByTimeAsync(0);
      expect(proofs()).toEqual([
        expect.objectContaining({
          launchId: LAUNCH,
          pageGeneration: 2,
          retainedCommandIds: [],
        }),
      ]);
      expect(host.executions()).toBe(1);
    } finally {
      await host.bridge.stop();
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("answers unavailable for a binary without lifecycle, and nothing while its read hangs", async () => {
    const legacy = await startBridge(() => ({
      platform: "darwin",
      arch: "arm64",
      release: "qa",
      hostname: "qa",
    }));
    try {
      const startupReads = legacy.osReads();
      getPublicationHandler()({ data: challenge([]) });
      await jest.advanceTimersByTimeAsync(0);
      expect(proofs()).toEqual([
        expect.objectContaining({ unavailable: true, nonce: NONCE }),
      ]);
      // No startup identity: nothing to compare, so no native read either.
      expect(legacy.osReads()).toBe(startupReads);
    } finally {
      await legacy.bridge.stop();
    }

    // The next bridge registers its own handlers; drop the stopped one's.
    mockSubscription.publish.mockClear();
    mockSubscription.on.mockClear();
    mockClient.on.mockClear();
    let hang = false;
    const hung = await startBridge(() =>
      hang
        ? new Promise(() => {})
        : {
            platform: "darwin",
            arch: "arm64",
            release: "qa",
            hostname: "qa",
            lifecycle: lifecycle(1),
          },
    );
    try {
      hang = true;
      getPublicationHandler()({ data: challenge([]) });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(proofs()).toEqual([]);
    } finally {
      await hung.bridge.stop();
    }
  });
});

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
      /** Extra command fields, such as a private cwd canary. */
      command?: Record<string, unknown>;
      afterStart?: (bridge: DesktopSandboxBridge) => void;
      beforeAck?: (bridge: DesktopSandboxBridge) => Promise<void>;
      /** The native OS, as Rust's `std::env::consts::OS`; the harness
       * default is otherwise the cached macOS info. */
      nativeOs?: string;
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
      if (options.nativeOs && cmd === "get_desktop_os_info")
        return {
          platform: options.nativeOs,
          arch: "x64",
          release: "10.0.26100",
          hostname: "qa-host",
        };
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
      options.afterStart?.(bridge);
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
            ...options.command,
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

  describe("transport detail", () => {
    // A refusal: the frozen cause folds it into "other"; the detail names it.
    const cause = {
      version: 1,
      ioKind: "other",
      sourceDepth: 3,
      sourceChainTruncated: false,
    };
    const transport = {
      version: 1,
      ioKindDetail: "connection_refused",
      nativeTlsSource: false,
      sourceDepth: 3,
      sourceChainTruncated: false,
    };
    const transportGroup = {
      native_authorization_transport_version: 1,
      native_authorization_transport_io_kind_detail: "connection_refused",
      native_authorization_transport_native_tls_source: false,
      native_authorization_transport_source_depth: 3,
      native_authorization_transport_source_chain_truncated: false,
    };
    const causeKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key),
      );
    const transportKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES.has(key),
      );
    const channels = (call: NativeCall) => ({
      receipt: call.onAuthorizationDiagnostic as MockChannel,
      cause: call.onAuthorizationCauseDiagnostic as MockChannel,
      transport: call.onAuthorizationTransportDiagnostic as MockChannel,
    });

    it("joins one detail from its own one-shot channel beside the unchanged cause", async () => {
      const { calls, replies } = await run(async (call) => {
        const { receipt: v1, cause: v2, transport: v3 } = channels(call);
        v3.onmessage!({ ...transport, nativeTlsSource: true });
        // A duplicate cannot replace the first callback attempt.
        v3.onmessage!(transport);
        v1.onmessage!(receipt);
        v2.onmessage!(cause);
        return Promise.reject(unavailable);
      });

      expect(calls).toHaveLength(1);
      const { receipt: v1, cause: v2, transport: v3 } = channels(calls[0]);
      expect(v3).toBeDefined();
      for (const other of [calls[0].onEvent, v1, v2])
        expect(v3).not.toBe(other);
      expect(Object.keys(calls[0].message as object)).not.toContain(
        "onAuthorizationTransportDiagnostic",
      );
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      const expected = {
        ...transportGroup,
        native_authorization_transport_native_tls_source: true,
      };
      expect(final.properties).toMatchObject({
        terminalType: "error",
        native_authorization_send_connect: true,
        native_authorization_cause_io_kind: "other",
        ...expected,
      });
      const started = captures().find(
        (event) => event.event === "desktop_ack_command_started",
      );
      expect(transportKeys(started?.properties)).toEqual([]);
      const enriched = sanitizeDesktopAckEvent({
        ...final,
        properties: { ...final.properties, $current_url: "PRIVATE" },
      });
      expect(enriched.properties).toMatchObject(expected);
      expect(transportKeys(enriched.properties)).toHaveLength(5);
      // The frozen groups are unchanged beside it.
      expect(nativeKeys(enriched.properties)).toHaveLength(8);
      expect(causeKeys(enriched.properties)).toHaveLength(4);
      expect(enriched.properties).toMatchObject({
        native_authorization_cause_io_kind: "other",
      });
      const serialized = JSON.stringify([captures(), enriched]);
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain(authorizationId);
      expect(serialized).not.toContain(unavailable);
    });

    it("keeps the v1 and cause groups unchanged when an older native app sends no detail", async () => {
      const { calls } = await run((call) => {
        channels(call).receipt.onmessage!(receipt);
        channels(call).cause.onmessage!(cause);
        return reject(unavailable);
      });
      expect(calls[0]).toHaveProperty("onAuthorizationTransportDiagnostic");
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(causeKeys(finals()[0].properties)).toHaveLength(4);
      expect(transportKeys(finals()[0].properties)).toEqual([]);
    });

    it("reports no detail without the same invocation's v1 receipt", async () => {
      await run((call) => {
        channels(call).transport.onmessage!(transport);
        return reject(unavailable);
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
      expect(nativeKeys(finals()[0].properties)).toEqual([]);
      expect(transportKeys(finals()[0].properties)).toEqual([]);
    });

    it.each<[string, () => unknown]>([
      ["an extra private field", () => ({ ...transport, message: "PRIVATE" })],
      ["a missing field", () => ({ ...transport, nativeTlsSource: undefined })],
      ["another version", () => ({ ...transport, version: 2 })],
      ["a private kind", () => ({ ...transport, ioKindDetail: "PRIVATE" })],
      [
        "a guessed TLS kind",
        () => ({ ...transport, ioKindDetail: "tls_handshake" }),
      ],
      ["a string TLS flag", () => ({ ...transport, nativeTlsSource: "true" })],
      ["an unbounded depth", () => ({ ...transport, sourceDepth: 9 })],
      [
        "a truncated walk shorter than the bound",
        () => ({ ...transport, sourceDepth: 7, sourceChainTruncated: true }),
      ],
      [
        "an exposed kind without a source link",
        () => ({ ...transport, sourceDepth: 0 }),
      ],
      [
        "a TLS source without a source link",
        () => ({
          ...transport,
          ioKindDetail: "not_exposed",
          nativeTlsSource: true,
          sourceDepth: 0,
        }),
      ],
      ["a cause on the transport channel", () => cause],
      ["a string", () => "PRIVATE"],
      [
        "a class instance",
        () =>
          Object.assign(
            Object.create({ message: "PRIVATE" }) as object,
            transport,
          ),
      ],
      [
        "a throwing getter",
        () =>
          Object.defineProperty({ ...transport }, "ioKindDetail", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE");
            },
          }),
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
      "drops only the detail for %s and keeps the v1 and cause groups",
      async (_case, value) => {
        const { replies } = await run((call) => {
          const { receipt: v1, cause: v2, transport: v3 } = channels(call);
          v1.onmessage!(receipt);
          v2.onmessage!(cause);
          v3.onmessage!(value());
          // The malformed first attempt closed the transport latch.
          v3.onmessage!(transport);
          return reject(unavailable);
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: unavailable }),
        ]);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
        expect(causeKeys(finals()[0].properties)).toHaveLength(4);
        expect(transportKeys(finals()[0].properties)).toEqual([]);
        expect(JSON.stringify(captures())).not.toContain("PRIVATE");
      },
    );

    it("adds no detail to a successful command", async () => {
      await run(async (call) => {
        const { receipt: v1, transport: v3 } = channels(call);
        v1.onmessage!(receipt);
        v3.onmessage!(transport);
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
      expect(transportKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a detail after settlement and releases its callback", async () => {
      let call!: NativeCall;
      await run((native) => {
        call = native;
        channels(call).receipt.onmessage!(receipt);
        return reject(unavailable);
      });
      const { transport: v3 } = channels(call);
      expect(v3.cleanupCallback).toHaveBeenCalledTimes(1);
      v3.onmessage!(transport);
      expect(finals()).toHaveLength(1);
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(transportKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a detail observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        await run((call) => {
          const { receipt: v1, transport: v3 } = channels(call);
          v1.onmessage!(receipt);
          identity.mockReturnValue("another-user");
          v3.onmessage!(transport);
          identity.mockReturnValue("user-456");
          v3.onmessage!(transport);
          return reject(unavailable);
        });
        expect(finals()).toHaveLength(1);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
        expect(transportKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("drops a detail that arrives after the connection is stopped", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          channels(call).receipt.onmessage!(receipt);
          await pending;
          channels(call).transport.onmessage!(transport);
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
      expect(transportKeys(finals()[0].properties)).toEqual([]);
    });

    it("keeps interleaved invocations' details separate", async () => {
      let arrived = 0;
      let release!: () => void;
      const all = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          const { receipt: v1, transport: v3 } = channels(call);
          const commandId = (call.message as { commandId: string }).commandId;
          if (commandId === "refused") v3.onmessage!(transport);
          if (++arrived === 3) release();
          await all;
          v1.onmessage!(receipt);
          if (commandId === "tls")
            v3.onmessage!({
              ...transport,
              ioKindDetail: "not_exposed",
              nativeTlsSource: true,
              sourceDepth: 2,
            });
          return reject(unavailable);
        },
        { commandIds: ["refused", "tls", "v1-only"] },
      );
      const byCommand = Object.fromEntries(
        finals().map((event) => [
          event.properties!.commandId,
          event.properties,
        ]),
      );
      expect(byCommand.refused).toMatchObject(transportGroup);
      expect(byCommand.tls).toMatchObject({
        native_authorization_transport_io_kind_detail: "not_exposed",
        native_authorization_transport_native_tls_source: true,
        native_authorization_transport_source_depth: 2,
      });
      expect(nativeKeys(byCommand["v1-only"])).toHaveLength(8);
      expect(transportKeys(byCommand["v1-only"])).toEqual([]);
    });

    it("keeps every other channel when only the transport channel cannot be created", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      const create = jest.mocked(Channel).getMockImplementation()!;
      jest
        .mocked(Channel)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(() => {
          throw new Error("channel unavailable");
        });
      const { calls, replies } = await run((call) => {
        channels(call).receipt.onmessage!(receipt);
        channels(call).cause.onmessage!(cause);
        return reject(unavailable);
      });
      expect(calls).toHaveLength(1);
      for (const key of [
        "onEvent",
        "onAuthorizationDiagnostic",
        "onAuthorizationCauseDiagnostic",
        "onAuthorizationResponseDiagnostic",
        "onAuthorizationMitigationDiagnostic",
      ])
        expect(calls[0]).toHaveProperty(key);
      expect(calls[0]).not.toHaveProperty("onAuthorizationTransportDiagnostic");
      // The IO supplement only ever refines the transport detail.
      expect(calls[0]).not.toHaveProperty("onAuthorizationIoDiagnostic");
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(causeKeys(finals()[0].properties)).toHaveLength(4);
      expect(transportKeys(finals()[0].properties)).toEqual([]);
    });

    it("never requests a detail without the v1 receipt channel", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      jest.mocked(Channel).mockImplementationOnce(() => {
        throw new Error("channel unavailable");
      });
      const { calls } = await run(() => reject(unavailable));
      expect(calls[0]).not.toHaveProperty("onAuthorizationDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationTransportDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationIoDiagnostic");
    });
  });

  describe("unmapped IO supplement", () => {
    // A Windows lookup failure: the frozen cause folds it into "other", the
    // frozen detail into "unmapped", and only the supplement names its family.
    const windowsReceipt = { ...receipt, platform: "windows" };
    const cause = {
      version: 1,
      ioKind: "other",
      sourceDepth: 3,
      sourceChainTruncated: false,
    };
    const transport = {
      version: 1,
      ioKindDetail: "unmapped",
      nativeTlsSource: false,
      sourceDepth: 3,
      sourceChainTruncated: false,
    };
    const io = {
      version: 1,
      ioKind: "unknown",
      osFamily: "winsock_host_not_found",
      sourceDepth: 3,
    };
    const ioGroup = {
      native_authorization_io_version: 1,
      native_authorization_io_kind: "unknown",
      native_authorization_io_os_family: "winsock_host_not_found",
      native_authorization_io_source_depth: 3,
    };
    const ioKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_IO_PROPERTIES.has(key),
      );
    const legacyKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter(
        (key) =>
          NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key) ||
          NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key) ||
          NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES.has(key),
      );
    const channels = (call: NativeCall) => ({
      receipt: call.onAuthorizationDiagnostic as MockChannel,
      cause: call.onAuthorizationCauseDiagnostic as MockChannel,
      transport: call.onAuthorizationTransportDiagnostic as MockChannel,
      io: call.onAuthorizationIoDiagnostic as MockChannel,
    });
    /** Delivers the frozen receipts as a current native app sends them. */
    const sendLegacy = (
      call: NativeCall,
      overrides: {
        receipt?: unknown;
        cause?: unknown;
        transport?: unknown;
      } = {},
    ) => {
      const { receipt: v1, cause: v2, transport: v3 } = channels(call);
      v1.onmessage!(overrides.receipt ?? windowsReceipt);
      v2.onmessage!(overrides.cause ?? cause);
      v3.onmessage!(overrides.transport ?? transport);
    };

    it("joins one supplement from its own one-shot channel beside the unchanged groups", async () => {
      const { calls, replies } = await run(async (call) => {
        const { io: v4 } = channels(call);
        v4.onmessage!(io);
        // A duplicate cannot replace the first callback attempt.
        v4.onmessage!({ ...io, osFamily: "winsock_try_again" });
        sendLegacy(call);
        return Promise.reject(unavailable);
      });

      expect(calls).toHaveLength(1);
      const {
        receipt: v1,
        cause: v2,
        transport: v3,
        io: v4,
      } = channels(calls[0]);
      expect(v4).toBeDefined();
      for (const other of [calls[0].onEvent, v1, v2, v3])
        expect(v4).not.toBe(other);
      expect(Object.keys(calls[0].message as object)).not.toContain(
        "onAuthorizationIoDiagnostic",
      );
      // The product error is the identical single terminal frame.
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      expect(final.properties).toMatchObject({
        terminalType: "error",
        native_platform: "windows",
        native_authorization_cause_io_kind: "other",
        native_authorization_transport_io_kind_detail: "unmapped",
        ...ioGroup,
      });
      const started = captures().find(
        (event) => event.event === "desktop_ack_command_started",
      );
      expect(ioKeys(started?.properties)).toEqual([]);
      const enriched = sanitizeDesktopAckEvent({
        ...final,
        properties: { ...final.properties, $current_url: "PRIVATE" },
      });
      expect(enriched.properties).toMatchObject(ioGroup);
      expect(ioKeys(enriched.properties)).toHaveLength(4);
      // The frozen groups are unchanged beside it.
      expect(legacyKeys(enriched.properties)).toHaveLength(8 + 4 + 5);
      const serialized = JSON.stringify([captures(), enriched]);
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain(authorizationId);
      expect(serialized).not.toContain(unavailable);
    });

    it("keeps every frozen group unchanged when an older native app sends no supplement", async () => {
      const { calls } = await run((call) => {
        sendLegacy(call);
        return reject(unavailable);
      });
      expect(calls[0]).toHaveProperty("onAuthorizationIoDiagnostic");
      expect(legacyKeys(finals()[0].properties)).toHaveLength(8 + 4 + 5);
      expect(ioKeys(finals()[0].properties)).toEqual([]);
    });

    it.each<[string, (call: NativeCall) => void]>([
      ["no v1 receipt", (call) => channels(call).io.onmessage!(io)],
      [
        "no cause or transport detail",
        (call) => {
          channels(call).receipt.onmessage!(windowsReceipt);
          channels(call).io.onmessage!(io);
        },
      ],
      [
        "a mapped transport kind",
        (call) => {
          sendLegacy(call, {
            transport: { ...transport, ioKindDetail: "connection_refused" },
          });
          channels(call).io.onmessage!(io);
        },
      ],
      [
        "a deeper IO error than the cause's first one",
        (call) => {
          sendLegacy(call, { transport: { ...transport, sourceDepth: 5 } });
          channels(call).io.onmessage!({ ...io, sourceDepth: 4 });
        },
      ],
      [
        "a Winsock family from a non-Windows receipt",
        (call) => {
          sendLegacy(call, { receipt });
          channels(call).io.onmessage!(io);
        },
      ],
    ])("reports no supplement with %s", async (_case, deliver) => {
      await run((call) => {
        deliver(call);
        return reject(unavailable);
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
      expect(ioKeys(finals()[0].properties)).toEqual([]);
      expect(JSON.stringify(captures())).not.toContain("winsock");
    });

    it.each<[string, () => unknown]>([
      ["an extra private field", () => ({ ...io, message: "PRIVATE" })],
      ["a raw OS code field", () => ({ ...io, rawOsError: 11001 })],
      ["a raw OS code as the family", () => ({ ...io, osFamily: 11001 })],
      ["a missing field", () => ({ ...io, osFamily: undefined })],
      ["another version", () => ({ ...io, version: 2 })],
      ["a private kind", () => ({ ...io, ioKind: "PRIVATE" })],
      ["std's unstable kind name", () => ({ ...io, ioKind: "uncategorized" })],
      ["an unbounded depth", () => ({ ...io, sourceDepth: 9 })],
      ["no exposed depth", () => ({ ...io, sourceDepth: 0 })],
      ["a transport detail on the IO channel", () => transport],
      ["a string", () => "PRIVATE"],
      [
        "a class instance",
        () =>
          Object.assign(Object.create({ message: "PRIVATE" }) as object, io),
      ],
      [
        "a throwing getter",
        () =>
          Object.defineProperty({ ...io }, "osFamily", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE");
            },
          }),
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
      "drops only the supplement for %s and keeps the frozen groups",
      async (_case, value) => {
        const { replies } = await run((call) => {
          sendLegacy(call);
          channels(call).io.onmessage!(value());
          // The malformed first attempt closed the IO latch.
          channels(call).io.onmessage!(io);
          return reject(unavailable);
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: unavailable }),
        ]);
        expect(legacyKeys(finals()[0].properties)).toHaveLength(8 + 4 + 5);
        expect(ioKeys(finals()[0].properties)).toEqual([]);
        const serialized = JSON.stringify(captures());
        expect(serialized).not.toContain("PRIVATE");
        expect(serialized).not.toContain("11001");
      },
    );

    it("adds no supplement to a successful command", async () => {
      await run(async (call) => {
        sendLegacy(call);
        channels(call).io.onmessage!(io);
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
      expect(ioKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a supplement after settlement and releases its callback", async () => {
      let call!: NativeCall;
      await run((native) => {
        call = native;
        sendLegacy(call);
        return reject(unavailable);
      });
      const { io: v4 } = channels(call);
      expect(v4.cleanupCallback).toHaveBeenCalledTimes(1);
      v4.onmessage!(io);
      expect(finals()).toHaveLength(1);
      expect(legacyKeys(finals()[0].properties)).toHaveLength(8 + 4 + 5);
      expect(ioKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a supplement observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        await run((call) => {
          sendLegacy(call);
          identity.mockReturnValue("another-user");
          channels(call).io.onmessage!(io);
          identity.mockReturnValue("user-456");
          channels(call).io.onmessage!(io);
          return reject(unavailable);
        });
        expect(finals()).toHaveLength(1);
        expect(legacyKeys(finals()[0].properties)).toHaveLength(8 + 4 + 5);
        expect(ioKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("drops a supplement that arrives after the connection is stopped", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          sendLegacy(call);
          await pending;
          channels(call).io.onmessage!(io);
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
      expect(ioKeys(finals()[0].properties)).toEqual([]);
    });

    it("keeps interleaved invocations' supplements separate", async () => {
      let arrived = 0;
      let release!: () => void;
      const all = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          const commandId = (call.message as { commandId: string }).commandId;
          if (commandId === "host-not-found") channels(call).io.onmessage!(io);
          if (++arrived === 3) release();
          await all;
          sendLegacy(call);
          if (commandId === "try-again")
            channels(call).io.onmessage!({
              ...io,
              ioKind: "not_found",
              osFamily: "winsock_try_again",
            });
          return reject(unavailable);
        },
        { commandIds: ["host-not-found", "try-again", "legacy-only"] },
      );
      const byCommand = Object.fromEntries(
        finals().map((event) => [
          event.properties!.commandId,
          event.properties,
        ]),
      );
      expect(byCommand["host-not-found"]).toMatchObject(ioGroup);
      expect(byCommand["try-again"]).toMatchObject({
        native_authorization_io_kind: "not_found",
        native_authorization_io_os_family: "winsock_try_again",
      });
      expect(legacyKeys(byCommand["legacy-only"])).toHaveLength(8 + 4 + 5);
      expect(ioKeys(byCommand["legacy-only"])).toEqual([]);
    });

    it("keeps every other channel when only the IO channel cannot be created", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      const create = jest.mocked(Channel).getMockImplementation()!;
      jest
        .mocked(Channel)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(() => {
          throw new Error("channel unavailable");
        });
      const { calls, replies } = await run((call) => {
        sendLegacy(call);
        return reject(unavailable);
      });
      expect(calls).toHaveLength(1);
      for (const key of [
        "onEvent",
        "onAuthorizationDiagnostic",
        "onAuthorizationCauseDiagnostic",
        "onAuthorizationResponseDiagnostic",
        "onAuthorizationMitigationDiagnostic",
        "onAuthorizationTransportDiagnostic",
      ])
        expect(calls[0]).toHaveProperty(key);
      expect(calls[0]).not.toHaveProperty("onAuthorizationIoDiagnostic");
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(legacyKeys(finals()[0].properties)).toHaveLength(8 + 4 + 5);
      expect(ioKeys(finals()[0].properties)).toEqual([]);
    });
  });

  describe("connector phase snapshot", () => {
    // A lost response: reqwest's deadline fired after its connector returned.
    const timedOut = {
      ...receipt,
      timeout: true,
      connect: false,
      request: true,
    };
    const cause = {
      version: 1,
      ioKind: "not_exposed",
      sourceDepth: 1,
      sourceChainTruncated: false,
    };
    const connector = {
      version: 1,
      phase: "connected",
      attempts: 1,
      elapsedMs: 31,
    };
    const connectorGroup = {
      native_authorization_connector_version: 1,
      native_authorization_connector_phase: "connected",
      native_authorization_connector_attempts: 1,
      native_authorization_connector_elapsed_ms: 31,
    };
    const connectorKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES.has(key),
      );
    const causeKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key),
      );
    const channels = (call: NativeCall) => ({
      receipt: call.onAuthorizationDiagnostic as MockChannel,
      cause: call.onAuthorizationCauseDiagnostic as MockChannel,
      connector: call.onAuthorizationConnectorDiagnostic as MockChannel,
    });
    /** Delivers the frozen receipts as a current native app sends them. */
    const sendLegacy = (call: NativeCall) => {
      channels(call).receipt.onmessage!(timedOut);
      channels(call).cause.onmessage!(cause);
    };

    it("joins one snapshot from its own one-shot channel beside the unchanged groups", async () => {
      const { calls, replies } = await run(async (call) => {
        const { connector: v5 } = channels(call);
        v5.onmessage!(connector);
        // A duplicate cannot replace the first callback attempt.
        v5.onmessage!({ ...connector, phase: "failed" });
        sendLegacy(call);
        return Promise.reject(unavailable);
      });

      expect(calls).toHaveLength(1);
      const { receipt: v1, cause: v2, connector: v5 } = channels(calls[0]);
      expect(v5).toBeDefined();
      for (const other of [
        calls[0].onEvent,
        v1,
        v2,
        calls[0].onAuthorizationTransportDiagnostic,
        calls[0].onAuthorizationIoDiagnostic,
      ])
        expect(v5).not.toBe(other);
      expect(Object.keys(calls[0].message as object)).not.toContain(
        "onAuthorizationConnectorDiagnostic",
      );
      // The product error is the identical single terminal frame.
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      expect(final.properties).toMatchObject({
        terminalType: "error",
        native_authorization_send_timeout: true,
        native_authorization_cause_io_kind: "not_exposed",
        ...connectorGroup,
      });
      const started = captures().find(
        (event) => event.event === "desktop_ack_command_started",
      );
      expect(connectorKeys(started?.properties)).toEqual([]);
      const enriched = sanitizeDesktopAckEvent({
        ...final,
        properties: { ...final.properties, $current_url: "PRIVATE" },
      });
      expect(enriched.properties).toMatchObject(connectorGroup);
      expect(connectorKeys(enriched.properties)).toHaveLength(4);
      // The frozen groups are unchanged beside it.
      expect(nativeKeys(enriched.properties)).toHaveLength(8);
      expect(causeKeys(enriched.properties)).toHaveLength(4);
      const serialized = JSON.stringify([captures(), enriched]);
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain(authorizationId);
      expect(serialized).not.toContain(unavailable);
    });

    it.each([
      { phase: "not_started", attempts: 0, elapsedMs: null },
      { phase: "pending", attempts: 1, elapsedMs: 8_000 },
      { phase: "failed", attempts: 1, elapsedMs: 0 },
      { phase: "multiple", attempts: 8, elapsedMs: null },
    ])("keeps the native snapshot as sent: %p", async (snapshot) => {
      await run((call) => {
        sendLegacy(call);
        channels(call).connector.onmessage!({ version: 1, ...snapshot });
        return reject(unavailable);
      });
      expect(finals()[0].properties).toMatchObject({
        native_authorization_connector_version: 1,
        native_authorization_connector_phase: snapshot.phase,
        native_authorization_connector_attempts: snapshot.attempts,
        native_authorization_connector_elapsed_ms: snapshot.elapsedMs,
      });
    });

    it("keeps the frozen groups unchanged when an older native app sends no snapshot", async () => {
      const { calls } = await run((call) => {
        sendLegacy(call);
        return reject(unavailable);
      });
      expect(calls[0]).toHaveProperty("onAuthorizationConnectorDiagnostic");
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(causeKeys(finals()[0].properties)).toHaveLength(4);
      // Unknown, never defaulted to a phase.
      expect(connectorKeys(finals()[0].properties)).toEqual([]);
    });

    it("reports no snapshot without the same invocation's v1 receipt", async () => {
      await run((call) => {
        channels(call).connector.onmessage!(connector);
        return reject(unavailable);
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
      expect(nativeKeys(finals()[0].properties)).toEqual([]);
      expect(connectorKeys(finals()[0].properties)).toEqual([]);
    });

    it.each<[string, () => unknown]>([
      ["an extra private field", () => ({ ...connector, host: "PRIVATE" })],
      ["a missing field", () => ({ ...connector, elapsedMs: undefined })],
      [
        "an omitted field",
        () => {
          const { elapsedMs: _elapsedMs, ...rest } = connector;
          return rest;
        },
      ],
      ["another version", () => ({ ...connector, version: 2 })],
      ["a guessed DNS phase", () => ({ ...connector, phase: "dns" })],
      ["a guessed write phase", () => ({ ...connector, phase: "written" })],
      ["a private phase", () => ({ ...connector, phase: "PRIVATE" })],
      [
        "a single call without its time",
        () => ({ ...connector, elapsedMs: null }),
      ],
      ["a single phase for two calls", () => ({ ...connector, attempts: 2 })],
      [
        "multiple calls with one time",
        () => ({ phase: "multiple", attempts: 2, elapsedMs: 5, version: 1 }),
      ],
      [
        "multiple calls counted once",
        () => ({ phase: "multiple", attempts: 1, elapsedMs: null, version: 1 }),
      ],
      [
        "an unbounded call count",
        () => ({ phase: "multiple", attempts: 9, elapsedMs: null, version: 1 }),
      ],
      [
        "a started connector without a call",
        () => ({ ...connector, phase: "not_started", attempts: 0 }),
      ],
      ["an unbounded time", () => ({ ...connector, elapsedMs: 60_001 })],
      ["a negative time", () => ({ ...connector, elapsedMs: -1 })],
      ["a fractional time", () => ({ ...connector, elapsedMs: 0.5 })],
      ["a string time", () => ({ ...connector, elapsedMs: "31" })],
      ["a cause on the connector channel", () => cause],
      ["a string", () => "PRIVATE"],
      [
        "a class instance",
        () =>
          Object.assign(
            Object.create({ message: "PRIVATE" }) as object,
            connector,
          ),
      ],
      [
        "a throwing getter",
        () =>
          Object.defineProperty({ ...connector }, "phase", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE");
            },
          }),
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
      "drops only the snapshot for %s and keeps the frozen groups",
      async (_case, value) => {
        const { replies } = await run((call) => {
          sendLegacy(call);
          channels(call).connector.onmessage!(value());
          // The malformed first attempt closed the connector latch.
          channels(call).connector.onmessage!(connector);
          return reject(unavailable);
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: unavailable }),
        ]);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
        expect(causeKeys(finals()[0].properties)).toHaveLength(4);
        expect(connectorKeys(finals()[0].properties)).toEqual([]);
        expect(JSON.stringify(captures())).not.toContain("PRIVATE");
      },
    );

    it("adds no snapshot to a successful command", async () => {
      await run(async (call) => {
        sendLegacy(call);
        channels(call).connector.onmessage!(connector);
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
      expect(connectorKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a snapshot after settlement and releases its callback", async () => {
      let call!: NativeCall;
      await run((native) => {
        call = native;
        sendLegacy(call);
        return reject(unavailable);
      });
      const { connector: v5 } = channels(call);
      expect(v5.cleanupCallback).toHaveBeenCalledTimes(1);
      v5.onmessage!(connector);
      expect(finals()).toHaveLength(1);
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(connectorKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a snapshot observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        await run((call) => {
          sendLegacy(call);
          identity.mockReturnValue("another-user");
          channels(call).connector.onmessage!(connector);
          identity.mockReturnValue("user-456");
          channels(call).connector.onmessage!(connector);
          return reject(unavailable);
        });
        expect(finals()).toHaveLength(1);
        expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
        expect(connectorKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("drops a snapshot that arrives after the connection is stopped", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          sendLegacy(call);
          await pending;
          channels(call).connector.onmessage!(connector);
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
      expect(connectorKeys(finals()[0].properties)).toEqual([]);
    });

    it("keeps interleaved invocations' snapshots separate", async () => {
      let arrived = 0;
      let release!: () => void;
      const all = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          const commandId = (call.message as { commandId: string }).commandId;
          if (commandId === "connected")
            channels(call).connector.onmessage!(connector);
          if (++arrived === 3) release();
          await all;
          sendLegacy(call);
          if (commandId === "pending")
            channels(call).connector.onmessage!({
              ...connector,
              phase: "pending",
              elapsedMs: 7_999,
            });
          return reject(unavailable);
        },
        { commandIds: ["connected", "pending", "legacy-only"] },
      );
      const byCommand = Object.fromEntries(
        finals().map((event) => [
          event.properties!.commandId,
          event.properties,
        ]),
      );
      expect(byCommand.connected).toMatchObject(connectorGroup);
      expect(byCommand.pending).toMatchObject({
        native_authorization_connector_phase: "pending",
        native_authorization_connector_elapsed_ms: 7_999,
      });
      expect(nativeKeys(byCommand["legacy-only"])).toHaveLength(8);
      expect(connectorKeys(byCommand["legacy-only"])).toEqual([]);
    });

    it("keeps every other channel when only the connector channel cannot be created", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      const create = jest.mocked(Channel).getMockImplementation()!;
      jest
        .mocked(Channel)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(() => {
          throw new Error("channel unavailable");
        });
      const { calls, replies } = await run((call) => {
        sendLegacy(call);
        return reject(unavailable);
      });
      expect(calls).toHaveLength(1);
      for (const key of [
        "onEvent",
        "onAuthorizationDiagnostic",
        "onAuthorizationCauseDiagnostic",
        "onAuthorizationResponseDiagnostic",
        "onAuthorizationMitigationDiagnostic",
        "onAuthorizationTransportDiagnostic",
        "onAuthorizationIoDiagnostic",
      ])
        expect(calls[0]).toHaveProperty(key);
      expect(calls[0]).not.toHaveProperty("onAuthorizationConnectorDiagnostic");
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(connectorKeys(finals()[0].properties)).toEqual([]);
    });

    it("never requests a snapshot without the v1 receipt channel", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      jest.mocked(Channel).mockImplementationOnce(() => {
        throw new Error("channel unavailable");
      });
      const { calls } = await run(() => reject(unavailable));
      expect(calls[0]).not.toHaveProperty("onAuthorizationDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationConnectorDiagnostic");
    });
  });

  describe("approval rejection response", () => {
    const vercelId = "iad1::abcde-1700000000000-0123456789ab";
    const rejection = {
      version: 1,
      httpStatus: 403,
      approval: "not_checked",
      originClass: "canonical_production",
      platform: "windows",
      requestIdShape: "valid",
      requestId: vercelId,
    };
    const responseGroup = {
      native_authorization_response_version: 1,
      native_authorization_response_http_status: 403,
      native_authorization_response_approval: "not_checked",
      native_authorization_response_origin_class: "canonical_production",
      native_authorization_response_platform: "windows",
      native_authorization_response_request_id_shape: "valid",
      native_authorization_response_request_id: vercelId,
    };
    const notAuthorized = "Desktop operation was not authorized";
    const responseKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES.has(key),
      );
    const responseChannel = (call: NativeCall) =>
      call.onAuthorizationResponseDiagnostic as MockChannel;

    it("joins one same-invocation response receipt on its own channel", async () => {
      const { calls, replies } = await run(async (call) => {
        responseChannel(call).onmessage!(rejection);
        // A duplicate cannot replace the first callback attempt.
        responseChannel(call).onmessage!({
          ...rejection,
          httpStatus: 200,
          approval: "approved_false",
        });
        return Promise.reject(notAuthorized);
      });

      expect(calls).toHaveLength(1);
      const channel = responseChannel(calls[0]);
      expect(channel).toBeDefined();
      for (const other of [
        calls[0].onEvent,
        calls[0].onAuthorizationDiagnostic,
        calls[0].onAuthorizationCauseDiagnostic,
      ])
        expect(channel).not.toBe(other);
      expect(calls[0]).toMatchObject({
        cmd: "execute_authorized_stream_command",
        authorizationId,
      });
      expect(Object.keys(calls[0].message as object)).not.toContain(
        "onAuthorizationResponseDiagnostic",
      );
      // The product error is the identical single terminal frame.
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({
          type: "error",
          message: notAuthorized,
          sequence: 0,
        }),
      ]);
      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      expect(final.properties).toMatchObject({
        outcome: "acknowledged",
        terminalType: "error",
        telemetry_sample_rate: 1,
        ...responseGroup,
      });
      // Independent of the send groups: neither is invented or joined.
      expect(nativeKeys(final.properties)).toEqual([]);
      const enriched = sanitizeDesktopAckEvent({
        ...final,
        properties: { ...final.properties, $current_url: "PRIVATE" },
      });
      expect(responseKeys(enriched.properties)).toHaveLength(7);
      const serialized = JSON.stringify([captures(), enriched]);
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain(authorizationId);
      expect(serialized).not.toContain(notAuthorized);
    });

    it("keeps the response channel when the send channels cannot be created", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      jest.mocked(Channel).mockImplementationOnce(() => {
        throw new Error("channel unavailable");
      });
      const { calls, replies } = await run((call) => {
        responseChannel(call).onmessage!(rejection);
        return reject(notAuthorized);
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toHaveProperty("onAuthorizationDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationCauseDiagnostic");
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: notAuthorized }),
      ]);
      expect(finals()[0].properties).toMatchObject(responseGroup);
    });

    it("keeps the command and send channels when only the response channel cannot be created", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      const create = jest.mocked(Channel).getMockImplementation()!;
      jest
        .mocked(Channel)
        .mockImplementationOnce(create)
        .mockImplementationOnce(create)
        .mockImplementationOnce(() => {
          throw new Error("channel unavailable");
        });
      const { calls, replies } = await run((call) => {
        (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt);
        return reject(unavailable);
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveProperty("onAuthorizationDiagnostic");
      expect(calls[0]).toHaveProperty("onAuthorizationCauseDiagnostic");
      expect(calls[0]).not.toHaveProperty("onAuthorizationResponseDiagnostic");
      // A mitigation marker is never requested without its response receipt.
      expect(calls[0]).not.toHaveProperty(
        "onAuthorizationMitigationDiagnostic",
      );
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: unavailable }),
      ]);
      expect(nativeKeys(finals()[0].properties)).toHaveLength(8);
      expect(responseKeys(finals()[0].properties)).toEqual([]);
    });

    it.each<[string, () => unknown]>([
      ["an extra private field", () => ({ ...rejection, body: "PRIVATE" })],
      ["a missing field", () => ({ ...rejection, requestId: undefined })],
      ["an approval", () => ({ ...rejection, approval: "approved" })],
      [
        "a parsed non-2xx",
        () => ({ ...rejection, approval: "approved_false" }),
      ],
      ["an unchecked 2xx", () => ({ ...rejection, httpStatus: 200 })],
      ["an extension status", () => ({ ...rejection, httpStatus: 600 })],
      [
        "an ID outside the subset",
        () => ({ ...rejection, requestId: "iad1::PRIVATE" }),
      ],
      [
        "an ID with a shape that withholds it",
        () => ({ ...rejection, requestIdShape: "unrecognized" }),
      ],
      ["a send receipt on the response channel", () => receipt],
      ["a string", () => "PRIVATE"],
      [
        "a class instance",
        () =>
          Object.assign(
            Object.create({ message: "PRIVATE" }) as object,
            rejection,
          ),
      ],
      [
        "a throwing getter",
        () =>
          Object.defineProperty({ ...rejection }, "requestId", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE");
            },
          }),
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
      "drops the response receipt for %s and keeps the command",
      async (_case, value) => {
        const { calls, replies } = await run((call) => {
          responseChannel(call).onmessage!(value());
          // The malformed first attempt closed the response latch.
          responseChannel(call).onmessage!(rejection);
          return reject(notAuthorized);
        });
        expect(calls).toHaveLength(1);
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: notAuthorized }),
        ]);
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
        expect(responseKeys(finals()[0].properties)).toEqual([]);
        expect(JSON.stringify(captures())).not.toContain("PRIVATE");
      },
    );

    it("adds no response receipt to a successful command", async () => {
      await run(async (call) => {
        responseChannel(call).onmessage!(rejection);
        (call.onEvent as MockChannel).onmessage!({ type: "exit", exitCode: 0 });
      });
      expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
      expect(responseKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a response receipt after settlement and releases its callback", async () => {
      let call!: NativeCall;
      await run((native) => {
        call = native;
        return reject(notAuthorized);
      });
      const channel = responseChannel(call);
      expect(channel.cleanupCallback).toHaveBeenCalledTimes(1);
      channel.onmessage!(rejection);
      expect(finals()).toHaveLength(1);
      expect(responseKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a response receipt observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        await run((call) => {
          identity.mockReturnValue("another-user");
          responseChannel(call).onmessage!(rejection);
          identity.mockReturnValue("user-456");
          responseChannel(call).onmessage!(rejection);
          return reject(notAuthorized);
        });
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
        expect(responseKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("drops a response receipt that arrives after the connection is stopped", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          await pending;
          responseChannel(call).onmessage!(rejection);
          return reject(notAuthorized);
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
      expect(responseKeys(finals()[0].properties)).toEqual([]);
    });

    it("keeps interleaved invocations' response and send receipts separate", async () => {
      let arrived = 0;
      let release!: () => void;
      const all = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async (call) => {
          const commandId = (call.message as { commandId: string }).commandId;
          if (commandId === "approved-false")
            responseChannel(call).onmessage!({
              ...rejection,
              httpStatus: 200,
              approval: "approved_false",
              requestIdShape: "absent",
              requestId: null,
            });
          if (++arrived === 3) release();
          await all;
          if (commandId === "forbidden")
            responseChannel(call).onmessage!(rejection);
          if (commandId === "send-failure")
            (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt);
          return reject(notAuthorized);
        },
        { commandIds: ["approved-false", "forbidden", "send-failure"] },
      );
      const byCommand = Object.fromEntries(
        finals().map((event) => [
          event.properties!.commandId,
          event.properties,
        ]),
      );
      expect(byCommand["approved-false"]).toMatchObject({
        native_authorization_response_http_status: 200,
        native_authorization_response_approval: "approved_false",
        native_authorization_response_request_id: null,
      });
      expect(nativeKeys(byCommand["approved-false"])).toEqual([]);
      expect(byCommand.forbidden).toMatchObject(responseGroup);
      expect(nativeKeys(byCommand["send-failure"])).toHaveLength(8);
      expect(responseKeys(byCommand["send-failure"])).toEqual([]);
    });

    describe("mitigation marker", () => {
      const mitigation = { version: 1, mitigation: "challenge" };
      const mitigationGroup = {
        native_authorization_response_mitigation_version: 1,
        native_authorization_response_mitigation: "challenge",
      };
      const mitigationKeys = (properties: Record<string, unknown> = {}) =>
        Object.keys(properties).filter((key) =>
          NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES.has(key),
        );
      const mitigationChannel = (call: NativeCall) =>
        call.onAuthorizationMitigationDiagnostic as MockChannel;

      it("joins one same-invocation marker to the response receipt", async () => {
        const { calls, replies } = await run(async (call) => {
          mitigationChannel(call).onmessage!(mitigation);
          // A duplicate cannot replace the first callback attempt.
          mitigationChannel(call).onmessage!({
            version: 1,
            mitigation: "deny",
          });
          responseChannel(call).onmessage!(rejection);
          return Promise.reject(notAuthorized);
        });

        expect(calls).toHaveLength(1);
        const channel = mitigationChannel(calls[0]);
        expect(channel).toBeDefined();
        for (const other of [
          calls[0].onEvent,
          calls[0].onAuthorizationDiagnostic,
          calls[0].onAuthorizationCauseDiagnostic,
          calls[0].onAuthorizationResponseDiagnostic,
        ])
          expect(channel).not.toBe(other);
        expect(Object.keys(calls[0].message as object)).not.toContain(
          "onAuthorizationMitigationDiagnostic",
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({
            type: "error",
            message: notAuthorized,
            sequence: 0,
          }),
        ]);
        expect(finals()).toHaveLength(1);
        const final = finals()[0];
        expect(final.properties).toMatchObject({
          terminalType: "error",
          ...responseGroup,
          ...mitigationGroup,
        });
        expect(nativeKeys(final.properties)).toEqual([]);
        const started = captures().find(
          (event) => event.event === "desktop_ack_command_started",
        );
        expect(mitigationKeys(started?.properties)).toEqual([]);
        const enriched = sanitizeDesktopAckEvent({
          ...final,
          properties: { ...final.properties, $current_url: "PRIVATE" },
        });
        // The frozen v1 response group is unchanged beside the new group.
        expect(responseKeys(enriched.properties)).toHaveLength(7);
        expect(mitigationKeys(enriched.properties)).toHaveLength(2);
        expect(enriched.properties).toMatchObject(mitigationGroup);
        const serialized = JSON.stringify([captures(), enriched]);
        expect(serialized).not.toContain("PRIVATE");
        expect(serialized).not.toContain(authorizationId);
        expect(serialized).not.toContain(notAuthorized);
      });

      it("keeps the response receipt unchanged when an older native app sends no marker", async () => {
        const { calls } = await run((call) => {
          responseChannel(call).onmessage!(rejection);
          return reject(notAuthorized);
        });
        expect(calls[0]).toHaveProperty("onAuthorizationMitigationDiagnostic");
        expect(finals()[0].properties).toMatchObject(responseGroup);
        expect(responseKeys(finals()[0].properties)).toHaveLength(7);
        expect(mitigationKeys(finals()[0].properties)).toEqual([]);
      });

      it("reports no orphan marker and keeps the send telemetry", async () => {
        await run((call) => {
          mitigationChannel(call).onmessage!(mitigation);
          (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt);
          (call.onAuthorizationCauseDiagnostic as MockChannel).onmessage!({
            version: 1,
            ioKind: "connection_reset",
            sourceDepth: 3,
            sourceChainTruncated: false,
          });
          return reject(unavailable);
        });
        const properties = finals()[0].properties;
        expect(nativeKeys(properties)).toHaveLength(8);
        expect(
          Object.keys(properties!).filter((key) =>
            NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key),
          ),
        ).toHaveLength(4);
        expect(responseKeys(properties)).toEqual([]);
        expect(mitigationKeys(properties)).toEqual([]);
      });

      it.each<[string, () => unknown]>([
        ["an extra private field", () => ({ ...mitigation, raw: "PRIVATE" })],
        ["a missing version", () => ({ mitigation: "challenge" })],
        ["another version", () => ({ ...mitigation, version: 2 })],
        ["an unknown class", () => ({ ...mitigation, mitigation: "PRIVATE" })],
        [
          "a non-literal class",
          () => ({ ...mitigation, mitigation: "Challenge" }),
        ],
        ["a raw header string", () => "challenge"],
        ["a response receipt on the marker channel", () => rejection],
        [
          "a class instance",
          () =>
            Object.assign(
              Object.create({ raw: "PRIVATE" }) as object,
              mitigation,
            ),
        ],
        [
          "a throwing getter",
          () =>
            Object.defineProperty({ ...mitigation }, "mitigation", {
              enumerable: true,
              get() {
                throw new Error("PRIVATE");
              },
            }),
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
        "drops the marker for %s and keeps the response receipt",
        async (_case, value) => {
          const { calls, replies } = await run((call) => {
            mitigationChannel(call).onmessage!(value());
            // The malformed first attempt closed the marker latch.
            mitigationChannel(call).onmessage!(mitigation);
            responseChannel(call).onmessage!(rejection);
            return reject(notAuthorized);
          });
          expect(calls).toHaveLength(1);
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({ type: "error", message: notAuthorized }),
          ]);
          expect(finals()).toHaveLength(1);
          expect(finals()[0].properties).toMatchObject(responseGroup);
          expect(mitigationKeys(finals()[0].properties)).toEqual([]);
          expect(JSON.stringify(captures())).not.toContain("PRIVATE");
        },
      );

      it("adds no marker to a successful command", async () => {
        await run(async (call) => {
          mitigationChannel(call).onmessage!(mitigation);
          responseChannel(call).onmessage!(rejection);
          (call.onEvent as MockChannel).onmessage!({
            type: "exit",
            exitCode: 0,
          });
        });
        expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
        expect(responseKeys(finals()[0].properties)).toEqual([]);
        expect(mitigationKeys(finals()[0].properties)).toEqual([]);
      });

      it("drops a marker after settlement and releases its callback", async () => {
        let call!: NativeCall;
        await run((native) => {
          call = native;
          responseChannel(native).onmessage!(rejection);
          return reject(notAuthorized);
        });
        const channel = mitigationChannel(call);
        expect(channel.cleanupCallback).toHaveBeenCalledTimes(1);
        channel.onmessage!(mitigation);
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject(responseGroup);
        expect(mitigationKeys(finals()[0].properties)).toEqual([]);
      });

      it("drops a marker observed under another analytics owner", async () => {
        const identity = jest.mocked(getIdentifiedAnalyticsUserId);
        try {
          await run((call) => {
            responseChannel(call).onmessage!(rejection);
            identity.mockReturnValue("another-user");
            mitigationChannel(call).onmessage!(mitigation);
            identity.mockReturnValue("user-456");
            mitigationChannel(call).onmessage!(mitigation);
            return reject(notAuthorized);
          });
          expect(finals()[0].properties).toMatchObject(responseGroup);
          expect(mitigationKeys(finals()[0].properties)).toEqual([]);
        } finally {
          identity.mockReturnValue("user-456");
        }
      });

      it("drops a marker that arrives after the connection is stopped", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async (call) => {
            await pending;
            responseChannel(call).onmessage!(rejection);
            mitigationChannel(call).onmessage!(mitigation);
            return reject(notAuthorized);
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
        expect(mitigationKeys(finals()[0].properties)).toEqual([]);
      });

      it("keeps the response channel when only the marker channel cannot be created", async () => {
        const { Channel } = await import("@tauri-apps/api/core");
        const create = jest.mocked(Channel).getMockImplementation()!;
        jest
          .mocked(Channel)
          .mockImplementationOnce(create)
          .mockImplementationOnce(create)
          .mockImplementationOnce(create)
          .mockImplementationOnce(() => {
            throw new Error("channel unavailable");
          });
        const { calls, replies } = await run((call) => {
          responseChannel(call).onmessage!(rejection);
          return reject(notAuthorized);
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveProperty("onAuthorizationResponseDiagnostic");
        expect(calls[0]).not.toHaveProperty(
          "onAuthorizationMitigationDiagnostic",
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: notAuthorized }),
        ]);
        expect(finals()[0].properties).toMatchObject(responseGroup);
        expect(mitigationKeys(finals()[0].properties)).toEqual([]);
      });

      it("keeps interleaved invocations' markers separate", async () => {
        let arrived = 0;
        let release!: () => void;
        const all = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async (call) => {
            const commandId = (call.message as { commandId: string }).commandId;
            if (commandId === "denied")
              mitigationChannel(call).onmessage!({
                version: 1,
                mitigation: "deny",
              });
            if (++arrived === 3) release();
            await all;
            if (commandId !== "send-failure")
              responseChannel(call).onmessage!(rejection);
            if (commandId === "challenged")
              mitigationChannel(call).onmessage!(mitigation);
            return reject(notAuthorized);
          },
          { commandIds: ["denied", "challenged", "send-failure"] },
        );
        const byCommand = Object.fromEntries(
          finals().map((event) => [
            event.properties!.commandId,
            event.properties,
          ]),
        );
        expect(byCommand.denied).toMatchObject({
          ...responseGroup,
          native_authorization_response_mitigation: "deny",
        });
        expect(byCommand.challenged).toMatchObject({
          ...responseGroup,
          ...mitigationGroup,
        });
        expect(mitigationKeys(byCommand["send-failure"])).toEqual([]);
      });
    });

    describe("JSON read snapshot", () => {
      const invalidResponse = "Invalid Desktop authorization response";
      const jsonRejection = {
        ...rejection,
        httpStatus: 200,
        approval: "json_error",
        requestIdShape: "absent",
        requestId: null,
      };
      const jsonGroup = {
        ...responseGroup,
        native_authorization_response_http_status: 200,
        native_authorization_response_approval: "json_error",
        native_authorization_response_request_id_shape: "absent",
        native_authorization_response_request_id: null,
      };
      const read = {
        version: 1,
        kind: "body_read",
        sourceDepth: 3,
        sourceChainTruncated: false,
      };
      const readGroup = {
        native_authorization_response_read_version: 1,
        native_authorization_response_read_kind: "body_read",
        native_authorization_response_read_source_depth: 3,
        native_authorization_response_read_source_chain_truncated: false,
      };
      const readKeys = (properties: Record<string, unknown> = {}) =>
        Object.keys(properties).filter((key) =>
          NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES.has(key),
        );
      const readChannel = (call: NativeCall) =>
        call.onAuthorizationResponseReadDiagnostic as MockChannel;

      it.each(["before", "after"])(
        "joins one same-invocation snapshot delivered %s its json_error receipt",
        async (order) => {
          const { calls, replies } = await run(async (call) => {
            if (order === "after")
              responseChannel(call).onmessage!(jsonRejection);
            readChannel(call).onmessage!(read);
            // A duplicate cannot replace the first callback attempt.
            readChannel(call).onmessage!({
              ...read,
              kind: "serde_syntax",
              sourceDepth: 1,
            });
            if (order === "before")
              responseChannel(call).onmessage!(jsonRejection);
            return Promise.reject(invalidResponse);
          });

          expect(calls).toHaveLength(1);
          const channel = readChannel(calls[0]);
          expect(channel).toBeDefined();
          for (const other of [
            calls[0].onEvent,
            calls[0].onAuthorizationDiagnostic,
            calls[0].onAuthorizationCauseDiagnostic,
            calls[0].onAuthorizationResponseDiagnostic,
            calls[0].onAuthorizationMitigationDiagnostic,
            calls[0].onAuthorizationTransportDiagnostic,
            calls[0].onAuthorizationIoDiagnostic,
            calls[0].onAuthorizationConnectorDiagnostic,
          ])
            expect(channel).not.toBe(other);
          expect(calls[0]).toMatchObject({
            cmd: "execute_authorized_stream_command",
            authorizationId,
          });
          expect(Object.keys(calls[0].message as object)).not.toContain(
            "onAuthorizationResponseReadDiagnostic",
          );
          // The product error is the identical single terminal frame.
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({
              type: "error",
              message: invalidResponse,
              sequence: 0,
            }),
          ]);
          expect(finals()).toHaveLength(1);
          const final = finals()[0];
          expect(final.properties).toMatchObject({
            outcome: "acknowledged",
            terminalType: "error",
            telemetry_sample_rate: 1,
            ...jsonGroup,
            ...readGroup,
          });
          expect(nativeKeys(final.properties)).toEqual([]);
          for (const event of captures().filter(
            (event) => event.event !== "desktop_ack_command_settled",
          ))
            expect(readKeys(event.properties)).toEqual([]);
          const enriched = sanitizeDesktopAckEvent({
            ...final,
            properties: {
              ...final.properties,
              $current_url: "PRIVATE",
              native_authorization_response_read_message: "PRIVATE",
            },
          });
          // The frozen v1 response group is unchanged beside the new group.
          expect(responseKeys(enriched.properties)).toHaveLength(7);
          expect(readKeys(enriched.properties)).toHaveLength(4);
          expect(enriched.properties).toMatchObject(readGroup);
          const serialized = JSON.stringify([captures(), enriched]);
          expect(serialized).not.toContain("PRIVATE");
          expect(serialized).not.toContain(authorizationId);
          expect(serialized).not.toContain(invalidResponse);
        },
      );

      it("keeps the response receipt unchanged when an older native app sends no snapshot", async () => {
        const { calls } = await run((call) => {
          responseChannel(call).onmessage!(jsonRejection);
          return reject(invalidResponse);
        });
        expect(calls[0]).toHaveProperty(
          "onAuthorizationResponseReadDiagnostic",
        );
        expect(finals()[0].properties).toMatchObject(jsonGroup);
        expect(responseKeys(finals()[0].properties)).toHaveLength(7);
        // Missing is unknown, never defaulted to a kind.
        expect(readKeys(finals()[0].properties)).toEqual([]);
      });

      it.each<[string, (call: NativeCall) => void]>([
        [
          "no response receipt",
          (call) =>
            (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt),
        ],
        [
          "an unread non-2xx receipt",
          (call) => responseChannel(call).onmessage!(rejection),
        ],
        [
          "a decoded approved_false receipt",
          (call) =>
            responseChannel(call).onmessage!({
              ...jsonRejection,
              approval: "approved_false",
            }),
        ],
        [
          "a malformed json_error receipt",
          (call) =>
            responseChannel(call).onmessage!({
              ...jsonRejection,
              httpStatus: 403,
            }),
        ],
        [
          "a malformed first receipt followed by a valid one",
          (call) => {
            responseChannel(call).onmessage!("PRIVATE");
            responseChannel(call).onmessage!(jsonRejection);
          },
        ],
      ])("never joins a snapshot to %s", async (_case, respond) => {
        const { calls, replies } = await run((call) => {
          readChannel(call).onmessage!(read);
          respond(call);
          return reject(invalidResponse);
        });
        expect(calls).toHaveLength(1);
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: invalidResponse }),
        ]);
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
        expect(readKeys(finals()[0].properties)).toEqual([]);
        expect(JSON.stringify(captures())).not.toContain("PRIVATE");
      });

      it.each<[string, () => unknown]>([
        ["an extra private field", () => ({ ...read, message: "PRIVATE" })],
        ["a missing version", () => ({ ...read, version: undefined })],
        ["another version", () => ({ ...read, version: 2 })],
        ["a string version", () => ({ ...read, version: "1" })],
        ["an unknown kind", () => ({ ...read, kind: "PRIVATE" })],
        ["the outer decode predicate", () => ({ ...read, kind: "decode" })],
        ["a string depth", () => ({ ...read, sourceDepth: "3" })],
        ["a negative depth", () => ({ ...read, sourceDepth: -1 })],
        ["a depth beyond the budget", () => ({ ...read, sourceDepth: 9 })],
        ["a fractional depth", () => ({ ...read, sourceDepth: 1.5 })],
        ["a NaN depth", () => ({ ...read, sourceDepth: NaN })],
        ["an infinite depth", () => ({ ...read, sourceDepth: Infinity })],
        [
          "a string truncation",
          () => ({ ...read, sourceChainTruncated: "false" }),
        ],
        [
          "a truncation below the budget",
          () => ({ ...read, sourceChainTruncated: true }),
        ],
        [
          "a witnessed kind without a walked link",
          () => ({ ...read, kind: "serde_eof", sourceDepth: 0 }),
        ],
        ["a response receipt on the read channel", () => jsonRejection],
        ["a raw error string", () => "PRIVATE"],
        ["null", () => null],
        [
          "a class instance",
          () =>
            Object.assign(Object.create({ raw: "PRIVATE" }) as object, read),
        ],
        [
          "a throwing getter",
          () =>
            Object.defineProperty({ ...read }, "kind", {
              enumerable: true,
              get() {
                throw new Error("PRIVATE");
              },
            }),
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
        "drops the snapshot for %s and keeps the response receipt",
        async (_case, value) => {
          const { calls, replies } = await run((call) => {
            readChannel(call).onmessage!(value());
            // The malformed first attempt closed the snapshot latch.
            readChannel(call).onmessage!(read);
            responseChannel(call).onmessage!(jsonRejection);
            return reject(invalidResponse);
          });
          expect(calls).toHaveLength(1);
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({
              type: "error",
              message: invalidResponse,
            }),
          ]);
          expect(finals()).toHaveLength(1);
          expect(finals()[0].properties).toMatchObject(jsonGroup);
          expect(readKeys(finals()[0].properties)).toEqual([]);
          expect(JSON.stringify(captures())).not.toContain("PRIVATE");
        },
      );

      it("adds no snapshot to a successful command", async () => {
        await run(async (call) => {
          readChannel(call).onmessage!(read);
          responseChannel(call).onmessage!(jsonRejection);
          (call.onEvent as MockChannel).onmessage!({
            type: "exit",
            exitCode: 0,
          });
        });
        expect(finals()[0].properties).toMatchObject({ terminalType: "exit" });
        expect(responseKeys(finals()[0].properties)).toEqual([]);
        expect(readKeys(finals()[0].properties)).toEqual([]);
      });

      it("drops a snapshot after settlement and releases its callback", async () => {
        let call!: NativeCall;
        await run((native) => {
          call = native;
          responseChannel(native).onmessage!(jsonRejection);
          return reject(invalidResponse);
        });
        const channel = readChannel(call);
        expect(channel.cleanupCallback).toHaveBeenCalledTimes(1);
        channel.onmessage!(read);
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject(jsonGroup);
        expect(readKeys(finals()[0].properties)).toEqual([]);
      });

      it("drops a snapshot observed under another analytics owner", async () => {
        const identity = jest.mocked(getIdentifiedAnalyticsUserId);
        try {
          await run((call) => {
            responseChannel(call).onmessage!(jsonRejection);
            identity.mockReturnValue("another-user");
            readChannel(call).onmessage!(read);
            // The closed latch keeps it from attaching after the owner returns.
            identity.mockReturnValue("user-456");
            readChannel(call).onmessage!(read);
            return reject(invalidResponse);
          });
          expect(finals()[0].properties).toMatchObject(jsonGroup);
          expect(readKeys(finals()[0].properties)).toEqual([]);
        } finally {
          identity.mockReturnValue("user-456");
        }
      });

      it("drops a snapshot that arrives after the connection is stopped", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async (call) => {
            await pending;
            responseChannel(call).onmessage!(jsonRejection);
            readChannel(call).onmessage!(read);
            return reject(invalidResponse);
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
        expect(readKeys(finals()[0].properties)).toEqual([]);
      });

      // Only the read callback runs under a replaced router or connection;
      // both are restored before the invocation rejects and settles, so the
      // base receipt, the terminal frame and the settlement are unaffected.
      it.each<[string, "operationRouter" | "connectionId" | null]>([
        ["no swap (control)", null],
        ["a replaced operation router", "operationRouter"],
        ["a replaced connection", "connectionId"],
      ])(
        "joins a snapshot only when its callback is not fenced by %s",
        async (_case, field) => {
          let bridge!: DesktopSandboxBridge;
          let release!: () => void;
          const pending = new Promise<void>((resolve) => {
            release = resolve;
          });
          let restored = true;
          const { calls, replies } = await run(
            async (call) => {
              await pending;
              responseChannel(call).onmessage!(jsonRejection);
              const state = bridge as unknown as Record<string, unknown>;
              if (field) {
                const original = state[field];
                state[field] =
                  field === "connectionId" ? "conn-replaced" : { replaced: 1 };
                restored = false;
                readChannel(call).onmessage!(read);
                state[field] = original;
                restored = state[field] === original;
              } else readChannel(call).onmessage!(read);
              // The fenced first attempt closed the latch for good.
              readChannel(call).onmessage!(read);
              return reject(invalidResponse);
            },
            {
              beforeAck: async (owned) => {
                bridge = owned;
                release();
              },
            },
          );
          expect(restored).toBe(true);
          expect(calls).toHaveLength(1);
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({
              type: "error",
              message: invalidResponse,
              sequence: 0,
            }),
          ]);
          expect(finals()).toHaveLength(1);
          const properties = finals()[0].properties;
          expect(properties).toMatchObject({
            outcome: "acknowledged",
            reason: "terminal_ack",
            terminalType: "error",
            ...jsonGroup,
          });
          expect(responseKeys(properties)).toHaveLength(7);
          if (field) expect(readKeys(properties)).toEqual([]);
          else expect(properties).toMatchObject(readGroup);
          const enriched = sanitizeDesktopAckEvent({
            ...finals()[0],
            properties: { ...properties },
          });
          expect(readKeys(enriched.properties)).toHaveLength(field ? 0 : 4);
          expect(responseKeys(enriched.properties)).toHaveLength(7);
        },
      );

      it("keeps every other channel when only the read channel cannot be created", async () => {
        const { Channel } = await import("@tauri-apps/api/core");
        const create = jest.mocked(Channel).getMockImplementation()!;
        const mocked = jest.mocked(Channel);
        for (let index = 0; index < 7; index++)
          mocked.mockImplementationOnce(create);
        mocked.mockImplementationOnce(() => {
          throw new Error("channel unavailable");
        });
        const { calls, replies } = await run((call) => {
          responseChannel(call).onmessage!(jsonRejection);
          return reject(invalidResponse);
        });
        expect(calls).toHaveLength(1);
        for (const key of [
          "onEvent",
          "onAuthorizationDiagnostic",
          "onAuthorizationCauseDiagnostic",
          "onAuthorizationResponseDiagnostic",
          "onAuthorizationMitigationDiagnostic",
          "onAuthorizationTransportDiagnostic",
          "onAuthorizationIoDiagnostic",
          "onAuthorizationConnectorDiagnostic",
        ])
          expect(calls[0]).toHaveProperty(key);
        expect(calls[0]).not.toHaveProperty(
          "onAuthorizationResponseReadDiagnostic",
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: invalidResponse }),
        ]);
        expect(finals()[0].properties).toMatchObject(jsonGroup);
        expect(readKeys(finals()[0].properties)).toEqual([]);
      });

      it("never requests a snapshot without the response channel", async () => {
        const { Channel } = await import("@tauri-apps/api/core");
        const create = jest.mocked(Channel).getMockImplementation()!;
        jest
          .mocked(Channel)
          .mockImplementationOnce(create)
          .mockImplementationOnce(create)
          .mockImplementationOnce(() => {
            throw new Error("channel unavailable");
          });
        const { calls, replies } = await run(() => reject(invalidResponse));
        expect(calls[0]).not.toHaveProperty(
          "onAuthorizationResponseDiagnostic",
        );
        expect(calls[0]).not.toHaveProperty(
          "onAuthorizationResponseReadDiagnostic",
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: invalidResponse }),
        ]);
      });

      it("keeps interleaved invocations' snapshots separate", async () => {
        let arrived = 0;
        let release!: () => void;
        const all = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async (call) => {
            const commandId = (call.message as { commandId: string }).commandId;
            // This snapshot arrives first, long before its own receipt.
            if (commandId === "early-read")
              readChannel(call).onmessage!({
                ...read,
                kind: "timeout",
                sourceDepth: 2,
              });
            if (++arrived === 3) release();
            await all;
            if (commandId === "forbidden") {
              responseChannel(call).onmessage!(rejection);
              readChannel(call).onmessage!(read);
            } else responseChannel(call).onmessage!(jsonRejection);
            return reject(invalidResponse);
          },
          { commandIds: ["early-read", "forbidden", "no-read"] },
        );
        const byCommand = Object.fromEntries(
          finals().map((event) => [
            event.properties!.commandId,
            event.properties,
          ]),
        );
        expect(byCommand["early-read"]).toMatchObject({
          ...jsonGroup,
          native_authorization_response_read_kind: "timeout",
          native_authorization_response_read_source_depth: 2,
        });
        expect(byCommand.forbidden).toMatchObject(responseGroup);
        expect(readKeys(byCommand.forbidden)).toEqual([]);
        expect(byCommand["no-read"]).toMatchObject(jsonGroup);
        expect(readKeys(byCommand["no-read"])).toEqual([]);
      });
    });
  });

  describe("first terminal error kind", () => {
    const timeout = "Command timed out after 30000ms";
    const kindKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        DESKTOP_TERMINAL_ERROR_PROPERTIES.has(key),
      );
    const emit = (call: NativeCall, chunk: Record<string, unknown>) =>
      (call.onEvent as MockChannel).onmessage!(chunk);
    const kindOf = (properties: Record<string, unknown> = {}) =>
      kindKeys(properties).length
        ? {
            version: properties.desktop_terminal_error_diagnostic_version,
            kind: properties.desktop_terminal_error_kind,
          }
        : null;

    it.each<[string, (call: NativeCall) => Promise<unknown>, object, unknown]>([
      [
        "a native timeout",
        async (call) => emit(call, { type: "error", message: timeout }),
        { type: "error", message: timeout },
        "native_command_timeout",
      ],
      [
        "a native process failure",
        async (call) =>
          emit(call, { type: "error", message: "Process error: PRIVATE" }),
        { type: "error", message: "Process error: PRIVATE" },
        "native_process_error",
      ],
      [
        "an unknown native payload",
        async (call) =>
          emit(call, { type: "error", message: "PRIVATE timed out" }),
        { type: "error", message: "PRIVATE timed out" },
        "native_other",
      ],
      [
        "an invocation rejection",
        () => reject("PRIVATE rejection"),
        { type: "error", message: "PRIVATE rejection" },
        "invocation_rejected",
      ],
      [
        "a successful exit",
        async (call) => emit(call, { type: "exit", exitCode: 0 }),
        { type: "exit", exitCode: 0 },
        null,
      ],
    ])(
      "attributes %s on the acknowledged final only",
      async (_case, native, terminal, kind) => {
        const { replies } = await run(native);
        // The product wire is the identical single terminal frame.
        expect(sequencedFrames(replies[0])).toEqual([
          {
            ...terminal,
            commandId: "auth-send",
            sequence: 0,
            outputProtocol: "ack-v1",
          },
        ]);
        expect(finals()).toHaveLength(1);
        const final = finals()[0];
        expect(final.properties).toMatchObject({
          outcome: "acknowledged",
          terminalType: (terminal as { type: string }).type,
        });
        expect(kindOf(final.properties)).toEqual(kind && { version: 1, kind });
        const enriched = sanitizeDesktopAckEvent({
          ...final,
          properties: { ...final.properties, $current_url: "PRIVATE" },
        });
        expect(kindOf(enriched.properties)).toEqual(kindOf(final.properties));
        const started = captures().find(
          (event) => event.event === "desktop_ack_command_started",
        );
        expect(kindKeys(started?.properties)).toEqual([]);
        expect(JSON.stringify([captures(), enriched])).not.toContain("PRIVATE");
      },
    );

    it("keeps the first terminal's kind when later terminals and a rejection follow", async () => {
      const { replies } = await run(async (call) => {
        emit(call, { type: "stdout", data: "PRIVATE OUTPUT" });
        emit(call, { type: "error", message: timeout });
        emit(call, { type: "error", message: "Process error: PRIVATE" });
        emit(call, { type: "exit", exitCode: 1 });
        emit(call, { type: "stdout", data: "PRIVATE LATE" });
        return reject("PRIVATE rejection");
      });
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "stdout", data: "PRIVATE OUTPUT" }),
        expect.objectContaining({ type: "error", message: timeout }),
      ]);
      expect(finals()).toHaveLength(1);
      expect(finals()[0].properties).toMatchObject({
        terminalType: "error",
        desktop_terminal_error_kind: "native_command_timeout",
      });
    });

    it("adds no kind when the invocation rejects after a native exit", async () => {
      const { replies } = await run(async (call) => {
        emit(call, { type: "exit", exitCode: 0 });
        emit(call, { type: "error", message: timeout });
        return reject("PRIVATE rejection");
      });
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "exit", exitCode: 0, sequence: 0 }),
      ]);
      expect(finals()).toHaveLength(1);
      expect(finals()[0].properties).toMatchObject({
        outcome: "acknowledged",
        terminalType: "exit",
        terminalExitCode: 0,
      });
      expect(kindKeys(finals()[0].properties)).toEqual([]);
    });

    it("drops a first terminal observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        const { replies } = await run(async (call) => {
          identity.mockReturnValue("another-user");
          emit(call, { type: "error", message: timeout });
          // The closed latch keeps a rejection from attributing it instead.
          identity.mockReturnValue("user-456");
          return reject("PRIVATE rejection");
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: timeout }),
        ]);
        // The existing ACK owner gate still emits the original owner's final.
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
        expect(kindKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it.each(["bridge stop", "transport disconnect", "replacement connection"])(
      "keeps a settled final unchanged by callbacks after %s",
      async (mode) => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async (call) => {
            emit(call, { type: "error", message: "Process error: PRIVATE" });
            await pending;
            emit(call, { type: "error", message: timeout });
            return reject("PRIVATE rejection");
          },
          {
            beforeAck: async (bridge) => {
              if (mode === "transport disconnect")
                getClientHandler("disconnected")({ code: 1, reason: "closed" });
              else await bridge.stop();
              if (mode === "replacement connection") await bridge.start();
              release();
              await jest.advanceTimersByTimeAsync(0);
            },
          },
        );
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({
          outcome: "incomplete",
          reason: "stopped",
          terminalType: "error",
          terminalAcknowledged: false,
          desktop_terminal_error_diagnostic_version: 1,
          desktop_terminal_error_kind: "native_process_error",
        });
        expect(JSON.stringify(captures())).not.toContain("PRIVATE");
      },
    );

    it("attributes a legacy invocation with no protocol additions", async () => {
      const { Channel } = await import("@tauri-apps/api/core");
      const { calls } = await run(
        async (call) => emit(call, { type: "error", message: timeout }),
        { version: "0.0.72" },
      );
      expect(jest.mocked(Channel)).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0]).sort()).toEqual(
        [
          "cmd",
          "command",
          "commandId",
          "cwd",
          "env",
          "onEvent",
          "timeoutMs",
        ].sort(),
      );
      expect(calls[0].cmd).toBe("execute_stream_command");
      expect(finals()[0].properties).toMatchObject({
        terminalType: "error",
        desktop_terminal_error_kind: "native_command_timeout",
      });
    });
  });

  describe("invocation rejection message class", () => {
    const spawn = "Failed to spawn: PRIVATE (os error 2)";
    const timeout = "Command timed out after 30000ms";
    const emit = (call: NativeCall, chunk: Record<string, unknown>) =>
      (call.onEvent as MockChannel).onmessage!(chunk);
    const running = "Command is already running";
    // stream_lifecycle.rs admission denials, verbatim.
    const pageReplaced =
      "Desktop page was replaced before this command started";
    const priorCleanup =
      "Desktop is still stopping commands from a previous page. Retry shortly.";
    const stopUnconfirmed =
      "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";
    const groupKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter(
        (key) =>
          DESKTOP_INVOCATION_REJECTION_PROPERTIES.has(key) ||
          DESKTOP_INVOCATION_ADMISSION_PROPERTIES.has(key) ||
          DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES.has(key) ||
          DESKTOP_INVOCATION_UNKNOWN_PROPERTIES.has(key) ||
          DESKTOP_TERMINAL_ERROR_PROPERTIES.has(key),
      );
    const unknownOf = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).some((key) =>
        DESKTOP_INVOCATION_UNKNOWN_PROPERTIES.has(key),
      )
        ? {
            version: properties.desktop_invocation_unknown_version,
            class: properties.desktop_invocation_unknown_class,
          }
        : null;
    const spawnHintOf = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).some((key) =>
        DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES.has(key),
      )
        ? {
            version: properties.desktop_invocation_spawn_hint_version,
            hint: properties.desktop_invocation_spawn_os_code_hint,
          }
        : null;
    const rejectionOf = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).some((key) =>
        DESKTOP_INVOCATION_REJECTION_PROPERTIES.has(key),
      )
        ? {
            version: properties.desktop_invocation_rejection_version,
            reason: properties.desktop_invocation_rejection_reason,
            adapter: properties.desktop_invocation_rejection_adapter,
          }
        : null;
    const admissionOf = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).some((key) =>
        DESKTOP_INVOCATION_ADMISSION_PROPERTIES.has(key),
      )
        ? {
            version: properties.desktop_invocation_admission_version,
            reason: properties.desktop_invocation_admission_reason,
          }
        : null;

    // Every row names its hint and unknown class: a shorter row would make
    // Jest pass `done`.
    it.each<
      [
        string,
        string,
        unknown,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
    >([
      [
        "a reported 0.0.73 approval rejection",
        "0.0.73",
        "Desktop operation was not authorized",
        "authorization_not_approved",
        "authorized_native",
        null,
        null,
        null,
      ],
      [
        "a reported 0.0.74 authorization ID rejection",
        "0.0.74",
        "Invalid Desktop operation authorization",
        "authorization_id_invalid",
        "authorized_native",
        null,
        null,
        null,
      ],
      [
        "a current spawn failure",
        "0.0.80",
        spawn,
        "spawn_failed",
        "authorized_native",
        null,
        "code_2",
        null,
      ],
      [
        "a spawn failure with an unlisted OS code",
        "0.0.80",
        "Failed to spawn: PRIVATE (os error 4)",
        "spawn_failed",
        "authorized_native",
        null,
        "unrecognized",
        null,
      ],
      [
        "a spawn failure without an OS code",
        "0.0.80",
        new Error("Failed to spawn: PRIVATE"),
        "spawn_failed",
        "authorized_native",
        null,
        "unrecognized",
        null,
      ],
      [
        "an unlisted rejection",
        "0.0.80",
        "PRIVATE rejection",
        "unknown",
        "authorized_native",
        null,
        null,
        "other_string",
      ],
      [
        "a published legacy spawn failure",
        "0.0.72",
        "Failed to spawn: PRIVATE (os error 193)",
        "spawn_failed",
        "published_legacy_native",
        null,
        "code_193",
        null,
      ],
      // The six fixed execution admission templates, as Tauri rejects them.
      [
        "an update state rejection",
        "0.0.80",
        "Desktop update state unavailable",
        "execution_admission",
        "authorized_native",
        "update_state_unavailable",
        null,
        null,
      ],
      [
        "an update installing rejection",
        "0.0.80",
        "Desktop is installing an update. Reopen the app before retrying.",
        "execution_admission",
        "authorized_native",
        "update_installing",
        null,
        null,
      ],
      [
        "a stdin limit rejection",
        "0.0.80",
        "Command stdin exceeds limit",
        "execution_admission",
        "authorized_native",
        "stdin_size_limit",
        null,
        null,
      ],
      [
        "a stdin encoding rejection",
        "0.0.80",
        "Invalid command stdin encoding",
        "execution_admission",
        "authorized_native",
        "stdin_encoding_invalid",
        null,
        null,
      ],
      [
        "a poisoned command state rejection",
        "0.0.80",
        "stream command state lock poisoned",
        "execution_admission",
        "authorized_native",
        "command_state_lock_poisoned",
        null,
        null,
      ],
      [
        "a duplicate command rejection",
        "0.0.80",
        running,
        "execution_admission",
        "authorized_native",
        "command_already_running",
        null,
        null,
      ],
      [
        "a published legacy Error admission rejection",
        "0.0.72",
        new Error("Command stdin exceeds limit"),
        "execution_admission",
        "published_legacy_native",
        "stdin_size_limit",
        null,
        null,
      ],
      [
        "a changed admission template",
        "0.0.80",
        "Command is already running: PRIVATE",
        "unknown",
        "authorized_native",
        null,
        null,
        "other_string",
      ],
      // The three stream_lifecycle.rs denials, as Tauri rejects them. A
      // reported version never gates the class: the same text classifies
      // alike under any authorized native app.
      [
        "a page replacement denial",
        "0.0.82",
        pageReplaced,
        "unknown",
        "authorized_native",
        null,
        null,
        "lifecycle_page_replaced",
      ],
      [
        "a prior cleanup denial",
        "0.0.82",
        priorCleanup,
        "unknown",
        "authorized_native",
        null,
        null,
        "lifecycle_prior_cleanup_pending",
      ],
      [
        "an unconfirmed stop denial",
        "0.0.82",
        stopUnconfirmed,
        "unknown",
        "authorized_native",
        null,
        null,
        "lifecycle_stop_unconfirmed",
      ],
      [
        "an unconfirmed stop denial from another reported version",
        "0.0.80",
        stopUnconfirmed,
        "unknown",
        "authorized_native",
        null,
        null,
        "lifecycle_stop_unconfirmed",
      ],
      [
        "an Error page replacement denial",
        "0.0.82",
        new Error(pageReplaced),
        "unknown",
        "authorized_native",
        null,
        null,
        "lifecycle_page_replaced",
      ],
      [
        "an unlisted Error rejection",
        "0.0.82",
        new Error("PRIVATE Error rejection"),
        "unknown",
        "authorized_native",
        null,
        null,
        "other_error_message",
      ],
      [
        "an over-long rejection",
        "0.0.82",
        `${stopUnconfirmed}${" PRIVATE".repeat(200)}`,
        "unknown",
        "authorized_native",
        null,
        null,
        "message_over_limit",
      ],
      [
        "an unreadable rejection",
        "0.0.82",
        { message: pageReplaced },
        "unknown",
        "authorized_native",
        null,
        null,
        "message_unavailable",
      ],
      // A legacy command set never carries the unknown class.
      [
        "a published legacy lifecycle-text rejection",
        "0.0.72",
        stopUnconfirmed,
        "unknown",
        "published_legacy_native",
        null,
        null,
        null,
      ],
    ])(
      "classifies %s without changing the product frame",
      async (
        _case,
        version,
        rejection,
        reason,
        adapter,
        admission,
        hint,
        unknownClass,
      ) => {
        const message =
          rejection instanceof Error ? rejection.message : String(rejection);
        const { calls, replies } = await run(() => Promise.reject(rejection), {
          version,
        });
        // The selected command set is unchanged: no downgrade or retry.
        expect(calls.map((call) => call.cmd)).toEqual([
          adapter === "published_legacy_native"
            ? "execute_stream_command"
            : "execute_authorized_stream_command",
        ]);
        expect(sequencedFrames(replies[0])).toEqual([
          {
            type: "error",
            message,
            commandId: "auth-send",
            sequence: 0,
            outputProtocol: "ack-v1",
          },
        ]);
        expect(finals()).toHaveLength(1);
        const final = finals()[0];
        expect(final.properties).toMatchObject({
          terminalType: "error",
          desktop_terminal_error_kind: "invocation_rejected",
        });
        expect(rejectionOf(final.properties)).toEqual({
          version: 1,
          reason,
          adapter,
        });
        expect(admissionOf(final.properties)).toEqual(
          admission && { version: 1, reason: admission },
        );
        expect(spawnHintOf(final.properties)).toEqual(
          hint ? { version: 1, hint } : null,
        );
        expect(unknownOf(final.properties)).toEqual(
          unknownClass ? { version: 1, class: unknownClass } : null,
        );
        const enriched = sanitizeDesktopAckEvent({
          ...final,
          properties: { ...final.properties, $current_url: "PRIVATE" },
        });
        expect(rejectionOf(enriched.properties)).toEqual(
          rejectionOf(final.properties),
        );
        expect(admissionOf(enriched.properties)).toEqual(
          admissionOf(final.properties),
        );
        expect(spawnHintOf(enriched.properties)).toEqual(
          spawnHintOf(final.properties),
        );
        expect(unknownOf(enriched.properties)).toEqual(
          unknownOf(final.properties),
        );
        const serialized = JSON.stringify([captures(), enriched]);
        expect(serialized).not.toContain("PRIVATE");
        expect(serialized).not.toContain(message);
      },
    );

    it.each<[string, string, object | null, object | null, object | null]>([
      [
        "Invalid command stdin encoding",
        "execution_admission",
        { version: 1, reason: "stdin_encoding_invalid" },
        null,
        null,
      ],
      [
        "Failed to spawn: PRIVATE (os error 267)",
        "spawn_failed",
        null,
        { version: 1, hint: "code_267" },
        null,
      ],
      [
        priorCleanup,
        "unknown",
        null,
        null,
        { version: 1, class: "lifecycle_prior_cleanup_pending" },
      ],
    ])(
      "reads the rejection's own message %p once for every class",
      async (message, reason, admission, hint, unknownClass) => {
        let descriptorReads = 0;
        const rejection = new Proxy(new Error(message), {
          getOwnPropertyDescriptor(target, key) {
            if (key === "message") descriptorReads++;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        const { replies } = await run(() => Promise.reject(rejection));
        // The product frame still takes the existing message read.
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message }),
        ]);
        expect(descriptorReads).toBe(1);
        expect(rejectionOf(finals()[0].properties)).toEqual({
          version: 1,
          reason,
          adapter: "authorized_native",
        });
        expect(admissionOf(finals()[0].properties)).toEqual(admission);
        expect(spawnHintOf(finals()[0].properties)).toEqual(hint);
        expect(unknownOf(finals()[0].properties)).toEqual(unknownClass);
      },
    );

    it("delivers the unknown pair from one rejection without private command content", async () => {
      const cwd = "/Users/PRIVATE-CWD/project";
      const canary = "PRIVATE-CANARY https://PRIVATE.example/x";
      const host = window as unknown as Record<string, unknown>;
      const previous = {
        internals: host.__TAURI_INTERNALS__,
        os: host.__TAURI_OS_PLUGIN_INTERNALS__,
      };
      const { calls, replies } = await run(() => Promise.reject(canary), {
        version: "0.0.82",
        command: { cwd },
      });
      // One selected authorized invocation, the original product frame.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        cmd: "execute_authorized_stream_command",
        authorizationId,
        message: expect.objectContaining({ cwd }),
      });
      expect(sequencedFrames(replies[0])).toEqual([
        {
          type: "error",
          message: canary,
          commandId: "auth-send",
          sequence: 0,
          outputProtocol: "ack-v1",
        },
      ]);
      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      expect(final.properties).toMatchObject({
        outcome: "acknowledged",
        terminalType: "error",
        telemetry_sample_rate: 1,
        desktop_terminal_error_kind: "invocation_rejected",
        desktop_invocation_rejection_reason: "unknown",
        desktop_invocation_rejection_adapter: "authorized_native",
      });
      expect(unknownOf(final.properties)).toEqual({
        version: 1,
        class: "other_string",
      });
      // The SDK before_send order: privacy projection, then measured identity.
      try {
        host.__TAURI_INTERNALS__ = {};
        host.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: "windows" };
        await startDesktopRuntimeIdentityLookup();
        const sent = applyDesktopRuntimeIdentity(
          sanitizeDesktopAckEvent({
            ...final,
            properties: {
              ...final.properties,
              $current_url: "https://PRIVATE.example/chat",
              cwd,
              command: "PRIVATE COMMAND",
              authorizationId,
            },
            $set: { email: "PRIVATE" },
          }),
        );
        expect(sent.properties).toMatchObject({
          native_platform: "windows",
          desktop_invocation_rejection_reason: "unknown",
          desktop_invocation_unknown_version: 1,
          desktop_invocation_unknown_class: "other_string",
        });
        for (const serialized of [
          JSON.stringify(captures()),
          JSON.stringify(sent),
        ]) {
          expect(serialized).not.toContain("PRIVATE");
          expect(serialized).not.toContain(authorizationId);
          expect(serialized).not.toContain("https://");
        }
      } finally {
        host.__TAURI_INTERNALS__ = previous.internals;
        host.__TAURI_OS_PLUGIN_INTERNALS__ = previous.os;
      }
    });

    it("keeps an unsampled first lifecycle rejection at the diagnostic rate", async () => {
      jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
      try {
        await run(() => reject(stopUnconfirmed));
      } finally {
        jest.mocked(sampleDiagnosticOperation).mockReturnValue(true);
      }
      expect(
        captures().filter(
          (event) => event.event === "desktop_ack_command_started",
        ),
      ).toEqual([]);
      expect(finals()).toHaveLength(1);
      expect(finals()[0]).toMatchObject({
        dedupeKey: JSON.stringify(["conn-123", "auth-send"]),
        properties: { telemetry_sampled: false, telemetry_sample_rate: 1 },
      });
      expect(unknownOf(finals()[0].properties)).toEqual({
        version: 1,
        class: "lifecycle_stop_unconfirmed",
      });
    });

    it("reports no unknown class when only the legacy command rejects with a lifecycle message", async () => {
      const { calls } = await run(async (call) => {
        if (call.cmd === "execute_authorized_stream_command")
          throw "Command execute_authorized_stream_command not found";
        return reject(pageReplaced);
      });
      expect(calls.map((call) => call.cmd)).toEqual([
        "execute_authorized_stream_command",
        "execute_stream_command",
      ]);
      expect(rejectionOf(finals()[0].properties)).toEqual({
        version: 1,
        reason: "unknown",
        adapter: "compatibility_native",
      });
      expect(unknownOf(finals()[0].properties)).toBeNull();
    });

    it("keeps an unsampled first spawn rejection at the diagnostic rate", async () => {
      jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
      try {
        await run(() => reject(spawn));
      } finally {
        jest.mocked(sampleDiagnosticOperation).mockReturnValue(true);
      }
      expect(
        captures().filter(
          (event) => event.event === "desktop_ack_command_started",
        ),
      ).toEqual([]);
      expect(finals()).toHaveLength(1);
      expect(finals()[0]).toMatchObject({
        dedupeKey: JSON.stringify(["conn-123", "auth-send"]),
        properties: { telemetry_sampled: false, telemetry_sample_rate: 1 },
      });
      expect(spawnHintOf(finals()[0].properties)).toEqual({
        version: 1,
        hint: "code_2",
      });
    });

    it.each<[string, string, object | null, object | null]>([
      [
        running,
        "execution_admission",
        { version: 1, reason: "command_already_running" },
        null,
      ],
      [spawn, "spawn_failed", null, { version: 1, hint: "code_2" }],
    ])(
      "reports the compatibility command set when only the legacy command rejects with %p",
      async (message, reason, admission, hint) => {
        const { calls } = await run(async (call) => {
          if (call.cmd === "execute_authorized_stream_command")
            throw "Command execute_authorized_stream_command not found";
          return reject(message);
        });
        expect(calls.map((call) => call.cmd)).toEqual([
          "execute_authorized_stream_command",
          "execute_stream_command",
        ]);
        expect(rejectionOf(finals()[0].properties)).toEqual({
          version: 1,
          reason,
          adapter: "compatibility_native",
        });
        expect(admissionOf(finals()[0].properties)).toEqual(admission);
        expect(spawnHintOf(finals()[0].properties)).toEqual(hint);
      },
    );

    it.each([running, spawn, stopUnconfirmed])(
      "never reads a refinement of %p before a command set is selected",
      async (message) => {
        const { calls, replies } = await run(
          async () => {
            throw new Error("native command must not be invoked");
          },
          {
            afterStart: (bridge) =>
              Object.defineProperty(bridge, "nativeVersionLookup", {
                configurable: true,
                get() {
                  throw new Error(message);
                },
              }),
          },
        );
        expect(calls).toEqual([]);
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message }),
        ]);
        expect(rejectionOf(finals()[0].properties)).toEqual({
          version: 1,
          reason: "unknown",
          adapter: "not_selected",
        });
        expect(admissionOf(finals()[0].properties)).toBeNull();
        expect(spawnHintOf(finals()[0].properties)).toBeNull();
        expect(unknownOf(finals()[0].properties)).toBeNull();
      },
    );

    it("reports unknown and not_selected when the helper fails before selecting a command set", async () => {
      const lookupFailure = "PRIVATE pre-selection failure";
      const { calls, replies } = await run(
        async () => {
          throw new Error("native command must not be invoked");
        },
        {
          // The helper reads the cached version lookup into its trace just
          // before selecting a command set; failing that read rejects the
          // invocation with no adapter assigned.
          afterStart: (bridge) =>
            Object.defineProperty(bridge, "nativeVersionLookup", {
              configurable: true,
              get() {
                throw new Error(lookupFailure);
              },
            }),
        },
      );
      expect(calls).toEqual([]);
      // The product frame keeps the existing raw message unchanged.
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: lookupFailure }),
      ]);
      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      expect(final.properties).toMatchObject({
        terminalType: "error",
        desktop_terminal_error_kind: "invocation_rejected",
      });
      expect(rejectionOf(final.properties)).toEqual({
        version: 1,
        reason: "unknown",
        adapter: "not_selected",
      });
      const enriched = sanitizeDesktopAckEvent({
        ...final,
        properties: { ...final.properties, $current_url: "PRIVATE" },
      });
      expect(rejectionOf(enriched.properties)).toEqual(
        rejectionOf(final.properties),
      );
      expect(JSON.stringify([captures(), enriched])).not.toContain("PRIVATE");
    });

    it("drops an authorization class the selected legacy command cannot emit", async () => {
      await run(() => reject("Desktop operation was not authorized"), {
        version: "0.0.72",
      });
      expect(finals()[0].properties).toMatchObject({
        desktop_terminal_error_kind: "invocation_rejected",
      });
      expect(rejectionOf(finals()[0].properties)).toBeNull();
    });

    it.each<[string, string, string | null]>([
      [unavailable, "authorization_unavailable", null],
      [
        "Command stdin exceeds limit",
        "execution_admission",
        "stdin_size_limit",
      ],
    ])(
      "keeps the existing send receipt group beside the %s class",
      async (message, reason, admission) => {
        await run(async (call) => {
          (call.onAuthorizationDiagnostic as MockChannel).onmessage!(receipt);
          return reject(message);
        });
        const properties = finals()[0].properties;
        expect(properties).toMatchObject({
          native_authorization_diagnostic_version: 1,
          native_authorization_send_connect: true,
          native_app_version: "0.0.80",
          desktop_invocation_rejection_reason: reason,
          desktop_invocation_rejection_adapter: "authorized_native",
        });
        expect(admissionOf(properties)).toEqual(
          admission && { version: 1, reason: admission },
        );
        const enriched = sanitizeDesktopAckEvent({
          ...finals()[0],
          properties: { ...properties, $current_url: "PRIVATE" },
        }).properties;
        expect(enriched).toMatchObject({
          native_authorization_diagnostic_version: 1,
          desktop_invocation_rejection_reason: reason,
        });
        expect(admissionOf(enriched)).toEqual(admissionOf(properties));
      },
    );

    it.each<
      [string, (call: NativeCall) => void, string, Record<string, unknown>]
    >([
      [
        "a native exit",
        (call) => emit(call, { type: "exit", exitCode: 0 }),
        running,
        { terminalType: "exit", terminalExitCode: 0 },
      ],
      [
        "a native timeout event",
        (call) => emit(call, { type: "error", message: timeout }),
        running,
        {
          terminalType: "error",
          desktop_terminal_error_kind: "native_command_timeout",
        },
      ],
      // A missing command still spawns its shell, which exits nonzero.
      [
        "a nonzero native exit",
        (call) => emit(call, { type: "exit", exitCode: 127 }),
        spawn,
        { terminalType: "exit", terminalExitCode: 127 },
      ],
      [
        "a native process error",
        (call) => emit(call, { type: "error", message: "Process error: x" }),
        spawn,
        {
          terminalType: "error",
          desktop_terminal_error_kind: "native_process_error",
        },
      ],
      [
        "a native exit before a lifecycle denial",
        (call) => emit(call, { type: "exit", exitCode: 0 }),
        stopUnconfirmed,
        { terminalType: "exit", terminalExitCode: 0 },
      ],
      [
        "a native timeout before a lifecycle denial",
        (call) => emit(call, { type: "error", message: timeout }),
        pageReplaced,
        {
          terminalType: "error",
          desktop_terminal_error_kind: "native_command_timeout",
        },
      ],
    ])(
      "never attaches a rejection that follows %s",
      async (_case, first, message, expected) => {
        // An attachable class and refinement, were it the first terminal.
        const { replies } = await run(async (call) => {
          first(call);
          return reject(message);
        });
        // The first terminal alone reaches the product wire.
        expect(sequencedFrames(replies[0])).toHaveLength(1);
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject(expected);
        expect(rejectionOf(finals()[0].properties)).toBeNull();
        expect(admissionOf(finals()[0].properties)).toBeNull();
        expect(spawnHintOf(finals()[0].properties)).toBeNull();
        expect(unknownOf(finals()[0].properties)).toBeNull();
      },
    );

    it.each<[string, string | null]>([
      [running, "another-user"],
      [spawn, "another-user"],
      [stopUnconfirmed, "another-user"],
      // Consent withdrawn while the invocation rejects.
      [pageReplaced, null],
    ])(
      "drops a rejection %p observed under analytics owner %p",
      async (message, owner) => {
        const identity = jest.mocked(getIdentifiedAnalyticsUserId);
        try {
          await run(
            async () => {
              identity.mockReturnValue(owner);
              return reject(message);
            },
            {
              beforeAck: async () => {
                identity.mockReturnValue("user-456");
              },
            },
          );
          // The existing ACK owner gate still emits the original owner's final.
          expect(finals()).toHaveLength(1);
          expect(finals()[0].properties).toMatchObject({
            terminalType: "error",
          });
          expect(groupKeys(finals()[0].properties)).toEqual([]);
        } finally {
          identity.mockReturnValue("user-456");
        }
      },
    );

    it.each<[string, string]>([
      ["bridge stop", running],
      ["bridge stop", spawn],
      ["transport disconnect", spawn],
      ["replacement connection", spawn],
      ["bridge stop", stopUnconfirmed],
      ["transport disconnect", priorCleanup],
      ["replacement connection", pageReplaced],
    ])(
      "never attaches a rejection that arrives after %s (%p)",
      async (mode, message) => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async () => {
            await pending;
            return reject(message);
          },
          {
            beforeAck: async (bridge) => {
              if (mode === "transport disconnect")
                getClientHandler("disconnected")({ code: 1, reason: "closed" });
              else await bridge.stop();
              if (mode === "replacement connection") await bridge.start();
              release();
              await jest.advanceTimersByTimeAsync(0);
            },
          },
        );
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({
          outcome: "incomplete",
          reason: "stopped",
        });
        expect(groupKeys(finals()[0].properties)).toEqual([]);
      },
    );
  });

  describe("stream fence origin", () => {
    const stopUnconfirmed =
      "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";
    const pageReplaced =
      "Desktop page was replaced before this command started";
    const priorCleanup =
      "Desktop is still stopping commands from a previous page. Retry shortly.";
    const fence = { version: 1, origin: "cancel_wait_timeout" };
    const fenceGroup = {
      desktop_stream_fence_version: 1,
      desktop_stream_fence_origin: "cancel_wait_timeout",
    };
    // The opted-in native rejection: the exact public message beside the
    // closed origin, as Tauri delivers the command's JSON error.
    const fenced = (streamFence: unknown = fence) => ({
      message: stopUnconfirmed,
      streamFence,
    });
    const fenceKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        key.startsWith("desktop_stream_fence"),
      );

    it("unwraps an opted-in fence rejection to the exact message and joins only its origin", async () => {
      const cwd = "/Users/PRIVATE-CWD/project";
      const { calls, replies } = await run(() => Promise.reject(fenced()), {
        version: "0.0.83",
        command: { cwd },
      });

      // One authorized invocation, never retried, offered the opt-in outside
      // the unchanged signed message.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        cmd: "execute_authorized_stream_command",
        authorizationId,
        message: expect.objectContaining({ cwd }),
        includeStreamFenceOrigin: true,
        includeStreamFenceCleanup: true,
        includeStreamFenceWindowsTaskkill: true,
        includeStreamFenceWindowsTaskkillRootReport: true,
      });
      for (const optIn of [
        "includeStreamFenceOrigin",
        "includeStreamFenceCleanup",
        "includeStreamFenceWindowsTaskkill",
        "includeStreamFenceWindowsTaskkillRootReport",
      ])
        expect(Object.keys(calls[0].message as object)).not.toContain(optIn);
      // The product error is the exact original string, as one terminal.
      expect(sequencedFrames(replies[0])).toEqual([
        {
          type: "error",
          message: stopUnconfirmed,
          commandId: "auth-send",
          sequence: 0,
          outputProtocol: "ack-v1",
        },
      ]);

      expect(finals()).toHaveLength(1);
      const final = finals()[0];
      expect(final.properties).toMatchObject({
        outcome: "acknowledged",
        terminalType: "error",
        telemetry_sample_rate: 1,
        desktop_terminal_error_kind: "invocation_rejected",
        desktop_invocation_rejection_reason: "unknown",
        desktop_invocation_rejection_adapter: "authorized_native",
        desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
        ...fenceGroup,
      });
      expect(fenceKeys(final.properties)).toHaveLength(2);
      const started = captures().find(
        (event) => event.event === "desktop_ack_command_started",
      );
      expect(fenceKeys(started?.properties)).toEqual([]);
      const enriched = sanitizeDesktopAckEvent({
        ...final,
        properties: {
          ...final.properties,
          $current_url: "PRIVATE",
          cwd,
          command: "PRIVATE COMMAND",
        },
        $set: { email: "PRIVATE" },
      });
      expect(enriched.properties).toMatchObject(fenceGroup);
      expect(fenceKeys(enriched.properties)).toHaveLength(2);
      const serialized = JSON.stringify([captures(), enriched]);
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain(authorizationId);
      expect(serialized).not.toContain(stopUnconfirmed);
      expect(serialized).not.toContain("streamFence");
    });

    const getter = (key: string) => {
      const hostile = { ...fence } as Record<string, unknown>;
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get() {
          throw new Error("PRIVATE");
        },
      });
      return hostile;
    };
    const fail = () => {
      throw new Error("PRIVATE");
    };
    // [case, native, product message (null for an exit), unknown class]
    it.each<
      [
        string,
        (call: NativeCall) => Promise<unknown>,
        string | null,
        string | null,
      ]
    >([
      [
        "an older native app's exact string",
        () => reject(stopUnconfirmed),
        stopUnconfirmed,
        "lifecycle_stop_unconfirmed",
      ],
      [
        "an Error with the exact message",
        () => Promise.reject(new Error(stopUnconfirmed)),
        stopUnconfirmed,
        "lifecycle_stop_unconfirmed",
      ],
      // A malformed origin keeps only the exact public message.
      ...(
        [
          ["an unlisted origin", { ...fence, origin: "PRIVATE" }],
          ["a numeric origin", { ...fence, origin: 5 }],
          ["an unsupported version", { ...fence, version: 2 }],
          ["a string version", { ...fence, version: "1" }],
          ["a missing version", { origin: fence.origin }],
          ["an extra private field", { ...fence, pid: 4242 }],
          ["an inherited origin", Object.create(fence)],
          ["an origin getter", getter("origin")],
          [
            "a throwing proxy",
            new Proxy(
              { ...fence },
              { getPrototypeOf: fail, ownKeys: fail, get: fail },
            ),
          ],
          ["a string", "cancel_wait_timeout"],
        ] as const
      ).map(
        ([name, streamFence]) =>
          [
            `${name} beside the exact message`,
            () => Promise.reject(fenced(streamFence)),
            stopUnconfirmed,
            "lifecycle_stop_unconfirmed",
          ] as [string, (call: NativeCall) => Promise<unknown>, string, string],
      ),
      // Any other object is never unwrapped or read as a message.
      [
        "another lifecycle message",
        () => Promise.reject({ message: pageReplaced, streamFence: fence }),
        "[object Object]",
        "message_unavailable",
      ],
      [
        "an over-long message quoting the fence message",
        () =>
          Promise.reject({
            message: `${stopUnconfirmed}${" PRIVATE".repeat(200)}`,
            streamFence: fence,
          }),
        "[object Object]",
        "message_unavailable",
      ],
      [
        "a missing origin",
        () => Promise.reject({ message: stopUnconfirmed }),
        "[object Object]",
        "message_unavailable",
      ],
      [
        "an extra private field",
        () => Promise.reject({ ...fenced(), pid: 4242 }),
        "[object Object]",
        "message_unavailable",
      ],
      [
        "a message getter",
        () => {
          const hostile = { streamFence: fence } as Record<string, unknown>;
          Object.defineProperty(hostile, "message", {
            enumerable: true,
            get() {
              throw new Error("PRIVATE");
            },
          });
          return Promise.reject(hostile);
        },
        "[object Object]",
        "message_unavailable",
      ],
      [
        "an inherited rejection",
        () => Promise.reject(Object.create(fenced())),
        "[object Object]",
        "message_unavailable",
      ],
      [
        "a page replacement string",
        () => reject(pageReplaced),
        pageReplaced,
        "lifecycle_page_replaced",
      ],
      [
        "a prior cleanup string",
        () => reject(priorCleanup),
        priorCleanup,
        "lifecycle_prior_cleanup_pending",
      ],
      // Only the first terminal is attached; a later rejection is not.
      [
        "a native exit before the fence rejection",
        async (call) => {
          (call.onEvent as MockChannel).onmessage!({
            type: "exit",
            exitCode: 0,
          });
          return Promise.reject(fenced());
        },
        null,
        null,
      ],
    ])(
      "keeps the exact product message and adds no origin for %s",
      async (_case, native, message, unknownClass) => {
        const { calls, replies } = await run(native);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          includeStreamFenceOrigin: true,
          includeStreamFenceCleanup: true,
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining(
            message === null
              ? { type: "exit", exitCode: 0, sequence: 0 }
              : { type: "error", message, sequence: 0 },
          ),
        ]);
        expect(finals()).toHaveLength(1);
        const properties = finals()[0].properties;
        if (unknownClass)
          expect(properties).toMatchObject({
            desktop_invocation_rejection_adapter: "authorized_native",
            desktop_invocation_unknown_class: unknownClass,
          });
        expect(fenceKeys(properties)).toEqual([]);
        const enriched = sanitizeDesktopAckEvent({
          ...finals()[0],
          properties: { ...properties },
        });
        expect(fenceKeys(enriched.properties)).toEqual([]);
        const serialized = JSON.stringify([captures(), enriched]);
        expect(serialized).not.toContain("PRIVATE");
        expect(serialized).not.toContain("streamFence");
      },
    );

    it("never offers or unwraps the opt-in through the compatibility command", async () => {
      const { calls, replies } = await run(
        async (call) => {
          if (call.cmd === "execute_authorized_stream_command")
            throw "Command execute_authorized_stream_command not found";
          return Promise.reject(fenced());
        },
        { nativeOs: "windows" },
      );
      expect(calls.map((call) => call.cmd)).toEqual([
        "execute_authorized_stream_command",
        "execute_stream_command",
      ]);
      expect(calls[0]).toMatchObject({
        includeStreamFenceOrigin: true,
        includeStreamFenceCleanup: true,
        includeStreamFenceCancelWaitOwnerPhase: true,
      });
      expect(calls[1]).not.toHaveProperty("includeStreamFenceOrigin");
      expect(calls[1]).not.toHaveProperty("includeStreamFenceCleanup");
      expect(calls[1]).not.toHaveProperty("includeStreamFenceWindowsTaskkill");
      expect(calls[1]).not.toHaveProperty(
        "includeStreamFenceWindowsTaskkillRootReport",
      );
      expect(calls[1]).not.toHaveProperty(
        "includeStreamFenceCancelWaitOwnerPhase",
      );
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: "[object Object]" }),
      ]);
      expect(finals()[0].properties).toMatchObject({
        desktop_invocation_rejection_adapter: "compatibility_native",
      });
      expect(fenceKeys(finals()[0].properties)).toEqual([]);
    });

    it("never offers or unwraps the opt-in for a published legacy native app", async () => {
      const { calls, replies } = await run(() => Promise.reject(fenced()), {
        version: "0.0.72",
      });
      expect(calls.map((call) => call.cmd)).toEqual(["execute_stream_command"]);
      expect(calls[0]).not.toHaveProperty("includeStreamFenceOrigin");
      expect(calls[0]).not.toHaveProperty("includeStreamFenceCleanup");
      expect(calls[0]).not.toHaveProperty("includeStreamFenceWindowsTaskkill");
      expect(calls[0]).not.toHaveProperty(
        "includeStreamFenceWindowsTaskkillRootReport",
      );
      expect(sequencedFrames(replies[0])).toEqual([
        expect.objectContaining({ type: "error", message: "[object Object]" }),
      ]);
      expect(fenceKeys(finals()[0].properties)).toEqual([]);
    });

    it("never offers the opt-in without an identified analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      identity.mockReturnValue(null);
      try {
        const { calls, replies } = await run(() => reject(stopUnconfirmed), {
          nativeOs: "windows",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).not.toHaveProperty("includeStreamFenceOrigin");
        expect(calls[0]).not.toHaveProperty("includeStreamFenceCleanup");
        expect(calls[0]).not.toHaveProperty(
          "includeStreamFenceWindowsTaskkill",
        );
        expect(calls[0]).not.toHaveProperty(
          "includeStreamFenceWindowsTaskkillRootReport",
        );
        expect(calls[0]).not.toHaveProperty(
          "includeStreamFenceCancelWaitOwnerPhase",
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: stopUnconfirmed }),
        ]);
        expect(finals()).toHaveLength(0);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("keeps the exact message but drops an origin observed under another analytics owner", async () => {
      const identity = jest.mocked(getIdentifiedAnalyticsUserId);
      try {
        const { replies } = await run(
          async () => {
            identity.mockReturnValue("another-user");
            return Promise.reject(fenced());
          },
          {
            beforeAck: async () => {
              identity.mockReturnValue("user-456");
            },
          },
        );
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({ type: "error", message: stopUnconfirmed }),
        ]);
        expect(finals()).toHaveLength(1);
        expect(finals()[0].properties).toMatchObject({ terminalType: "error" });
        expect(fenceKeys(finals()[0].properties)).toEqual([]);
      } finally {
        identity.mockReturnValue("user-456");
      }
    });

    it("drops an origin whose rejection arrives after the connection is stopped", async () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await run(
        async () => {
          await pending;
          return Promise.reject(fenced());
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
      expect(fenceKeys(finals()[0].properties)).toEqual([]);
    });

    it("keeps interleaved invocations' origins separate", async () => {
      await run(
        async (call) => {
          const commandId = (call.message as { commandId: string }).commandId;
          if (commandId === "owner")
            return Promise.reject(
              fenced({ version: 1, origin: "owner_outcome_missing" }),
            );
          if (commandId === "cancel") return Promise.reject(fenced());
          return reject(stopUnconfirmed);
        },
        { commandIds: ["owner", "cancel", "none"] },
      );
      const byCommand = Object.fromEntries(
        finals().map((event) => [
          event.properties!.commandId,
          event.properties,
        ]),
      );
      expect(byCommand.owner).toMatchObject({
        desktop_stream_fence_origin: "owner_outcome_missing",
      });
      expect(byCommand.cancel).toMatchObject(fenceGroup);
      expect(fenceKeys(byCommand.none)).toEqual([]);
    });

    describe("stop cleanup failure", () => {
      const stop = { version: 1, origin: "owner_stop_requested" };
      const stopGroup = {
        desktop_stream_fence_version: 1,
        desktop_stream_fence_origin: "owner_stop_requested",
      };
      // The opted-in sibling shape: the exact message, the stop origin and
      // the closed cleanup failure, as Tauri delivers the command's JSON error.
      const withCleanup = (
        streamFenceCleanup: unknown,
        streamFence: unknown = stop,
      ) => ({ message: stopUnconfirmed, streamFence, streamFenceCleanup });

      it.each([
        "tree_unconfirmed",
        "leader_wait_timed_out",
        "leader_wait_failed",
        "tree_and_leader_wait_timed_out",
        "tree_and_leader_wait_failed",
      ])(
        "unwraps the exact message and joins the %s failure to its stop origin",
        async (failure) => {
          const cwd = "/Users/PRIVATE-CWD/project";
          const { calls, replies } = await run(
            () => Promise.reject(withCleanup({ version: 1, failure })),
            { version: "0.0.84", command: { cwd } },
          );
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({
            cmd: "execute_authorized_stream_command",
            includeStreamFenceOrigin: true,
            includeStreamFenceCleanup: true,
          });
          // The product error is the exact original string, as one terminal.
          expect(sequencedFrames(replies[0])).toEqual([
            {
              type: "error",
              message: stopUnconfirmed,
              commandId: "auth-send",
              sequence: 0,
              outputProtocol: "ack-v1",
            },
          ]);
          const cleanupGroup = {
            desktop_stream_fence_cleanup_version: 1,
            desktop_stream_fence_cleanup_failure: failure,
          };
          expect(finals()).toHaveLength(1);
          const final = finals()[0];
          expect(final.properties).toMatchObject({
            outcome: "acknowledged",
            terminalType: "error",
            terminalAcknowledged: true,
            telemetry_sample_rate: 1,
            desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
            ...stopGroup,
            ...cleanupGroup,
          });
          expect(fenceKeys(final.properties)).toHaveLength(4);
          const enriched = sanitizeDesktopAckEvent({
            ...final,
            properties: {
              ...final.properties,
              $current_url: "PRIVATE",
              cwd,
              command: "PRIVATE COMMAND",
            },
            $set: { email: "PRIVATE" },
          });
          expect(enriched.properties).toMatchObject({
            ...stopGroup,
            ...cleanupGroup,
          });
          expect(fenceKeys(enriched.properties)).toHaveLength(4);
          const serialized = JSON.stringify([captures(), enriched]);
          expect(serialized).not.toContain("PRIVATE");
          expect(serialized).not.toContain(authorizationId);
          expect(serialized).not.toContain(stopUnconfirmed);
          expect(serialized).not.toContain("streamFence");
        },
      );

      // [case, native rejection, expected fence group]
      it.each<[string, () => unknown, Record<string, unknown>]>([
        ["an older native app's exact v1 shape", () => fenced(stop), stopGroup],
        [
          "an unlisted failure",
          () => withCleanup({ version: 1, failure: "PRIVATE" }),
          stopGroup,
        ],
        [
          "an unsupported version",
          () => withCleanup({ version: 2, failure: "tree_unconfirmed" }),
          stopGroup,
        ],
        [
          "an extra private field",
          () =>
            withCleanup({ version: 1, failure: "tree_unconfirmed", pid: 4242 }),
          stopGroup,
        ],
        [
          "a failure getter",
          () =>
            withCleanup(
              Object.defineProperty({ version: 1 }, "failure", {
                enumerable: true,
                get: fail,
              }),
            ),
          stopGroup,
        ],
        [
          "a throwing proxy",
          () =>
            withCleanup(
              new Proxy(
                { version: 1, failure: "tree_unconfirmed" },
                { getPrototypeOf: fail, ownKeys: fail, get: fail },
              ),
            ),
          stopGroup,
        ],
        ["a string", () => withCleanup("tree_unconfirmed"), stopGroup],
        [
          "a sibling beside another origin",
          () => withCleanup({ version: 1, failure: "tree_unconfirmed" }, fence),
          fenceGroup,
        ],
      ])(
        "keeps the exact message and only the origin for %s",
        async (_case, native, expected) => {
          const { replies } = await run(() => Promise.reject(native()));
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({
              type: "error",
              message: stopUnconfirmed,
              sequence: 0,
            }),
          ]);
          expect(finals()).toHaveLength(1);
          const properties = finals()[0].properties;
          expect(properties).toMatchObject(expected);
          expect(fenceKeys(properties)).toEqual(Object.keys(expected));
          const enriched = sanitizeDesktopAckEvent({
            ...finals()[0],
            properties: { ...properties },
          });
          expect(fenceKeys(enriched.properties)).toEqual(Object.keys(expected));
          const serialized = JSON.stringify([captures(), enriched]);
          expect(serialized).not.toContain("PRIVATE");
          expect(serialized).not.toContain("streamFence");
          expect(serialized).not.toContain("desktop_stream_fence_cleanup");
        },
      );

      it("never unwraps the sibling through the compatibility command", async () => {
        const { replies } = await run(async (call) => {
          if (call.cmd === "execute_authorized_stream_command")
            throw "Command execute_authorized_stream_command not found";
          return Promise.reject(
            withCleanup({ version: 1, failure: "tree_unconfirmed" }),
          );
        });
        expect(sequencedFrames(replies[0])).toEqual([
          expect.objectContaining({
            type: "error",
            message: "[object Object]",
          }),
        ]);
        expect(fenceKeys(finals()[0].properties)).toEqual([]);
      });

      it("drops both groups when the rejection arrives after the connection is stopped", async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await run(
          async () => {
            await pending;
            return Promise.reject(
              withCleanup({ version: 1, failure: "leader_wait_failed" }),
            );
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
        expect(fenceKeys(finals()[0].properties)).toEqual([]);
      });

      it("keeps the cleanup failure with its own invocation only", async () => {
        await run(
          async (call) => {
            const commandId = (call.message as { commandId: string }).commandId;
            if (commandId === "stop")
              return Promise.reject(
                withCleanup({ version: 1, failure: "tree_unconfirmed" }),
              );
            if (commandId === "older") return Promise.reject(fenced(stop));
            return Promise.reject(fenced());
          },
          { commandIds: ["stop", "older", "cancel"] },
        );
        const byCommand = Object.fromEntries(
          finals().map((event) => [
            event.properties!.commandId,
            event.properties,
          ]),
        );
        expect(byCommand.stop).toMatchObject({
          ...stopGroup,
          desktop_stream_fence_cleanup_failure: "tree_unconfirmed",
        });
        expect(fenceKeys(byCommand.older)).toEqual(Object.keys(stopGroup));
        expect(fenceKeys(byCommand.cancel)).toEqual(Object.keys(fenceGroup));
      });

      describe("Windows taskkill receipt", () => {
        const tree = { version: 1, failure: "tree_unconfirmed" };
        const treeGroup = {
          ...stopGroup,
          desktop_stream_fence_cleanup_version: 1,
          desktop_stream_fence_cleanup_failure: "tree_unconfirmed",
        };
        // The opted-in shape: the tree_unconfirmed sibling beside the closed
        // taskkill receipt, as Tauri delivers the command's JSON error.
        const withTaskkill = (
          streamFenceWindowsTaskkill: unknown,
          cleanup: unknown = tree,
        ) => ({ ...withCleanup(cleanup), streamFenceWindowsTaskkill });

        it.each<[unknown, Record<string, unknown>]>([
          [
            { version: 1, outcome: "nonzero_exit", exitCode: 128 },
            {
              desktop_stream_fence_windows_taskkill_version: 1,
              desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
              desktop_stream_fence_windows_taskkill_exit_code: 128,
            },
          ],
          [
            { version: 1, outcome: "output_error" },
            {
              desktop_stream_fence_windows_taskkill_version: 1,
              desktop_stream_fence_windows_taskkill_outcome: "output_error",
            },
          ],
          // A current native app's v2 receipt adds only the root report pair
          // beside the unchanged v1 group.
          [
            {
              version: 2,
              outcome: "nonzero_exit",
              exitCode: 128,
              rootReport: "requested_pid_not_found",
            },
            {
              desktop_stream_fence_windows_taskkill_version: 1,
              desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
              desktop_stream_fence_windows_taskkill_exit_code: 128,
              desktop_stream_fence_windows_taskkill_root_report_version: 1,
              desktop_stream_fence_windows_taskkill_root_report:
                "requested_pid_not_found",
            },
          ],
          [
            {
              version: 2,
              outcome: "nonzero_exit",
              exitCode: 255,
              rootReport: "unclassified",
            },
            {
              desktop_stream_fence_windows_taskkill_version: 1,
              desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
              desktop_stream_fence_windows_taskkill_exit_code: 255,
              desktop_stream_fence_windows_taskkill_root_report_version: 1,
              desktop_stream_fence_windows_taskkill_root_report: "unclassified",
            },
          ],
        ])(
          "unwraps the exact message and joins %j to its tree_unconfirmed stop",
          async (receipt, taskkillGroup) => {
            const cwd = "/Users/PRIVATE-CWD/project";
            const { calls, replies } = await run(
              () => Promise.reject(withTaskkill(receipt)),
              { version: "0.0.85", command: { cwd } },
            );
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
              cmd: "execute_authorized_stream_command",
              includeStreamFenceOrigin: true,
              includeStreamFenceCleanup: true,
              includeStreamFenceWindowsTaskkill: true,
              includeStreamFenceWindowsTaskkillRootReport: true,
            });
            expect(sequencedFrames(replies[0])).toEqual([
              {
                type: "error",
                message: stopUnconfirmed,
                commandId: "auth-send",
                sequence: 0,
                outputProtocol: "ack-v1",
              },
            ]);
            const expected = { ...treeGroup, ...taskkillGroup };
            expect(finals()).toHaveLength(1);
            const final = finals()[0];
            expect(final.properties).toMatchObject({
              outcome: "acknowledged",
              terminalAcknowledged: true,
              telemetry_sample_rate: 1,
              desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
              ...expected,
            });
            expect(fenceKeys(final.properties)).toEqual(Object.keys(expected));
            const enriched = sanitizeDesktopAckEvent({
              ...final,
              properties: {
                ...final.properties,
                $current_url: "PRIVATE",
                cwd,
                command: "PRIVATE COMMAND",
                pid: 4242,
              },
              $set: { email: "PRIVATE" },
            });
            expect(enriched.properties).toMatchObject(expected);
            expect(fenceKeys(enriched.properties)).toEqual(
              Object.keys(expected),
            );
            expect(enriched.properties).not.toHaveProperty("pid");
            const serialized = JSON.stringify([captures(), enriched]);
            expect(serialized).not.toContain("PRIVATE");
            expect(serialized).not.toContain(authorizationId);
            expect(serialized).not.toContain(stopUnconfirmed);
            expect(serialized).not.toContain("streamFence");
          },
        );

        // [case, native rejection, expected fence groups]
        it.each<[string, () => unknown, Record<string, unknown>]>([
          [
            "the prior tree_unconfirmed shape",
            () => withCleanup(tree),
            treeGroup,
          ],
          [
            "a zero code",
            () =>
              withTaskkill({
                version: 1,
                outcome: "nonzero_exit",
                exitCode: 0,
              }),
            treeGroup,
          ],
          [
            "a code beside output_error",
            () =>
              withTaskkill({
                version: 1,
                outcome: "output_error",
                exitCode: 1,
              }),
            treeGroup,
          ],
          [
            "an extra private field",
            () =>
              withTaskkill({
                version: 1,
                outcome: "output_error",
                stderr: "PRIVATE",
              }),
            treeGroup,
          ],
          [
            "an unsupported version",
            () => withTaskkill({ version: 2, outcome: "output_error" }),
            treeGroup,
          ],
          [
            "a not-found report beside exit 255",
            () =>
              withTaskkill({
                version: 2,
                outcome: "nonzero_exit",
                exitCode: 255,
                rootReport: "requested_pid_not_found",
              }),
            treeGroup,
          ],
          [
            "a raw taskkill line as the report",
            () =>
              withTaskkill({
                version: 2,
                outcome: "nonzero_exit",
                exitCode: 128,
                rootReport: 'ERROR: The process "PRIVATE" not found.',
              }),
            treeGroup,
          ],
          [
            "a v1 receipt carrying a report",
            () =>
              withTaskkill({
                version: 1,
                outcome: "nonzero_exit",
                exitCode: 128,
                rootReport: "requested_pid_not_found",
              }),
            treeGroup,
          ],
          [
            "a receipt beside another cleanup failure",
            () =>
              withTaskkill(
                { version: 1, outcome: "output_error" },
                { version: 1, failure: "leader_wait_timed_out" },
              ),
            {
              ...stopGroup,
              desktop_stream_fence_cleanup_version: 1,
              desktop_stream_fence_cleanup_failure: "leader_wait_timed_out",
            },
          ],
        ])(
          "keeps the exact message and only the prior groups for %s",
          async (_case, native, expected) => {
            const { replies } = await run(() => Promise.reject(native()));
            expect(sequencedFrames(replies[0])).toEqual([
              expect.objectContaining({
                type: "error",
                message: stopUnconfirmed,
                sequence: 0,
              }),
            ]);
            expect(finals()).toHaveLength(1);
            const properties = finals()[0].properties;
            expect(properties).toMatchObject(expected);
            expect(fenceKeys(properties)).toEqual(Object.keys(expected));
            const enriched = sanitizeDesktopAckEvent({
              ...finals()[0],
              properties: { ...properties },
            });
            expect(fenceKeys(enriched.properties)).toEqual(
              Object.keys(expected),
            );
            const serialized = JSON.stringify([captures(), enriched]);
            expect(serialized).not.toContain("PRIVATE");
            expect(serialized).not.toContain("streamFence");
            expect(serialized).not.toContain(
              "desktop_stream_fence_windows_taskkill",
            );
          },
        );
      });
    });

    describe("cancel wait owner phase", () => {
      const ownerPhase = { version: 1, phase: "stop_cleanup_tree_pending" };
      const withPhase = (
        streamFenceCancelWaitOwnerPhase: unknown,
        streamFence: unknown = fence,
      ) => ({ ...fenced(streamFence), streamFenceCancelWaitOwnerPhase });
      const phaseGroup = {
        desktop_stream_fence_cancel_wait_owner_phase_version: 1,
        desktop_stream_fence_cancel_wait_owner_phase:
          "stop_cleanup_tree_pending",
      };
      // The final as the analytics client would enrich and then sanitize it.
      const sanitized = (properties: Record<string, unknown>) =>
        sanitizeDesktopAckEvent({
          ...finals()[0],
          properties: { ...properties },
        });

      it("offers Windows Desktop the opt-in and joins its phase to the timeout origin", async () => {
        const cwd = "C:\\Users\\PRIVATE-CWD\\project";
        const { calls, replies } = await run(
          () => Promise.reject(withPhase(ownerPhase)),
          { version: "0.0.86", nativeOs: "windows", command: { cwd } },
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          cmd: "execute_authorized_stream_command",
          includeStreamFenceOrigin: true,
          includeStreamFenceCancelWaitOwnerPhase: true,
        });
        expect(Object.keys(calls[0].message as object)).not.toContain(
          "includeStreamFenceCancelWaitOwnerPhase",
        );
        // The product error is the exact original string, as one terminal.
        expect(sequencedFrames(replies[0])).toEqual([
          {
            type: "error",
            message: stopUnconfirmed,
            commandId: "auth-send",
            sequence: 0,
            outputProtocol: "ack-v1",
          },
        ]);
        const expected = { ...fenceGroup, ...phaseGroup };
        expect(finals()).toHaveLength(1);
        const final = finals()[0];
        expect(final.properties).toMatchObject({
          outcome: "acknowledged",
          terminalAcknowledged: true,
          desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
          ...expected,
        });
        expect(fenceKeys(final.properties)).toEqual(Object.keys(expected));
        const enriched = sanitizeDesktopAckEvent({
          ...final,
          properties: {
            ...final.properties,
            $current_url: "PRIVATE",
            cwd,
            command: "PRIVATE COMMAND",
            pid: 4242,
          },
          $set: { email: "PRIVATE" },
        });
        expect(enriched.properties).toMatchObject(expected);
        expect(fenceKeys(enriched.properties)).toEqual(Object.keys(expected));
        expect(enriched.properties).not.toHaveProperty("pid");
        const serialized = JSON.stringify([captures(), enriched]);
        expect(serialized).not.toContain("PRIVATE");
        expect(serialized).not.toContain(authorizationId);
        expect(serialized).not.toContain(stopUnconfirmed);
        expect(serialized).not.toContain("streamFence");
      });

      it.each(["macos", "linux"])(
        "never offers %s Desktop the opt-in or keeps a phase it never requested",
        async (nativeOs) => {
          const { calls, replies } = await run(
            () => Promise.reject(withPhase(ownerPhase)),
            { nativeOs },
          );
          expect(calls).toHaveLength(1);
          // The existing opt-ins are unchanged.
          expect(calls[0]).toMatchObject({
            includeStreamFenceOrigin: true,
            includeStreamFenceCleanup: true,
            includeStreamFenceWindowsTaskkill: true,
            includeStreamFenceWindowsTaskkillRootReport: true,
          });
          expect(calls[0]).not.toHaveProperty(
            "includeStreamFenceCancelWaitOwnerPhase",
          );
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({
              type: "error",
              message: stopUnconfirmed,
              sequence: 0,
            }),
          ]);
          expect(finals()).toHaveLength(1);
          const properties = finals()[0].properties;
          expect(properties).toMatchObject(fenceGroup);
          expect(fenceKeys(properties)).toEqual(Object.keys(fenceGroup));
          const enriched = sanitized(properties);
          expect(fenceKeys(enriched.properties)).toEqual(
            Object.keys(fenceGroup),
          );
          const serialized = JSON.stringify([captures(), enriched]);
          expect(serialized).not.toContain("cancel_wait_owner_phase");
          expect(serialized).not.toContain("streamFence");
        },
      );

      const phaseGetter = () => {
        const hostile = { version: 1 } as Record<string, unknown>;
        Object.defineProperty(hostile, "phase", {
          enumerable: true,
          get() {
            throw new Error("PRIVATE");
          },
        });
        return hostile;
      };
      // [case, native rejection, expected fence groups]
      it.each<[string, () => unknown, Record<string, unknown>]>([
        // A current frontend beside a native app without the sibling.
        ["an older native app's origin alone", () => fenced(), fenceGroup],
        [
          "an unlisted phase",
          () => withPhase({ version: 1, phase: "PRIVATE" }),
          fenceGroup,
        ],
        [
          "an extra duration",
          () => withPhase({ ...ownerPhase, elapsedMs: 15_000 }),
          fenceGroup,
        ],
        [
          "an extra private field",
          () => withPhase({ ...ownerPhase, pid: "PRIVATE" }),
          fenceGroup,
        ],
        [
          "an unsupported version",
          () => withPhase({ ...ownerPhase, version: 2 }),
          fenceGroup,
        ],
        ["a phase getter", () => withPhase(phaseGetter()), fenceGroup],
        [
          "a phase beside another origin",
          () => withPhase(ownerPhase, { version: 1, origin: "owner_timeout" }),
          { ...fenceGroup, desktop_stream_fence_origin: "owner_timeout" },
        ],
      ])(
        "keeps the exact message and only the origin for %s on Windows",
        async (_case, native, expected) => {
          const { calls, replies } = await run(() => Promise.reject(native()), {
            nativeOs: "windows",
          });
          expect(calls[0]).toMatchObject({
            includeStreamFenceOrigin: true,
            includeStreamFenceCancelWaitOwnerPhase: true,
          });
          expect(sequencedFrames(replies[0])).toEqual([
            expect.objectContaining({
              type: "error",
              message: stopUnconfirmed,
              sequence: 0,
            }),
          ]);
          expect(finals()).toHaveLength(1);
          const properties = finals()[0].properties;
          expect(properties).toMatchObject(expected);
          expect(fenceKeys(properties)).toEqual(Object.keys(expected));
          const enriched = sanitized(properties);
          expect(fenceKeys(enriched.properties)).toEqual(Object.keys(expected));
          const serialized = JSON.stringify([captures(), enriched]);
          expect(serialized).not.toContain("PRIVATE");
          expect(serialized).not.toContain("streamFence");
          expect(serialized).not.toContain("cancel_wait_owner_phase");
        },
      );
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
      // optional receipt, cause, response, mitigation, transport, IO,
      // connector and response-read channels besides the output one, or
      // offers the stream fence opt-in.
      expect(jest.mocked(Channel)).toHaveBeenCalledTimes(
        options?.version || options?.acknowledged === false ? 1 : 9,
      );
      const optional = [
        "onAuthorizationDiagnostic",
        "onAuthorizationCauseDiagnostic",
        "onAuthorizationResponseDiagnostic",
        "onAuthorizationMitigationDiagnostic",
        "onAuthorizationTransportDiagnostic",
        "onAuthorizationIoDiagnostic",
        "onAuthorizationConnectorDiagnostic",
        "onAuthorizationResponseReadDiagnostic",
        "includeStreamFenceOrigin",
        "includeStreamFenceCleanup",
        "includeStreamFenceWindowsTaskkill",
        "includeStreamFenceWindowsTaskkillRootReport",
        "includeStreamFenceCancelWaitOwnerPhase",
      ];
      const legacy = calls.filter(
        (call) => call.cmd === "execute_stream_command",
      );
      const authorized = calls.filter(
        (call) => call.cmd === "execute_authorized_stream_command",
      );
      if (options?.acknowledged === false) {
        expect(authorized).toHaveLength(1);
        for (const key of optional)
          expect(authorized[0]).not.toHaveProperty(key);
      } else {
        expect(legacy).toHaveLength(1);
        expect(legacy[0]).toHaveProperty("onEvent");
        for (const key of optional) expect(legacy[0]).not.toHaveProperty(key);
        expect(authorized).toHaveLength(options?.version ? 0 : 1);
      }
    },
  );
});
