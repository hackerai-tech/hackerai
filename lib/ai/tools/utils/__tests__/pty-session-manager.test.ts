/**
 * Tests for PtySessionManager — the per-chat PTY session store for interactive
 * shells. See /Users/fkesheh/.claude/plans/fluffy-splashing-hoare.md "Session
 * store" and "Limits" sections.
 */

import {
  MAX_BUFFER_BYTES,
  MAX_CONCURRENT_PTYS_PER_CHAT,
  PtyHandle,
  PtySession,
  PtySessionManager,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_LIFETIME_MS,
} from "../pty-session-manager";

interface FakeHandle extends PtyHandle {
  /** Test helper to drive onData callbacks. */
  __emit: (bytes: Uint8Array) => void;
  /** Test helper to resolve the exited promise. */
  __exit: (exitCode: number | null) => void;
  kill: jest.Mock<Promise<void>, []>;
  sendInput: jest.Mock<Promise<void>, [Uint8Array]>;
  resize: jest.Mock<Promise<void>, [number, number]>;
}

let nextPid = 1000;

function makeFakeHandle(overrides?: { pid?: number }): FakeHandle {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  let resolveExited!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((r) => {
    resolveExited = r;
  });
  const handle: FakeHandle = {
    pid: overrides?.pid ?? nextPid++,
    sendInput: jest
      .fn<Promise<void>, [Uint8Array]>()
      .mockResolvedValue(undefined),
    resize: jest
      .fn<Promise<void>, [number, number]>()
      .mockResolvedValue(undefined),
    kill: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    onData: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    exited,
    __emit: (bytes) => listeners.forEach((l) => l(bytes)),
    __exit: (code) => resolveExited({ exitCode: code }),
  };
  return handle;
}

function makeCreateHandleFactory(handle: PtyHandle) {
  return jest.fn().mockResolvedValue(handle);
}

describe("PtySessionManager", () => {
  let manager: PtySessionManager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new PtySessionManager();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("create", () => {
    it("returns a session with sessionId, pid, cols, rows and handle", async () => {
      const handle = makeFakeHandle({ pid: 4242 });
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 120,
        rows: 30,
      });

      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.chatId).toBe("chat-1");
      expect(session.pid).toBe(4242);
      expect(session.cols).toBe(120);
      expect(session.rows).toBe(30);
      expect(session.handle).toBe(handle);
      expect(session.readCursor).toBe(0);
      expect(session.bufferTruncated).toBe(false);
      expect(Array.isArray(session.buffer)).toBe(true);
      expect(typeof session.createdAt).toBe("number");
      expect(typeof session.lastActivityAt).toBe("number");
    });

    it("invokes the provided createHandle factory exactly once", async () => {
      const handle = makeFakeHandle();
      const factory = makeCreateHandleFactory(handle);
      await manager.create("chat-1", {
        createHandle: factory,
        cols: 80,
        rows: 24,
      });
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("rejects the 3rd concurrent session in the same chat", async () => {
      const h1 = makeFakeHandle();
      const h2 = makeFakeHandle();
      const h3 = makeFakeHandle();

      await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(h1),
        cols: 80,
        rows: 24,
      });
      await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(h2),
        cols: 80,
        rows: 24,
      });

      await expect(
        manager.create("chat-1", {
          createHandle: makeCreateHandleFactory(h3),
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow(/MAX_CONCURRENT_PTYS_PER_CHAT|concurrent|limit/i);

      // third handle must NOT have been created
      expect(h3.kill).not.toHaveBeenCalled();
    });

    it("allows two sessions in different chatIds", async () => {
      const h1 = makeFakeHandle();
      const h2 = makeFakeHandle();

      const s1 = await manager.create("chat-a", {
        createHandle: makeCreateHandleFactory(h1),
        cols: 80,
        rows: 24,
      });
      const s2 = await manager.create("chat-b", {
        createHandle: makeCreateHandleFactory(h2),
        cols: 80,
        rows: 24,
      });

      expect(manager.list("chat-a")).toEqual([s1]);
      expect(manager.list("chat-b")).toEqual([s2]);
    });
  });

  describe("data ingestion", () => {
    it("appends onData chunks to buffer and updates lastActivityAt", async () => {
      const baseNow = 1_700_000_000_000;
      jest.setSystemTime(baseNow);
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });
      const createdAt = session.lastActivityAt;

      jest.setSystemTime(baseNow + 50);
      handle.__emit(new Uint8Array([1, 2, 3]));
      jest.setSystemTime(baseNow + 100);
      handle.__emit(new Uint8Array([4, 5]));

      expect(session.buffer.length).toBe(2);
      expect(Array.from(session.buffer[0])).toEqual([1, 2, 3]);
      expect(Array.from(session.buffer[1])).toEqual([4, 5]);
      expect(session.lastActivityAt).toBeGreaterThan(createdAt);
    });

    it("resets the idle timer on each onData chunk", async () => {
      const handle = makeFakeHandle();
      await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });

      // Advance almost to idle timeout
      jest.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
      expect(handle.kill).not.toHaveBeenCalled();

      // Data arrives — resets idle timer
      handle.__emit(new Uint8Array([1]));

      // Advance again almost to idle timeout — still alive
      jest.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
      expect(handle.kill).not.toHaveBeenCalled();

      // Push it over
      jest.advanceTimersByTime(2000);
      // kill is async, but it should have been called (promise pending ok)
      expect(handle.kill).toHaveBeenCalled();
    });
  });

  describe("timers", () => {
    it("fires idle timer after SESSION_IDLE_TIMEOUT_MS and removes the session", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });

      jest.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS + 1);
      // Let microtasks (the async kill/exited chain) resolve
      handle.__exit(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(handle.kill).toHaveBeenCalled();
      expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
    });

    it("fires lifetime timer after SESSION_MAX_LIFETIME_MS and removes the session", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });

      // Keep pushing data so idle never triggers
      const pulse = SESSION_IDLE_TIMEOUT_MS / 2;
      let elapsed = 0;
      while (elapsed < SESSION_MAX_LIFETIME_MS - pulse) {
        jest.advanceTimersByTime(pulse);
        handle.__emit(new Uint8Array([0]));
        elapsed += pulse;
      }
      // Now cross lifetime cap
      jest.advanceTimersByTime(SESSION_MAX_LIFETIME_MS - elapsed + 1);
      handle.__exit(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(handle.kill).toHaveBeenCalled();
      expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
    });
  });

  describe("exited", () => {
    it("removes the session when handle.exited resolves naturally", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });
      expect(manager.get("chat-1", session.sessionId)).toBe(session);

      handle.__exit(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
    });
  });

  describe("consumeDelta / snapshot", () => {
    it("consumeDelta returns bytes since readCursor and advances cursor", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });
      handle.__emit(new Uint8Array([1, 2, 3]));
      handle.__emit(new Uint8Array([4, 5]));

      const delta1 = manager.consumeDelta(session);
      expect(Array.from(delta1)).toEqual([1, 2, 3, 4, 5]);
      expect(session.readCursor).toBe(5);

      // Nothing new — returns empty
      const delta2 = manager.consumeDelta(session);
      expect(delta2.byteLength).toBe(0);

      handle.__emit(new Uint8Array([6, 7]));
      const delta3 = manager.consumeDelta(session);
      expect(Array.from(delta3)).toEqual([6, 7]);
      expect(session.readCursor).toBe(7);
    });

    it("snapshot returns the full buffer and does not advance the cursor", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });
      handle.__emit(new Uint8Array([10, 20]));
      handle.__emit(new Uint8Array([30]));

      const snap = manager.snapshot(session);
      expect(Array.from(snap)).toEqual([10, 20, 30]);
      expect(session.readCursor).toBe(0);

      // snapshot again — same result, still no advance
      const snap2 = manager.snapshot(session);
      expect(Array.from(snap2)).toEqual([10, 20, 30]);
      expect(session.readCursor).toBe(0);
    });

    it("peekBufferSize returns bytes available since readCursor without advancing", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });
      handle.__emit(new Uint8Array([1, 2, 3, 4]));
      expect(manager.peekBufferSize(session)).toBe(4);
      manager.consumeDelta(session);
      expect(manager.peekBufferSize(session)).toBe(0);
      handle.__emit(new Uint8Array([5]));
      expect(manager.peekBufferSize(session)).toBe(1);
    });
  });

  describe("ring buffer", () => {
    it("drops oldest chunks when total size exceeds MAX_BUFFER_BYTES and flips bufferTruncated", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });

      // Emit MAX_BUFFER_BYTES in 3 chunks then one more chunk to force a drop
      const chunkSize = MAX_BUFFER_BYTES / 4;
      const makeChunk = (fill: number) => new Uint8Array(chunkSize).fill(fill);

      handle.__emit(makeChunk(1));
      handle.__emit(makeChunk(2));
      handle.__emit(makeChunk(3));
      handle.__emit(makeChunk(4));

      expect(session.bufferTruncated).toBe(false);

      // This puts us over the limit — oldest chunk must be dropped
      handle.__emit(makeChunk(5));

      const totalBytes = session.buffer.reduce(
        (sum, chunk) => sum + chunk.byteLength,
        0,
      );
      expect(totalBytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
      expect(session.bufferTruncated).toBe(true);
      // First chunk (fill=1) must be gone
      expect(session.buffer[0][0]).not.toBe(1);
    });
  });

  describe("close", () => {
    it("kills the handle, clears timers and removes the session", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });

      const closePromise = manager.close("chat-1", session.sessionId);
      // Simulate handle finishing exit
      handle.__exit(0);
      await closePromise;

      expect(handle.kill).toHaveBeenCalled();
      expect(manager.get("chat-1", session.sessionId)).toBeUndefined();

      // No leaking timers: advancing past both caps should be a no-op
      jest.advanceTimersByTime(SESSION_MAX_LIFETIME_MS + 1);
      // kill was only called once from close
      expect(handle.kill).toHaveBeenCalledTimes(1);
    });

    it("close returns even if exited never resolves within 2s (timeout fallback)", async () => {
      const handle = makeFakeHandle();
      const session = await manager.create("chat-1", {
        createHandle: makeCreateHandleFactory(handle),
        cols: 80,
        rows: 24,
      });

      const closePromise = manager.close("chat-1", session.sessionId);
      // Yield so `kill()` resolves and we actually reach the Promise.race
      // against the 2s fallback timer.
      await Promise.resolve();
      await Promise.resolve();
      // Do not resolve handle.__exit — let the 2s fallback timer fire.
      jest.advanceTimersByTime(2100);
      await closePromise;

      expect(handle.kill).toHaveBeenCalled();
      expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
    });

    it("close on unknown session is a no-op", async () => {
      await expect(manager.close("chat-1", "missing")).resolves.toBeUndefined();
    });
  });

  describe("closeAll", () => {
    it("closes every session for the given chat in parallel and leaves other chats untouched", async () => {
      const h1 = makeFakeHandle();
      const h2 = makeFakeHandle();
      const h3 = makeFakeHandle();

      const s1 = await manager.create("chat-a", {
        createHandle: makeCreateHandleFactory(h1),
        cols: 80,
        rows: 24,
      });
      const s2 = await manager.create("chat-a", {
        createHandle: makeCreateHandleFactory(h2),
        cols: 80,
        rows: 24,
      });
      const s3 = await manager.create("chat-b", {
        createHandle: makeCreateHandleFactory(h3),
        cols: 80,
        rows: 24,
      });

      const closeAllPromise = manager.closeAll("chat-a");
      // Resolve all pending exits
      h1.__exit(0);
      h2.__exit(0);
      await closeAllPromise;

      expect(h1.kill).toHaveBeenCalled();
      expect(h2.kill).toHaveBeenCalled();
      expect(h3.kill).not.toHaveBeenCalled();
      expect(manager.get("chat-a", s1.sessionId)).toBeUndefined();
      expect(manager.get("chat-a", s2.sessionId)).toBeUndefined();
      expect(manager.get("chat-b", s3.sessionId)).toBe(s3);
    });
  });

  describe("constants", () => {
    it("exposes the documented limits", () => {
      expect(MAX_CONCURRENT_PTYS_PER_CHAT).toBe(2);
      expect(SESSION_IDLE_TIMEOUT_MS).toBe(10 * 60_000);
      expect(SESSION_MAX_LIFETIME_MS).toBe(60 * 60_000);
      expect(MAX_BUFFER_BYTES).toBe(256 * 1024);
    });
  });

  describe("list / get", () => {
    it("list returns empty array for unknown chat", () => {
      expect(manager.list("nope")).toEqual([]);
    });

    it("get returns undefined for unknown session", () => {
      expect(manager.get("chat-1", "missing")).toBeUndefined();
    });
  });

  // Reference to satisfy TS import for the PtySession type.
  it("PtySession shape is exported", () => {
    const s = null as unknown as PtySession | null;
    expect(s).toBeNull();
  });
});
