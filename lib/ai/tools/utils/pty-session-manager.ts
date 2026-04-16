/**
 * Per-chat PTY session store.
 *
 * Lifetime model for M1: sessions live only for the duration of a single
 * assistant streaming response. `chat-handler.onFinish` calls `closeAll(chatId)`
 * to tear everything down. The real source of truth lives inside the E2B
 * sandbox — the Node-side object here is only a per-chat cache with ring
 * buffer, idle/lifetime timers and bookkeeping to compute deltas for
 * `action=wait` / `action=view`.
 */

// `PtyHandle` is canonicalized in `e2b-pty-adapter.ts` and re-exported here
// for existing consumers that import it from the session manager.
import type { PtyHandle } from "./e2b-pty-adapter";
export type { PtyHandle } from "./e2b-pty-adapter";

export const MAX_CONCURRENT_PTYS_PER_CHAT = 2;
export const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
export const SESSION_MAX_LIFETIME_MS = 60 * 60_000;
export const MAX_BUFFER_BYTES = 256 * 1024;

const CLOSE_EXIT_FALLBACK_MS = 2_000;

export interface PtySession {
  readonly sessionId: string;
  readonly chatId: string;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly createdAt: number;
  lastActivityAt: number;
  readonly handle: PtyHandle;
  /**
   * Appended raw bytes. Ring: when total size exceeds `MAX_BUFFER_BYTES`,
   * old chunks are dropped (FIFO).
   */
  buffer: Uint8Array[];
  /**
   * Byte offset of last model-visible read; used by wait/view to compute
   * deltas. Tracked relative to the *current* `buffer` contents — when the
   * ring drops bytes before the cursor, the cursor is clamped to `0` and
   * `bufferTruncated` is set to `true`.
   */
  readCursor: number;
  /** Flipped once when the ring first drops any bytes. Never reset. */
  bufferTruncated: boolean;
}

export interface CreateSessionOpts {
  /** Factory — called by the manager; allows tests to inject a fake handle. */
  createHandle: () => Promise<PtyHandle>;
  cols: number;
  rows: number;
}

interface InternalSession extends PtySession {
  /** Total bytes dropped from the front of the ring since session start. */
  droppedBytes: number;
  /** idle-timeout timer — reset on every input/output byte. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** hard cap timer — set at create, never reset. */
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  /** onData unsubscribe function. */
  unsubscribe: (() => void) | null;
  /** True once close() has been initiated — prevents re-entry. */
  closing: boolean;
}

export class PtySessionManager {
  private chats = new Map<string, Map<string, InternalSession>>();

  async create(chatId: string, opts: CreateSessionOpts): Promise<PtySession> {
    const chat = this.chats.get(chatId);
    const count = chat ? chat.size : 0;
    if (count >= MAX_CONCURRENT_PTYS_PER_CHAT) {
      throw new Error(
        `MAX_CONCURRENT_PTYS_PER_CHAT reached (limit=${MAX_CONCURRENT_PTYS_PER_CHAT}) for chatId=${chatId}`,
      );
    }

    // The factory is invoked BY the manager so that concurrency cap rejection
    // above happens without spawning anything. If the factory itself throws,
    // nothing leaks — there is no handle to clean up. If wiring the handle
    // *after* it's spawned throws, we best-effort kill the orphan so it
    // doesn't leak in the sandbox.
    const handle = await opts.createHandle();
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    try {
      const session: InternalSession = {
        sessionId,
        chatId,
        pid: handle.pid,
        cols: opts.cols,
        rows: opts.rows,
        createdAt: now,
        lastActivityAt: now,
        handle,
        buffer: [],
        readCursor: 0,
        bufferTruncated: false,
        droppedBytes: 0,
        idleTimer: null,
        lifetimeTimer: null,
        unsubscribe: null,
        closing: false,
      };

      // Subscribe to handle output
      session.unsubscribe = handle.onData((bytes) => {
        this.onData(session, bytes);
      });

      // idle + lifetime timers
      this.armIdleTimer(session);
      session.lifetimeTimer = setTimeout(() => {
        void this.killAndRemove(session, "lifetime");
      }, SESSION_MAX_LIFETIME_MS);

      // Natural exit — clean up
      handle.exited
        .then(
          () => {
            this.removeSession(session);
          },
          () => {
            this.removeSession(session);
          },
        )
        .catch((err) =>
          console.error("[pty-session-manager] exited handler failed:", err),
        );

      // Register
      let chatMap = this.chats.get(chatId);
      if (!chatMap) {
        chatMap = new Map();
        this.chats.set(chatId, chatMap);
      }
      chatMap.set(sessionId, session);

      return session;
    } catch (wiringErr) {
      // Handle was spawned but we failed to wire it up — kill it to avoid
      // leaking a live PTY in the sandbox.
      try {
        await handle.kill();
      } catch (killErr) {
        console.error(
          "[pty-session-manager] orphan kill failed pid=" + handle.pid + ":",
          killErr,
        );
      }
      throw wiringErr;
    }
  }

  get(chatId: string, sessionId: string): PtySession | undefined {
    return this.chats.get(chatId)?.get(sessionId);
  }

  list(chatId: string): PtySession[] {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return Array.from(chat.values());
  }

  /**
   * Returns bytes currently available starting at `session.readCursor`.
   * Does not advance the cursor.
   */
  peekBufferSize(session: PtySession): number {
    const total = this.totalBufferBytes(session);
    return Math.max(0, total - session.readCursor);
  }

  /**
   * Returns (and copies) bytes since `readCursor`, then advances the cursor.
   */
  consumeDelta(session: PtySession): Uint8Array {
    const total = this.totalBufferBytes(session);
    const start = Math.min(session.readCursor, total);
    const out = this.sliceBuffer(session, start, total);
    session.readCursor = total;
    return out;
  }

  /**
   * Returns the full accumulated buffer without advancing `readCursor`.
   * Intended for `action=view`.
   */
  snapshot(session: PtySession): Uint8Array {
    const total = this.totalBufferBytes(session);
    return this.sliceBuffer(session, 0, total);
  }

  async close(chatId: string, sessionId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    const session = chat?.get(sessionId);
    if (!session) return;
    await this.killAndRemove(session, "close");
  }

  async closeAll(chatId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const sessions = Array.from(chat.values());
    await Promise.all(sessions.map((s) => this.killAndRemove(s, "closeAll")));
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private onData(session: InternalSession, bytes: Uint8Array): void {
    if (session.closing) return;
    // Copy into an owned Uint8Array so callers can recycle buffers
    const chunk = new Uint8Array(bytes);
    session.buffer.push(chunk);
    session.lastActivityAt = Date.now();
    this.enforceRing(session);
    this.armIdleTimer(session);
  }

  private armIdleTimer(session: InternalSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.killAndRemove(session, "idle");
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  private enforceRing(session: InternalSession): void {
    let total = session.buffer.reduce((n, c) => n + c.byteLength, 0);
    while (total > MAX_BUFFER_BYTES && session.buffer.length > 0) {
      const dropped = session.buffer.shift()!;
      total -= dropped.byteLength;
      session.droppedBytes += dropped.byteLength;
      session.bufferTruncated = true;
      // Adjust readCursor — if bytes we had not yet shown were dropped,
      // clamp to 0 relative to the new buffer start.
      if (session.readCursor >= dropped.byteLength) {
        session.readCursor -= dropped.byteLength;
      } else {
        session.readCursor = 0;
      }
    }
  }

  private totalBufferBytes(session: PtySession): number {
    let n = 0;
    for (const chunk of session.buffer) n += chunk.byteLength;
    return n;
  }

  private sliceBuffer(
    session: PtySession,
    start: number,
    end: number,
  ): Uint8Array {
    if (end <= start) return new Uint8Array(0);
    const out = new Uint8Array(end - start);
    let outOffset = 0;
    let cursor = 0;
    for (const chunk of session.buffer) {
      const chunkStart = cursor;
      const chunkEnd = cursor + chunk.byteLength;
      if (chunkEnd <= start) {
        cursor = chunkEnd;
        continue;
      }
      if (chunkStart >= end) break;
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(chunk.byteLength, end - chunkStart);
      out.set(chunk.subarray(sliceStart, sliceEnd), outOffset);
      outOffset += sliceEnd - sliceStart;
      cursor = chunkEnd;
    }
    return out;
  }

  private async killAndRemove(
    session: InternalSession,
    _reason: "close" | "closeAll" | "idle" | "lifetime",
  ): Promise<void> {
    if (session.closing) {
      // Another caller is already closing — wait for removal to finish.
      const chat = this.chats.get(session.chatId);
      if (!chat || !chat.has(session.sessionId)) return;
      // Best-effort: await the handle's exited promise (still safe).
      await Promise.race([
        session.handle.exited.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, CLOSE_EXIT_FALLBACK_MS)),
      ]);
      return;
    }
    session.closing = true;

    // Stop timers before kicking kill — avoids the timer re-entering kill.
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.lifetimeTimer) {
      clearTimeout(session.lifetimeTimer);
      session.lifetimeTimer = null;
    }

    try {
      await session.handle.kill();
    } catch (err) {
      console.error(
        "[pty-session-manager] kill failed pid=" + session.pid + ":",
        err,
      );
    }

    await Promise.race([
      session.handle.exited.catch(() => undefined),
      new Promise<void>((resolve) =>
        setTimeout(resolve, CLOSE_EXIT_FALLBACK_MS),
      ),
    ]);

    this.removeSession(session);
  }

  private removeSession(session: InternalSession): void {
    if (session.unsubscribe) {
      try {
        session.unsubscribe();
      } catch (err) {
        console.error("[pty-session-manager] unsubscribe failed:", err);
      }
      session.unsubscribe = null;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.lifetimeTimer) {
      clearTimeout(session.lifetimeTimer);
      session.lifetimeTimer = null;
    }
    const chat = this.chats.get(session.chatId);
    if (chat) {
      chat.delete(session.sessionId);
      if (chat.size === 0) this.chats.delete(session.chatId);
    }
  }
}

/** Process-wide singleton used by `run_terminal_cmd` and `chat-handler`. */
export const ptySessionManager = new PtySessionManager();
