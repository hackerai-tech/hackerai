import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { CrossTabMutex } from "../cross-tab-mutex";

describe("CrossTabMutex", () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    jest.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
      return mockStorage[key] ?? null;
    });
    jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key, value) => {
        mockStorage[key] = value;
      });
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
      delete mockStorage[key];
    });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("constructor", () => {
    it("should generate a unique tabId", () => {
      const mutex1 = new CrossTabMutex();
      const mutex2 = new CrossTabMutex();
      expect(mutex1.tabId).not.toBe(mutex2.tabId);
    });

    it("should use custom lockKey when provided", () => {
      const mutex = new CrossTabMutex({ lockKey: "custom-lock" });
      mutex.tryAcquire();
      expect(mockStorage["custom-lock"]).toBeDefined();
    });

    it("should use default lockKey when not provided", () => {
      const mutex = new CrossTabMutex();
      mutex.tryAcquire();
      expect(mockStorage["cross-tab-mutex"]).toBeDefined();
    });
  });

  describe("tryAcquire", () => {
    it("should acquire lock when no lock exists", () => {
      const mutex = new CrossTabMutex();
      const result = mutex.tryAcquire();
      expect(result).toBe(true);
      expect(mockStorage["cross-tab-mutex"]).toBeDefined();
    });

    it("should return true when we already hold the lock", () => {
      const mutex = new CrossTabMutex();
      mutex.tryAcquire();
      const result = mutex.tryAcquire();
      expect(result).toBe(true);
    });

    it("should return false when another tab holds a fresh lock", () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      mutex1.tryAcquire();
      const result = mutex2.tryAcquire();

      expect(result).toBe(false);
    });

    it("should acquire lock when existing lock is stale (expired)", () => {
      const mutex1 = new CrossTabMutex({
        lockKey: "test-lock",
        lockTimeoutMs: 1000,
      });
      const mutex2 = new CrossTabMutex({
        lockKey: "test-lock",
        lockTimeoutMs: 1000,
      });

      mutex1.tryAcquire();

      // Advance time past lock timeout
      jest.advanceTimersByTime(1500);

      const result = mutex2.tryAcquire();
      expect(result).toBe(true);
    });

    it("should call onLog callback when provided", () => {
      const logs: string[] = [];
      const mutex = new CrossTabMutex({
        onLog: (msg) => logs.push(msg),
      });

      mutex.tryAcquire();

      expect(logs).toContain("Lock acquired");
    });

    it("should handle localStorage errors gracefully and return true", () => {
      jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Storage error");
      });

      const mutex = new CrossTabMutex();
      const result = mutex.tryAcquire();

      expect(result).toBe(true);
    });

    it("should handle corrupted JSON in localStorage", () => {
      mockStorage["cross-tab-mutex"] = "not valid json";

      const mutex = new CrossTabMutex();
      const result = mutex.tryAcquire();

      // Should fail gracefully and return true (localStorage error path)
      expect(result).toBe(true);
    });
  });

  describe("release", () => {
    it("should remove lock when we hold it", () => {
      const mutex = new CrossTabMutex();
      mutex.tryAcquire();
      expect(mockStorage["cross-tab-mutex"]).toBeDefined();

      mutex.release();
      expect(mockStorage["cross-tab-mutex"]).toBeUndefined();
    });

    it("should not remove lock held by another tab", () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      mutex1.tryAcquire();
      mutex2.release(); // mutex2 doesn't hold the lock

      expect(mockStorage["test-lock"]).toBeDefined();
    });

    it("should handle localStorage errors gracefully", () => {
      const mutex = new CrossTabMutex();
      mutex.tryAcquire();

      jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("Storage error");
      });

      expect(() => mutex.release()).not.toThrow();
    });
  });

  describe("acquireWithWait", () => {
    it("should acquire immediately when lock is available", async () => {
      const mutex = new CrossTabMutex();
      const result = await mutex.acquireWithWait(1000);
      expect(result).toBe(true);
    });

    it("should wait and acquire when lock becomes available", async () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      mutex1.tryAcquire();

      // Start waiting in background
      const acquirePromise = mutex2.acquireWithWait(1000, 50);

      // Release lock after 100ms
      jest.advanceTimersByTime(100);
      mutex1.release();

      // Advance to let mutex2 retry
      jest.advanceTimersByTime(100);

      const result = await acquirePromise;
      expect(result).toBe(true);
    });

    it("should timeout when lock is never released", async () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      mutex1.tryAcquire();

      const acquirePromise = mutex2.acquireWithWait(500, 50);

      // Advance past timeout
      jest.advanceTimersByTime(600);

      const result = await acquirePromise;
      expect(result).toBe(false);
    });

    it("should add jitter to retry interval", async () => {
      const mutex = new CrossTabMutex({ lockKey: "test-lock" });
      const anotherMutex = new CrossTabMutex({ lockKey: "test-lock" });

      anotherMutex.tryAcquire();

      // Mock Math.random to return predictable values
      const randomSpy = jest.spyOn(Math, "random");
      randomSpy.mockReturnValue(0.5);

      const promise = mutex.acquireWithWait(100, 50);
      jest.advanceTimersByTime(200);

      await promise;
      randomSpy.mockRestore();
    });
  });

  describe("withLock", () => {
    it("should execute function while holding lock", async () => {
      const mutex = new CrossTabMutex();
      let executed = false;

      const result = await mutex.withLock(async () => {
        executed = true;
        return "success";
      });

      expect(executed).toBe(true);
      expect(result).toBe("success");
    });

    it("should release lock after function completes", async () => {
      const mutex = new CrossTabMutex();

      await mutex.withLock(async () => "done");

      expect(mockStorage["cross-tab-mutex"]).toBeUndefined();
    });

    it("should release lock even if function throws", async () => {
      const mutex = new CrossTabMutex();

      await expect(
        mutex.withLock(async () => {
          throw new Error("Function error");
        }),
      ).rejects.toThrow("Function error");

      expect(mockStorage["cross-tab-mutex"]).toBeUndefined();
    });

    it("should return null when lock acquisition times out", async () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      mutex1.tryAcquire();

      const resultPromise = mutex2.withLock(async () => "success", 100);

      jest.advanceTimersByTime(200);

      const result = await resultPromise;
      expect(result).toBeNull();
    });

    it("should allow another tab to acquire after release", async () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      await mutex1.withLock(async () => "first");

      // Now mutex2 should be able to acquire
      const result = await mutex2.withLock(async () => "second");
      expect(result).toBe("second");
    });
  });

  describe("forceClear", () => {
    it("should remove lock regardless of owner", () => {
      const mutex1 = new CrossTabMutex({ lockKey: "test-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "test-lock" });

      mutex1.tryAcquire();
      expect(mockStorage["test-lock"]).toBeDefined();

      mutex2.forceClear();
      expect(mockStorage["test-lock"]).toBeUndefined();
    });
  });

  describe("cross-tab coordination scenarios", () => {
    it("should serialize access across multiple mutex instances", async () => {
      // Use real timers for this async test
      jest.useRealTimers();

      const executionOrder: string[] = [];
      const mutex1 = new CrossTabMutex({ lockKey: "shared-lock" });
      const mutex2 = new CrossTabMutex({ lockKey: "shared-lock" });
      const mutex3 = new CrossTabMutex({ lockKey: "shared-lock" });

      // mutex1 acquires lock first
      const result1 = await mutex1.withLock(async () => {
        executionOrder.push("mutex1-start");
        executionOrder.push("mutex1-end");
        return "m1";
      });

      // Now mutex2 should be able to acquire
      const result2 = await mutex2.withLock(async () => {
        executionOrder.push("mutex2");
        return "m2";
      });

      // And mutex3
      const result3 = await mutex3.withLock(async () => {
        executionOrder.push("mutex3");
        return "m3";
      });

      expect(result1).toBe("m1");
      expect(result2).toBe("m2");
      expect(result3).toBe("m3");
      expect(executionOrder).toEqual([
        "mutex1-start",
        "mutex1-end",
        "mutex2",
        "mutex3",
      ]);

      // Restore fake timers for other tests
      jest.useFakeTimers();
    });

    it("should handle stale lock from crashed tab", async () => {
      // Simulate a crashed tab that left a stale lock
      mockStorage["test-lock"] = JSON.stringify({
        tabId: "crashed-tab-id",
        timestamp: Date.now() - 20000, // 20 seconds ago
      });

      const mutex = new CrossTabMutex({
        lockKey: "test-lock",
        lockTimeoutMs: 10000, // 10 second timeout
      });

      const result = mutex.tryAcquire();
      expect(result).toBe(true);
    });
  });
});
