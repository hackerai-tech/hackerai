/**
 * Tests for CentrifugoSandbox real-time command relay.
 *
 * Background:
 * - CentrifugoSandbox uses Centrifuge pub/sub for command streaming
 * - Each command creates a WebSocket subscription and publishes via HTTP
 * - Proper cleanup of clients and subscriptions prevents memory leaks
 */

import { EventEmitter } from "events";
import { CentrifugoSandbox } from "../centrifugo-sandbox";
import type { CentrifugoConfig } from "../centrifugo-sandbox";

// Track all created mock subscriptions and clients for assertions
let mockSubscriptions: MockSubscription[];
let mockClients: MockCentrifugeClient[];

class MockSubscription extends EventEmitter {
  subscribe = jest.fn();
  unsubscribe = jest.fn();
  publish = jest.fn().mockResolvedValue(undefined);
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
  sandboxChannel: jest.fn((userId: string) => `sandbox:user#${userId}`),
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

function createSandbox(
  overrides?: Partial<typeof defaultConnection>,
): CentrifugoSandbox {
  return new CentrifugoSandbox(
    "user-1",
    { ...defaultConnection, ...overrides },
    defaultConfig,
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

  describe("commands.run happy path", () => {
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
      const runs: string[] = [];
      (sandbox as any).commands.run = jest.fn(async (cmd: string) => {
        runs.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      return { sandbox, runs };
    }

    it("downloadFromUrl emits POSIX mkdir + curl with MSYS paths", async () => {
      const { sandbox, runs } = createWindowsBashSandbox();
      // Mock validateDownloadUrl is real; use an https URL it accepts.
      await sandbox.files.downloadFromUrl(
        "https://example.com/image.png",
        "/tmp/hackerai-upload/image.png",
      );
      const cmd = runs[0];
      expect(cmd).toContain("mkdir -p '/c/temp/hackerai-upload'");
      expect(cmd).toContain(
        "curl -fsSL -o '/c/temp/hackerai-upload/image.png'",
      );
      expect(cmd).not.toContain("if not exist");
      expect(cmd).not.toContain("\\");
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
