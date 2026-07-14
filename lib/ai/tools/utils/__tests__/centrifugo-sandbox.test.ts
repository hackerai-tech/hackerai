/**
 * Tests for CentrifugoSandbox real-time command relay.
 *
 * Background:
 * - CentrifugoSandbox uses Centrifuge pub/sub for command streaming
 * - Each command creates a WebSocket subscription and publishes via HTTP
 * - Proper cleanup of clients and subscriptions prevents memory leaks
 */

import { EventEmitter } from "events";
import { CentrifugoSandbox, parseSandboxMessage } from "../centrifugo-sandbox";
import type { CentrifugoConfig } from "../centrifugo-sandbox";

// Track all created mock subscriptions and clients for assertions
let mockSubscriptions: MockSubscription[];
let mockClients: MockCentrifugeClient[];

class MockSubscription extends EventEmitter {
  subscribe = jest.fn();
  unsubscribe = jest.fn();
  publish = jest.fn().mockResolvedValue(undefined);
  presence = jest.fn().mockResolvedValue({
    clients: {
      "sandbox-client": {
        connInfo: { connectionId: "conn-1" },
      },
    },
  });
}

class MockCentrifugeClient extends EventEmitter {
  connect = jest.fn();
  disconnect = jest.fn();

  newSubscription = jest.fn(() => {
    const sub = new MockSubscription();
    mockSubscriptions.push(sub);
    return sub;
  });
}

jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn(() => {
    const client = new MockCentrifugeClient();
    mockClients.push(client);
    return client;
  }),
}));

jest.mock("@/lib/centrifugo/jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("mock-jwt-token"),
}));

jest.mock("@/lib/centrifugo/types", () => ({
  sandboxConnectionChannel: jest.fn(
    (userId: string, connectionId: string) =>
      `sandbox:connection:${connectionId}#${userId}`,
  ),
}));

// Use a stable UUID for assertions
const FIXED_UUID = "cmd-test-uuid-1234";
const originalRandomUUID = crypto.randomUUID;

const defaultConfig: CentrifugoConfig = {
  wsUrl: "ws://centrifugo:8000/connection/websocket",
  tokenSecret: "test-secret",
};

const defaultConnection = {
  connectionId: "conn-1",
  name: "test-sandbox",
};

const PRODUCTION_COMMAND_TIMEOUT_MESSAGE =
  "[deadline_exceeded] the operation timed out: This error is likely due to exceeding 'timeoutMs' - the total time a long running request (like command execution or directory watch) can be active.";

function createSandbox(
  overrides?: Partial<typeof defaultConnection>,
): CentrifugoSandbox {
  return new CentrifugoSandbox(
    "user-1",
    { ...defaultConnection, ...overrides },
    defaultConfig,
  );
}

function createDesktopSandbox(workingDirectory?: string): CentrifugoSandbox {
  return new CentrifugoSandbox(
    "user-1",
    {
      ...defaultConnection,
      isDesktop: true,
      capabilities: { commands: true, pty: true, files: true },
      osInfo: {
        platform: "win32",
        arch: "x64",
        release: "10.0.22631",
        hostname: "WIN-DEV",
      },
    },
    defaultConfig,
    workingDirectory,
  );
}

/**
 * Helper: starts a command, then simulates publication messages from the sandbox client.
 * Returns the promise and the subscription so the caller can emit messages.
 */
function startCommand(
  sandbox: CentrifugoSandbox,
  command: string,
  opts?: Parameters<typeof sandbox.commands.run>[1],
) {
  const promise = sandbox.commands.run(command, opts);

  // The subscription is created synchronously inside the promise constructor,
  // but we need to wait a tick for the async generateCentrifugoToken to resolve.
  return { promise };
}

describe("CentrifugoSandbox", () => {
  beforeEach(() => {
    mockSubscriptions = [];
    mockClients = [];
    jest.useFakeTimers();
    crypto.randomUUID = jest.fn(() => FIXED_UUID) as any;
  });

  afterEach(() => {
    jest.useRealTimers();
    crypto.randomUUID = originalRandomUUID;
  });

  describe("parseSandboxMessage", () => {
    it("ignores known PTY traffic without warning", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      try {
        expect(
          parseSandboxMessage({
            type: "pty_create",
            sessionId: "pty-1",
            command: "bash",
          }),
        ).toBeNull();
        expect(
          parseSandboxMessage({
            type: "pty_data",
            sessionId: "pty-1",
            data: "hello",
          }),
        ).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("still warns for truly unknown message types", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      try {
        expect(
          parseSandboxMessage({
            type: "something_else",
            commandId: FIXED_UUID,
          }),
        ).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          "Invalid sandbox message: unknown type",
          "something_else",
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("commands.run happy path", () => {
    it("uses the project folder as the default cwd", async () => {
      const sandbox = createDesktopSandbox("C:\\work\\hackerai");
      const { promise } = startCommand(sandbox, "git status", {
        timeoutMs: 5000,
      });

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "command",
          command: "git status",
          cwd: "C:\\work\\hackerai",
        }),
      );

      sub.emit("publication", {
        data: { type: "exit", commandId: FIXED_UUID, exitCode: 0 },
      });
      await expect(promise).resolves.toEqual({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    });

    it("subscribes, receives stdout/stderr/exit messages, and returns aggregated result", async () => {
      const sandbox = createSandbox();
      const onStdout = jest.fn();
      const onStderr = jest.fn();

      const { promise } = startCommand(sandbox, "echo hello", {
        timeoutMs: 5000,
        onStdout,
        onStderr,
      });

      // Wait for async token generation
      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      expect(sub).toBeDefined();
      expect(mockClients[0].newSubscription).toHaveBeenCalledWith(
        "sandbox:connection:conn-1#user-1",
      );

      // Simulate "subscribed" event, then publications
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      sub.emit("publication", {
        data: { type: "stdout", commandId: FIXED_UUID, data: "hello\n" },
      });
      sub.emit("publication", {
        data: { type: "stderr", commandId: FIXED_UUID, data: "warn\n" },
      });
      sub.emit("publication", {
        data: { type: "exit", commandId: FIXED_UUID, exitCode: 0, pid: 42 },
      });

      const result = await promise;

      expect(result).toEqual({
        stdout: "hello\n",
        stderr: "warn\n",
        exitCode: 0,
        pid: 42,
      });
      expect(onStdout).toHaveBeenCalledWith("hello\n");
      expect(onStderr).toHaveBeenCalledWith("warn\n");
    });
  });

  describe("commands.run timeout", () => {
    it("rejects with timeout error when command exceeds maxWaitTime", async () => {
      const sandbox = createSandbox();
      const timeoutMs = 1000;

      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      sub.emit("subscribed");

      // maxWaitTime = timeoutMs + 5000
      jest.advanceTimersByTime(timeoutMs + 5000 + 1);

      await expect(promise).rejects.toThrow(
        `Command timeout after ${timeoutMs + 5000}ms`,
      );
    });

    it("does not count the echoed command publication as the first response", async () => {
      const sandbox = createSandbox();
      const timeoutMs = 1000;

      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      sub.emit("publication", {
        data: {
          type: "command",
          commandId: FIXED_UUID,
          command: "sleep 999",
        },
      });

      jest.advanceTimersByTime(timeoutMs + 5000 + 1);

      await expect(promise).rejects.toThrow("firstMsg: no");
    });

    it("fails before publishing when the target connection is absent from channel presence", async () => {
      const sandbox = createSandbox();

      const { promise } = startCommand(sandbox, "echo lost", {
        timeoutMs: 1000,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      sub.presence.mockResolvedValueOnce({
        clients: {
          "probe-client": {
            user: "user-1",
          },
        },
      });

      const rejection = expect(promise).rejects.toThrow(
        "is not subscribed to the command relay",
      );

      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      await rejection;
      expect(sub.publish).not.toHaveBeenCalled();
      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(mockClients[0].disconnect).toHaveBeenCalled();
    });
  });

  describe("commands.run cleanup", () => {
    it("disconnects client and removes it from activeClients after completion", async () => {
      const sandbox = createSandbox();

      const { promise } = startCommand(sandbox, "echo done", {
        timeoutMs: 5000,
      });

      await jest.advanceTimersByTimeAsync(0);

      const client = mockClients[0];
      const sub = mockSubscriptions[0];

      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      sub.emit("publication", {
        data: { type: "exit", commandId: FIXED_UUID, exitCode: 0 },
      });

      await promise;

      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
      expect((sandbox as any).activeClients).toHaveLength(0);
    });

    it("disconnects client and removes it from activeClients after timeout", async () => {
      const sandbox = createSandbox();

      const { promise } = startCommand(sandbox, "hang", { timeoutMs: 100 });

      await jest.advanceTimersByTimeAsync(0);

      const client = mockClients[0];

      jest.advanceTimersByTime(100 + 5000 + 1);

      await expect(promise).rejects.toThrow("timeout");

      expect(client.disconnect).toHaveBeenCalled();
      expect((sandbox as any).activeClients).toHaveLength(0);
    });
  });

  describe("commands.run cancellation", () => {
    it("resolves with exitCode 130 only after a positive cancellation acknowledgement", async () => {
      const sandbox = createSandbox();
      const abortController = new AbortController();

      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 5000,
        signal: abortController.signal,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      const client = mockClients[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "command",
          commandId: FIXED_UUID,
          command: "sleep 999",
        }),
      );

      abortController.abort();
      await jest.advanceTimersByTimeAsync(0);

      let settled = false;
      void promise.finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      sub.emit("publication", {
        data: {
          type: "command_cancel_result",
          commandId: FIXED_UUID,
          canceled: true,
        },
      });

      await expect(promise).resolves.toMatchObject({
        exitCode: 130,
      });
      expect(sub.publish).toHaveBeenCalledWith({
        type: "command_cancel",
        commandId: FIXED_UUID,
        targetConnectionId: "conn-1",
      });
      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
    });

    it("rejects and keeps cancellation distinct when the native runner reports false", async () => {
      const sandbox = createSandbox();
      const abortController = new AbortController();
      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 5000,
        signal: abortController.signal,
      });

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      abortController.abort();
      await jest.advanceTimersByTimeAsync(0);
      sub.emit("publication", {
        data: {
          type: "command_cancel_result",
          commandId: FIXED_UUID,
          canceled: false,
        },
      });

      await expect(promise).rejects.toThrow(
        "Local command cancellation was not confirmed",
      );
    });

    it("rejects when publishing the cancellation fails", async () => {
      const sandbox = createSandbox();
      const abortController = new AbortController();
      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 5000,
        signal: abortController.signal,
      });

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.publish = jest.fn((msg: { type: string }) =>
        msg.type === "command_cancel"
          ? Promise.reject(new Error("relay unavailable"))
          : Promise.resolve(),
      );
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      const rejection = expect(promise).rejects.toThrow(
        "Failed to publish local command cancellation",
      );
      abortController.abort();
      await jest.advanceTimersByTimeAsync(0);

      await rejection;
    });

    it("rejects when no cancellation acknowledgement arrives", async () => {
      const sandbox = createSandbox();
      const abortController = new AbortController();
      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 10000,
        signal: abortController.signal,
      });

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      abortController.abort();
      await jest.advanceTimersByTimeAsync(0);
      jest.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow(
        "Local command cancellation was not acknowledged",
      );
    });

    it("times out a stalled cancellation publish and ignores its late rejection", async () => {
      const sandbox = createSandbox();
      let cancel!: () => Promise<boolean>;
      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 10000,
        onCancelReady: (readyCancel) => {
          cancel = readyCancel;
        },
      });

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      let rejectFirstPublish!: (error: Error) => void;
      let cancellationPublishes = 0;
      sub.publish = jest.fn((message: { type: string }) => {
        if (message.type !== "command_cancel") return Promise.resolve();
        cancellationPublishes += 1;
        if (cancellationPublishes === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectFirstPublish = reject;
          });
        }
        return Promise.resolve();
      });

      const firstAttempt = cancel();
      await jest.advanceTimersByTimeAsync(5001);
      await expect(firstAttempt).resolves.toBe(false);

      const secondAttempt = cancel();
      await jest.advanceTimersByTimeAsync(0);
      rejectFirstPublish(new Error("late relay failure"));
      await jest.advanceTimersByTimeAsync(0);

      sub.emit("publication", {
        data: {
          type: "command_cancel_result",
          commandId: FIXED_UUID,
          canceled: true,
        },
      });

      await expect(secondAttempt).resolves.toBe(true);
      await expect(promise).resolves.toMatchObject({ exitCode: 130 });
    });

    it("keeps the command live after an uncertain callback cancellation so it can be retried", async () => {
      const sandbox = createSandbox();
      let cancel!: () => Promise<boolean>;
      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 10000,
        onCancelReady: (readyCancel) => {
          cancel = readyCancel;
        },
      });

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      const firstAttempt = cancel();
      await jest.advanceTimersByTimeAsync(0);
      sub.emit("publication", {
        data: {
          type: "command_cancel_result",
          commandId: FIXED_UUID,
          canceled: false,
        },
      });
      await expect(firstAttempt).resolves.toBe(false);
      expect(sub.unsubscribe).not.toHaveBeenCalled();

      let commandSettled = false;
      void promise.then(() => {
        commandSettled = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(commandSettled).toBe(false);

      const secondAttempt = cancel();
      await jest.advanceTimersByTimeAsync(0);
      expect(
        sub.publish.mock.calls.filter(
          ([message]) => message.type === "command_cancel",
        ),
      ).toHaveLength(2);
      sub.emit("publication", {
        data: {
          type: "command_cancel_result",
          commandId: FIXED_UUID,
          canceled: true,
        },
      });

      await expect(secondAttempt).resolves.toBe(true);
      await expect(promise).resolves.toMatchObject({ exitCode: 130 });
    });

    it("publishes command_cancel when aborted while command publish is in flight", async () => {
      const sandbox = createSandbox();
      const abortController = new AbortController();

      const { promise } = startCommand(sandbox, "sleep 999", {
        timeoutMs: 5000,
        signal: abortController.signal,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      let resolveCommandPublish!: () => void;
      sub.publish = jest.fn((msg: { type: string }) => {
        if (msg.type === "command") {
          return new Promise<void>((resolve) => {
            resolveCommandPublish = resolve;
          });
        }
        return Promise.resolve();
      });

      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "command",
          commandId: FIXED_UUID,
        }),
      );

      abortController.abort();
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "command_cancel" }),
      );

      resolveCommandPublish();
      await jest.advanceTimersByTimeAsync(0);

      sub.emit("publication", {
        data: {
          type: "command_cancel_result",
          commandId: FIXED_UUID,
          canceled: true,
        },
      });

      await expect(promise).resolves.toMatchObject({
        exitCode: 130,
      });
      expect(sub.publish).toHaveBeenCalledWith({
        type: "command_cancel",
        commandId: FIXED_UUID,
        targetConnectionId: "conn-1",
      });
    });
  });

  describe("commands.run error message", () => {
    it("resolves with exitCode -1 when type is error", async () => {
      const sandbox = createSandbox();

      const { promise } = startCommand(sandbox, "bad-cmd", {
        timeoutMs: 5000,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      sub.emit("publication", {
        data: {
          type: "error",
          commandId: FIXED_UUID,
          message: "command not found",
        },
      });

      const result = await promise;

      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain("command not found");
    });
  });

  describe("commands.run command filtering", () => {
    it("ignores messages for other commandIds", async () => {
      const sandbox = createSandbox();

      const { promise } = startCommand(sandbox, "echo mine", {
        timeoutMs: 5000,
      });

      await jest.advanceTimersByTimeAsync(0);

      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      // Message for a different commandId
      sub.emit("publication", {
        data: { type: "stdout", commandId: "other-cmd-id", data: "not mine\n" },
      });

      // Message for our commandId
      sub.emit("publication", {
        data: { type: "stdout", commandId: FIXED_UUID, data: "mine\n" },
      });

      sub.emit("publication", {
        data: { type: "exit", commandId: FIXED_UUID, exitCode: 0 },
      });

      const result = await promise;

      expect(result.stdout).toBe("mine\n");
      expect(result.stdout).not.toContain("not mine");
    });
  });

  describe("native desktop file relay", () => {
    it("resolves relative file paths from the project folder", async () => {
      const sandbox = createDesktopSandbox("C:\\work\\hackerai");
      const promise = sandbox.files.read("src\\app.ts");

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_read",
          path: "C:\\work\\hackerai\\src\\app.ts",
        }),
      );

      const request = (sub.publish as jest.Mock).mock.calls[0][0] as {
        requestId: string;
      };
      sub.emit("publication", {
        data: {
          type: "file_read_result",
          requestId: request.requestId,
          path: "C:\\work\\hackerai\\src\\app.ts",
          sizeBytes: 2,
          totalLines: 1,
          content: "ok",
          startLine: 1,
        },
      });

      await expect(promise).resolves.toBe("ok");
    });

    it("requires the desktop files capability before enabling the native relay", () => {
      const sandbox = createSandbox({
        isDesktop: true,
        capabilities: { commands: true, pty: true },
        osInfo: {
          platform: "win32",
          arch: "x64",
          release: "10.0.22631",
          hostname: "WIN-OLD",
        },
      });

      expect(sandbox.supportsNativeFileRelay()).toBe(false);
    });

    it("files.read publishes a targeted file_read request for desktop connections", async () => {
      const sandbox = createDesktopSandbox();
      const promise = sandbox.files.read("C:\\repo\\app.ts");

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_read",
          path: "C:\\repo\\app.ts",
          targetConnectionId: "conn-1",
          requestId: expect.any(String),
        }),
      );

      const request = (sub.publish as jest.Mock).mock.calls[0][0] as {
        requestId: string;
      };
      sub.emit("publication", {
        data: {
          type: "file_read_result",
          requestId: request.requestId,
          path: "C:\\repo\\app.ts",
          sizeBytes: 12,
          totalLines: 1,
          content: "hello world\n",
          startLine: 1,
        },
      });

      await expect(promise).resolves.toBe("hello world\n");
    });

    it("files.write publishes file_write instead of shell heredoc for desktop connections", async () => {
      const sandbox = createDesktopSandbox();
      const promise = sandbox.files.write("C:\\repo\\app.ts", "updated");

      await jest.advanceTimersByTimeAsync(0);
      const sub = mockSubscriptions[0];
      sub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      expect(sub.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_write",
          path: "C:\\repo\\app.ts",
          content: "updated",
          targetConnectionId: "conn-1",
          requestId: expect.any(String),
        }),
      );

      const request = (sub.publish as jest.Mock).mock.calls[0][0] as {
        requestId: string;
      };
      sub.emit("publication", {
        data: { type: "file_ok", requestId: request.requestId },
      });

      await expect(promise).resolves.toBeUndefined();
    });

    it("chunks large native writes into file_write then file_append requests", async () => {
      const sandbox = createDesktopSandbox();
      const content = "x".repeat(70 * 1024);
      const promise = sandbox.files.write("C:\\repo\\large.txt", content);

      await jest.advanceTimersByTimeAsync(0);
      const firstSub = mockSubscriptions[0];
      firstSub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      const firstRequest = (firstSub.publish as jest.Mock).mock.calls[0][0] as {
        type: string;
        requestId: string;
        content: string;
        isBase64?: boolean;
      };
      expect(firstRequest).toEqual(
        expect.objectContaining({
          type: "file_write",
          path: "C:\\repo\\large.txt",
          isBase64: true,
          targetConnectionId: "conn-1",
        }),
      );
      firstSub.emit("publication", {
        data: { type: "file_ok", requestId: firstRequest.requestId },
      });

      await jest.advanceTimersByTimeAsync(0);
      const secondSub = mockSubscriptions[1];
      secondSub.emit("subscribed");
      await jest.advanceTimersByTimeAsync(0);

      const secondRequest = (secondSub.publish as jest.Mock).mock
        .calls[0][0] as {
        type: string;
        requestId: string;
        content: string;
        isBase64?: boolean;
      };
      expect(secondRequest).toEqual(
        expect.objectContaining({
          type: "file_append",
          path: "C:\\repo\\large.txt",
          isBase64: true,
          targetConnectionId: "conn-1",
        }),
      );
      secondSub.emit("publication", {
        data: { type: "file_ok", requestId: secondRequest.requestId },
      });

      await expect(promise).resolves.toBeUndefined();
      expect(
        Buffer.from(
          firstRequest.content + secondRequest.content,
          "base64",
        ).toString("utf8"),
      ).toBe(content);
    });
  });

  describe("close()", () => {
    it("disconnects all active clients", async () => {
      const sandbox = createSandbox();

      // Start two commands without resolving them
      const { promise: p1 } = startCommand(sandbox, "cmd1", {
        timeoutMs: 30000,
      });
      await jest.advanceTimersByTimeAsync(0);

      const { promise: p2 } = startCommand(sandbox, "cmd2", {
        timeoutMs: 30000,
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(mockClients).toHaveLength(2);
      expect((sandbox as any).activeClients).toHaveLength(2);

      await sandbox.close();

      expect(mockClients[0].disconnect).toHaveBeenCalled();
      expect(mockClients[1].disconnect).toHaveBeenCalled();
      expect((sandbox as any).activeClients).toHaveLength(0);

      // Clean up pending promises
      jest.advanceTimersByTime(60000);
      await Promise.allSettled([p1, p2]);
    });
  });

  describe("files.write", () => {
    it("uses heredoc approach for text content", async () => {
      jest.useRealTimers();

      let callCount = 0;
      crypto.randomUUID = jest.fn(() => `cmd-uuid-${++callCount}`) as any;

      // Patch each new MockCentrifugeClient's newSubscription to create
      // subscriptions that auto-emit "subscribed" when subscribe() is called,
      // and auto-resolve commands when publish() is called.
      const origFactory = (require("centrifuge") as { Centrifuge: jest.Mock })
        .Centrifuge;
      origFactory.mockImplementation(() => {
        const client = new MockCentrifugeClient();
        const origNewSub = client.newSubscription.bind(client);
        client.newSubscription = jest.fn((...args: unknown[]) => {
          const sub = origNewSub(...args) as MockSubscription;
          sub.subscribe = jest.fn(() => {
            setTimeout(() => sub.emit("subscribed"));
          });
          // Auto-resolve: when publish is called, emit exit on the subscription.
          sub.publish = jest.fn(async (msg: { commandId: string }) => {
            setTimeout(() => {
              sub.emit("publication", {
                data: {
                  type: "exit",
                  commandId: msg.commandId,
                  exitCode: 0,
                },
              });
            });
          });
          return sub;
        });
        mockClients.push(client);
        return client;
      });

      try {
        const sandbox = createSandbox();
        await sandbox.files.write("/tmp/hackerai/test.txt", "hello world");

        // files.write runs mkdir -p then cat > ... heredoc.
        // Find the subscription whose publish was called with a cat > command
        const allPublishCalls = mockSubscriptions.flatMap((sub) =>
          (sub.publish as jest.Mock).mock.calls.map(
            (call: unknown[]) => call[0],
          ),
        );
        const writeCmd = allPublishCalls.find((msg: { command?: string }) =>
          msg?.command?.includes("cat >"),
        );
        expect(writeCmd).toBeDefined();

        expect(writeCmd.command).toContain("cat >");
        expect(writeCmd.command).toContain("<<'HACKERAI_EOF_");
        expect(writeCmd.command).toContain("hello world");
      } finally {
        jest.useFakeTimers();
      }
    }, 15000);
  });

  describe("git-bash on Windows", () => {
    // When the Windows remote runs git-bash (default since PR #346),
    // every file op must emit POSIX syntax with MSYS-form paths
    // (`/c/temp/...`), not cmd.exe syntax with backslash paths.
    // Regression test for the S3 download → "Die Syntax ... ist falsch" error.

    function createWindowsBashSandbox() {
      const sandbox = createSandbox({
        osInfo: {
          platform: "win32",
          arch: "x86_64",
          release: "10.0.19045",
          hostname: "WIN-DEV",
        },
      });
      // Short-circuit caches so commands.run isn't invoked for detection.
      (sandbox as any).shellKind = "bash";
      (sandbox as any).httpClient = "curl";
      (sandbox as any).curlCaps = {
        retryAllErrors: true,
        retryConnrefused: true,
        sslNoRevoke: true,
      };
      const runs: string[] = [];
      const runOptions: unknown[] = [];
      (sandbox as any).commands.run = jest.fn(
        async (cmd: string, opts?: unknown) => {
          runOptions.push(opts);
          runs.push(cmd);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      );
      return { sandbox, runs, runOptions };
    }

    function createWindowsCmdSandbox() {
      const sandbox = createSandbox({
        osInfo: {
          platform: "win32",
          arch: "x86_64",
          release: "10.0.19045",
          hostname: "WIN-DEV",
        },
      });
      (sandbox as any).shellKind = "cmd";
      (sandbox as any).httpClient = "curl";
      (sandbox as any).curlCaps = {
        retryAllErrors: true,
        retryConnrefused: true,
        sslNoRevoke: true,
      };
      const runs: string[] = [];
      (sandbox as any).commands.run = jest.fn(async (cmd: string) => {
        runs.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      return { sandbox, runs };
    }

    it("downloadFromUrl emits POSIX mkdir + curl with MSYS paths", async () => {
      const { sandbox, runs, runOptions } = createWindowsBashSandbox();
      // Mock validateDownloadUrl is real; use an https URL it accepts.
      await sandbox.files.downloadFromUrl(
        "https://example.com/image.png",
        "/tmp/hackerai-upload/image.png",
      );
      const cmd = runs[0];
      expect(cmd).toContain("mkdir -p '/c/temp/hackerai-upload'");
      expect(cmd).toContain("curl -fsSL");
      expect(cmd).toContain("--ssl-no-revoke");
      expect(cmd).toContain("--retry 3");
      expect(cmd).toContain("--retry-delay 1");
      expect(cmd).toContain("--retry-all-errors");
      expect(cmd).toContain("--retry-connrefused");
      expect(cmd).toContain("-o '/c/temp/hackerai-upload/image.png'");
      expect(cmd).not.toContain("if not exist");
      expect(cmd).not.toContain("\\");
      expect(runOptions[0]).toMatchObject({
        displayName: "Downloading: image.png",
        timeoutMs: 120000,
      });
    });

    it("downloadFromUrl omits --ssl-no-revoke when Windows curl lacks support", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      (sandbox as any).curlCaps = {
        retryAllErrors: true,
        retryConnrefused: true,
        sslNoRevoke: false,
      };

      await sandbox.files.downloadFromUrl(
        "https://example.com/image.png",
        "/tmp/hackerai-upload/image.png",
      );

      expect(runs[0]).toContain("curl -fsSL");
      expect(runs[0]).not.toContain("--ssl-no-revoke");
    });

    it("uploadToUrl emits Windows curl with --ssl-no-revoke when supported", async () => {
      const { sandbox, runs, runOptions } = createWindowsBashSandbox();

      await sandbox.files.uploadToUrl(
        "/tmp/hackerai-upload/report.txt",
        "https://example.com/upload",
        "text/plain",
      );

      expect(runs[0]).toContain("curl -fsSL --ssl-no-revoke -X PUT");
      expect(runs[0]).toContain("-H 'Content-Type: text/plain'");
      expect(runs[0]).toContain(
        "--data-binary @'/c/temp/hackerai-upload/report.txt'",
      );
      expect(runOptions[0]).toMatchObject({
        displayName: "Uploading: report.txt",
        timeoutMs: 120000,
      });
    });

    it("uploadToUrl retries transient command relay timeouts during wget setup probes", async () => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const sandbox = createSandbox({
        osInfo: {
          platform: "linux",
          arch: "x64",
          release: "6.1",
          hostname: "devbox",
        },
      });
      (sandbox as any).httpClient = "wget";
      const run = jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "Command timeout after 35000ms [connected: 75ms, subscribed: 75ms, published: 104ms, firstMsg: no] connectionId=conn-1",
          ),
        )
        .mockResolvedValueOnce({
          stdout: "GNU Wget 1.21.4\n",
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
      (sandbox as any).commands.run = run;

      try {
        const promise = sandbox.files.uploadToUrl(
          "/tmp/hackerai-upload/report.txt",
          "https://example.com/upload",
          "text/plain",
        );

        await jest.advanceTimersByTimeAsync(500);
        await promise;

        expect(run).toHaveBeenCalledTimes(3);
        expect(run).toHaveBeenNthCalledWith(1, "wget 2>&1 | head -1", {
          displayName: "",
          timeoutMs: 30000,
        });
        expect(run).toHaveBeenNthCalledWith(2, "wget 2>&1 | head -1", {
          displayName: "",
          timeoutMs: 30000,
        });
        expect(run).toHaveBeenNthCalledWith(
          3,
          expect.stringContaining("wget -q --method=PUT"),
          {
            displayName: "Uploading: report.txt",
            timeoutMs: 120000,
          },
        );
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("downloadFromUrl failure diagnostics do not list local directory contents", async () => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const { sandbox, runs } = createWindowsBashSandbox();
      (sandbox as any).commands.run = jest.fn(async (cmd: string) => {
        runs.push(cmd);
        if (cmd.includes("target_dir_exists")) {
          return {
            stdout:
              "target_dir_exists=true\ntarget_dir_writable=true\nFilesystem Size Used Avail Use% Mounted on\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "curl: (35) schannel: CRYPT_E_NO_REVOCATION_CHECK",
          exitCode: 35,
        };
      });

      try {
        const assertion = expect(
          sandbox.files.downloadFromUrl(
            "https://example.com/image.png",
            "/tmp/hackerai-upload/image.png",
          ),
        ).rejects.toThrow("Failed to download file");
        await jest.advanceTimersByTimeAsync(5_000);
        await assertion;

        const diagCmd = runs[runs.length - 1];
        expect(diagCmd).toContain("target_dir_exists");
        expect(diagCmd).toContain("target_dir_writable");
        expect(diagCmd).not.toContain("ls -la");
        expect(diagCmd).not.toContain("dir ");
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("downloadFromUrl cmd diagnostics include writability without listing contents", async () => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const { sandbox, runs } = createWindowsCmdSandbox();
      (sandbox as any).commands.run = jest.fn(async (cmd: string) => {
        runs.push(cmd);
        if (cmd.includes("target_dir_exists")) {
          return {
            stdout: "target_dir_exists=true\ntarget_dir_writable=true\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "curl: (35) schannel: CRYPT_E_NO_REVOCATION_CHECK",
          exitCode: 35,
        };
      });

      try {
        const assertion = expect(
          sandbox.files.downloadFromUrl(
            "https://example.com/image.png",
            "/tmp/hackerai-upload/image.png",
          ),
        ).rejects.toThrow("Failed to download file");
        await jest.advanceTimersByTimeAsync(5_000);
        await assertion;

        const diagCmd = runs[runs.length - 1];
        expect(diagCmd).toContain("target_dir_exists");
        expect(diagCmd).toContain("target_dir_writable");
        expect(diagCmd).toContain("pushd");
        expect(diagCmd).not.toContain("dir ");
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("downloadFromUrl retries local command wrapper timeouts", async () => {
      const { sandbox } = createWindowsBashSandbox();
      (sandbox as any).commands.run = jest
        .fn()
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "\n[Command timed out and was terminated]",
          exitCode: 124,
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

      const promise = sandbox.files.downloadFromUrl(
        "https://example.com/large.har",
        "/tmp/hackerai-upload/large.har",
      );

      await jest.advanceTimersByTimeAsync(500);
      await promise;

      expect((sandbox as any).commands.run).toHaveBeenCalledTimes(2);
      expect((sandbox as any).commands.run).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("curl -fsSL"),
        expect.objectContaining({
          displayName: "Downloading: large.har",
          timeoutMs: 120000,
        }),
      );
      expect((sandbox as any).commands.run).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("curl -fsSL"),
        expect.objectContaining({
          displayName: "Downloading: large.har (retry 1)",
          timeoutMs: 120000,
        }),
      );
    });

    it("downloadFromUrl retries thrown command deadline timeouts", async () => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const { sandbox } = createWindowsBashSandbox();
      (sandbox as any).commands.run = jest
        .fn()
        .mockRejectedValueOnce(new Error(PRODUCTION_COMMAND_TIMEOUT_MESSAGE))
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

      try {
        const promise = sandbox.files.downloadFromUrl(
          "https://example.com/large.har",
          "/tmp/hackerai-upload/large.har",
        );

        await jest.advanceTimersByTimeAsync(500);
        await promise;

        expect((sandbox as any).commands.run).toHaveBeenCalledTimes(2);
        expect((sandbox as any).commands.run).toHaveBeenNthCalledWith(
          2,
          expect.stringContaining("curl -fsSL"),
          expect.objectContaining({
            displayName: "Downloading: large.har (retry 1)",
            timeoutMs: 120000,
          }),
        );
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("downloadFromUrl retries transient command relay timeouts during setup probes", async () => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const sandbox = createSandbox({
        osInfo: {
          platform: "linux",
          arch: "x64",
          release: "6.1",
          hostname: "devbox",
        },
      });
      const run = jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "Command timeout after 35000ms [connected: 75ms, subscribed: 75ms, published: 104ms, firstMsg: no] connectionId=conn-1",
          ),
        )
        .mockResolvedValueOnce({
          stdout: "/usr/bin/curl\n",
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({
          stdout: "--retry-all-errors --retry-connrefused\n",
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
      (sandbox as any).commands.run = run;

      try {
        const promise = sandbox.files.downloadFromUrl(
          "https://example.com/image.png",
          "/tmp/hackerai-upload/image.png",
        );

        await jest.advanceTimersByTimeAsync(500);
        await promise;

        expect(run).toHaveBeenCalledTimes(4);
        expect(run).toHaveBeenNthCalledWith(1, "command -v curl || true", {
          displayName: "",
          timeoutMs: 30000,
        });
        expect(run).toHaveBeenNthCalledWith(2, "command -v curl || true", {
          displayName: "",
          timeoutMs: 30000,
        });
        expect(run).toHaveBeenNthCalledWith(
          4,
          expect.stringContaining("curl -fsSL"),
          {
            displayName: "Downloading: image.png",
            timeoutMs: 120000,
          },
        );
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it("ensureDirectory emits mkdir -p with MSYS path", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      await (sandbox as any).ensureDirectory("C:\\temp\\hackerai-upload");
      expect(runs[0]).toBe("mkdir -p '/c/temp/hackerai-upload'");
    });

    it("files.read uses cat with MSYS path", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      await sandbox.files.read("/tmp/foo/bar.txt");
      expect(runs[0]).toBe("cat '/c/temp/foo/bar.txt'");
    });

    it("files.remove uses rm -rf with MSYS path", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      await sandbox.files.remove("/tmp/foo/bar.txt");
      expect(runs[0]).toBe("rm -rf '/c/temp/foo/bar.txt'");
    });

    it("files.list uses find with MSYS path", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      await sandbox.files.list("/tmp/foo");
      expect(runs[0]).toContain("find '/c/temp/foo'");
      expect(runs[0]).toContain("-maxdepth 1 -type f");
    });

    it("files.write for text content uses heredoc with MSYS path", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      await sandbox.files.write("/tmp/foo/bar.txt", "hello");
      // First call is the ensureDirectory mkdir -p, second is the write itself.
      expect(runs[0]).toBe("mkdir -p '/c/temp/foo'");
      expect(runs[1]).toContain("cat > '/c/temp/foo/bar.txt'");
      expect(runs[1]).toContain("<<'HACKERAI_EOF_");
      expect(runs[1]).toContain("hello");
      // No certutil / cmd.exe artifacts.
      expect(runs[1]).not.toContain("certutil");
    });
  });

  describe("getSandboxContext", () => {
    it("returns context with OS info", () => {
      const sandbox = createSandbox({
        osInfo: {
          platform: "linux",
          arch: "x86_64",
          release: "6.1.0",
          hostname: "pentest-box",
        },
      });

      const context = sandbox.getSandboxContext();

      expect(context).toContain("DANGEROUS MODE");
      expect(context).toContain("Linux");
      expect(context).toContain("pentest-box");
      expect(context).toContain("Browser automation is host-dependent");
      expect(context).toContain(
        "command -v agent-browser && agent-browser --version",
      );
      expect(context).toContain(
        "do not install browser automation packages on the host unless the user explicitly asks",
      );
    });

    it("uses a cmd-compatible browser probe on Windows", () => {
      const sandbox = createSandbox({
        osInfo: {
          platform: "win32",
          arch: "x86_64",
          release: "11",
          hostname: "windows-box",
        },
      });

      const context = sandbox.getSandboxContext();

      expect(context).toContain(
        "where agent-browser && agent-browser --version",
      );
      expect(context).not.toContain("command -v agent-browser");
    });

    it("returns null without osInfo", () => {
      const sandbox = createSandbox();
      const context = sandbox.getSandboxContext();

      expect(context).toBeNull();
    });

    it.each([
      ["darwin", "macOS"],
      ["win32", "Windows"],
      ["linux", "Linux"],
    ])("maps platform %s to %s in context", (platform, displayName) => {
      const sandbox = createSandbox({
        osInfo: {
          platform,
          arch: "x86_64",
          release: "1.0",
          hostname: "host",
        },
      });

      const context = sandbox.getSandboxContext();
      expect(context).toContain(displayName);
    });
  });
});
