/**
 * Tests for ConvexSandbox subscription cleanup to prevent memory leaks.
 *
 * Background:
 * - ConvexSandbox creates real-time subscriptions for command results
 * - Without proper cleanup, these subscriptions leak memory during:
 *   - Command timeouts
 *   - Sandbox close during pending commands
 *   - WebSocket reconnections
 *
 * The fix tracks subscriptions in `activeSubscriptions` Set and ensures
 * cleanup via try/finally in waitForResult() and in close().
 */

import { ConvexSandbox } from "../convex-sandbox";

// Mock the Convex clients
jest.mock("convex/browser", () => ({
  ConvexHttpClient: jest.fn().mockImplementation(() => ({
    mutation: jest.fn().mockResolvedValue({ session: { userId: "test" } }),
  })),
  ConvexClient: jest.fn().mockImplementation(() => {
    const subscriptions = new Map<string, () => void>();
    return {
      onUpdate: jest.fn((query, args, callback) => {
        const unsubscribe = jest.fn();
        subscriptions.set(args.commandId, unsubscribe);
        // Store callback for test to trigger
        (unsubscribe as any).callback = callback;
        (unsubscribe as any).commandId = args.commandId;
        return unsubscribe;
      }),
      close: jest.fn().mockResolvedValue(undefined),
      _subscriptions: subscriptions,
    };
  }),
}));

// Mock the Convex API
jest.mock("@/convex/_generated/api", () => ({
  api: {
    localSandbox: {
      enqueueCommand: "enqueueCommand",
      subscribeToResult: "subscribeToResult",
      deleteResult: "deleteResult",
    },
  },
}));

describe("ConvexSandbox Subscription Cleanup", () => {
  let sandbox: ConvexSandbox;
  let mockRealtimeClient: any;
  let mockHttpClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    sandbox = new ConvexSandbox(
      "test-user",
      "https://test.convex.cloud",
      { connectionId: "test-conn", name: "test", mode: "docker" },
      "test-service-key",
    );

    // Access the mocked clients
    mockRealtimeClient = (sandbox as any).realtimeClient;
    mockHttpClient = (sandbox as any).convex;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("activeSubscriptions tracking", () => {
    it("should track subscription when command starts", async () => {
      const commandPromise = sandbox.commands.run("echo test", {
        timeoutMs: 5000,
      });

      // Let the promise start
      await Promise.resolve();

      // Subscription should be tracked
      expect((sandbox as any).activeSubscriptions.size).toBe(1);

      // Trigger success to complete
      const unsubscribe = mockRealtimeClient.onUpdate.mock.results[0].value;
      unsubscribe.callback({ found: true, stdout: "test", exitCode: 0 });

      await commandPromise;

      // Subscription should be cleaned up
      expect((sandbox as any).activeSubscriptions.size).toBe(0);
    });

    it("should cleanup subscription on successful result", async () => {
      const commandPromise = sandbox.commands.run("echo test", {
        timeoutMs: 5000,
      });

      await Promise.resolve();

      const unsubscribe = mockRealtimeClient.onUpdate.mock.results[0].value;

      // Verify unsubscribe not yet called
      expect(unsubscribe).not.toHaveBeenCalled();

      // Trigger success
      unsubscribe.callback({ found: true, stdout: "test", exitCode: 0 });

      const result = await commandPromise;

      expect(result.stdout).toBe("test");
      expect(result.exitCode).toBe(0);
      expect(unsubscribe).toHaveBeenCalled();
      expect((sandbox as any).activeSubscriptions.size).toBe(0);
    });

    it("should cleanup subscription on auth error", async () => {
      const commandPromise = sandbox.commands.run("echo test", {
        timeoutMs: 5000,
      });

      await Promise.resolve();

      const unsubscribe = mockRealtimeClient.onUpdate.mock.results[0].value;

      // Trigger auth error
      unsubscribe.callback({ authError: true });

      await expect(commandPromise).rejects.toThrow(
        "Session expired or invalid",
      );
      expect(unsubscribe).toHaveBeenCalled();
      expect((sandbox as any).activeSubscriptions.size).toBe(0);
    });

    it("should cleanup subscription on timeout", async () => {
      const commandPromise = sandbox.commands.run("sleep 100", {
        timeoutMs: 100,
      });

      await Promise.resolve();

      const unsubscribe = mockRealtimeClient.onUpdate.mock.results[0].value;

      // Advance time past timeout (100ms command + 5000ms buffer)
      jest.advanceTimersByTime(5200);

      await expect(commandPromise).rejects.toThrow("timeout");
      expect(unsubscribe).toHaveBeenCalled();
      expect((sandbox as any).activeSubscriptions.size).toBe(0);
    });

    it("should ignore updates after settlement (prevents double cleanup)", async () => {
      const commandPromise = sandbox.commands.run("echo test", {
        timeoutMs: 5000,
      });

      await Promise.resolve();

      const unsubscribe = mockRealtimeClient.onUpdate.mock.results[0].value;

      // Trigger success first
      unsubscribe.callback({ found: true, stdout: "first", exitCode: 0 });

      // Try to trigger again (should be ignored)
      unsubscribe.callback({ found: true, stdout: "second", exitCode: 0 });

      const result = await commandPromise;

      // Should have first result, not second
      expect(result.stdout).toBe("first");
      // Unsubscribe should only be called once (from cleanup)
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("close() cleanup", () => {
    it("should cleanup all active subscriptions on close", async () => {
      // Start multiple commands
      const promise1 = sandbox.commands.run("cmd1", { timeoutMs: 10000 });
      await Promise.resolve();

      const promise2 = sandbox.commands.run("cmd2", { timeoutMs: 10000 });
      await Promise.resolve();

      // Both subscriptions should be tracked
      expect((sandbox as any).activeSubscriptions.size).toBe(2);

      const unsubscribe1 = mockRealtimeClient.onUpdate.mock.results[0].value;
      const unsubscribe2 = mockRealtimeClient.onUpdate.mock.results[1].value;

      // Close sandbox while commands are pending
      await sandbox.close();

      // Both subscriptions should be cleaned up
      expect(unsubscribe1).toHaveBeenCalled();
      expect(unsubscribe2).toHaveBeenCalled();
      expect((sandbox as any).activeSubscriptions.size).toBe(0);
      expect(mockRealtimeClient.close).toHaveBeenCalled();

      // Cleanup the pending promises
      jest.advanceTimersByTime(20000);
      await Promise.allSettled([promise1, promise2]);
    });

    it("should handle errors during subscription cleanup gracefully", async () => {
      const commandPromise = sandbox.commands.run("echo test", {
        timeoutMs: 10000,
      });

      await Promise.resolve();

      const unsubscribe = mockRealtimeClient.onUpdate.mock.results[0].value;

      // Make unsubscribe throw an error
      unsubscribe.mockImplementation(() => {
        throw new Error("Unsubscribe failed");
      });

      // Should not throw
      await expect(sandbox.close()).resolves.toBeUndefined();
      expect((sandbox as any).activeSubscriptions.size).toBe(0);

      // Cleanup the pending promise
      jest.advanceTimersByTime(20000);
      await Promise.allSettled([commandPromise]);
    });
  });

  describe("memory leak prevention", () => {
    it("should not accumulate subscriptions across multiple commands", async () => {
      // Run multiple commands sequentially
      for (let i = 0; i < 10; i++) {
        const promise = sandbox.commands.run(`cmd${i}`, { timeoutMs: 5000 });

        await Promise.resolve();

        const unsubscribe = mockRealtimeClient.onUpdate.mock.results[i].value;
        unsubscribe.callback({
          found: true,
          stdout: `result${i}`,
          exitCode: 0,
        });

        await promise;
      }

      // No subscriptions should remain
      expect((sandbox as any).activeSubscriptions.size).toBe(0);
    });

    it("should cleanup subscriptions even with rapid sandbox destroy/recreate", async () => {
      // Simulate rapid reconnection scenario
      const sandboxes: ConvexSandbox[] = [];
      const promises: Promise<any>[] = [];

      for (let i = 0; i < 5; i++) {
        const sb = new ConvexSandbox(
          "test-user",
          "https://test.convex.cloud",
          { connectionId: `conn-${i}`, name: "test", mode: "docker" },
          "test-service-key",
        );
        sandboxes.push(sb);

        // Start a command
        const p = sb.commands.run("test", { timeoutMs: 10000 });
        promises.push(p);
        await Promise.resolve();

        // Immediately close (simulating reconnection)
        await sb.close();
      }

      // All sandboxes should have cleaned up
      for (const sb of sandboxes) {
        expect((sb as any).activeSubscriptions.size).toBe(0);
      }

      // Cleanup promises
      jest.advanceTimersByTime(20000);
      await Promise.allSettled(promises);
    });
  });
});
