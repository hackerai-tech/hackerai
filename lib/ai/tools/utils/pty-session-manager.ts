/**
 * Per-chat terminal session store.
 *
 * Live handles belong to one assistant response. Cleanup closes those handles,
 * but bounded execution records survive in the owning sandbox for later turns.
 * Records are historical evidence, never authority to adopt or kill an old PID.
 * The Node-side object here is a per-chat cache with ring
 * buffer, idle/lifetime timers and bookkeeping to compute deltas for
 * `action=wait` / `action=view`.
 *
 * Most sessions are interactive PTYs. A foreground non-interactive command
 * that outlives its initial wait window is registered as `kind="command"` so
 * the model receives a real opaque session id instead of trying to derive one
 * from an OS PID.
 */

import type { PtyHandle } from "./e2b-pty-adapter";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";
import type { AgentApprovalSandboxIdentity } from "@/types";
import type { TerminalExecutionRecord } from "./terminal-execution-record";

export const MAX_CONCURRENT_PTYS_PER_CHAT = 10;
export const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
export const SESSION_MAX_LIFETIME_MS = 60 * 60_000;
export const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Fixed PTY geometry. We DO NOT let the AI model pick these — a terminal
 * size should match a real display, not a model-chosen value. UIs that
 * render the PTY elsewhere (xterm.js in the sidebar, a real TTY on the
 * Tauri side) can still call `PtyHandle.resize()` directly.
 */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 30;

const CLOSE_EXIT_FALLBACK_MS = 2_000;
const FAILED_COMMAND_CLEANUP_RETRY_BASE_MS = 5_000;
const FAILED_COMMAND_CLEANUP_RETRY_MAX_MS = 30_000;
const MAX_FAILED_COMMAND_CLEANUP_ATTEMPTS = 6;
const RECORD_CHECKPOINT_INTERVAL_MS = 10_000;
const RECORD_CHECKPOINT_WAIT_MS = 2_000;

export interface PtySession {
  readonly sessionId: string;
  readonly chatId: string;
  readonly kind: "pty" | "command";
  readonly sandboxIdentity: AgentApprovalSandboxIdentity;
  /** Exact command that created the process represented by this session. */
  readonly originalCommand: string;
  /** Working directory used when the originating command was started. */
  readonly workingDirectory?: string;
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
  recordPath?: string;
  recordPersistenceFailed?: boolean;
  outputPath?: string;
}

export interface CreateSessionOpts {
  /** Factory — called by the manager; allows tests to inject a fake handle. */
  createHandle: () => Promise<PtyHandle>;
  cols: number;
  rows: number;
  kind?: "pty" | "command";
  /** Sandbox/connection that owns the underlying process. */
  sandboxIdentity: AgentApprovalSandboxIdentity;
  /** Exact command that created the process represented by this session. */
  originalCommand: string;
  /** Working directory used when the originating command was started. */
  workingDirectory?: string;
  executionRecord?: {
    sandboxInstance: string;
    artifactPaths: string[];
    save: (record: TerminalExecutionRecord) => Promise<string | null>;
    prune: () => Promise<void>;
  };
}

interface InternalSession extends PtySession {
  /** Total bytes dropped from the front of the ring since session start. */
  droppedBytes: number;
  /** idle-timeout timer — reset on every input/output byte. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** hard cap timer — set at create, never reset. */
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  /** bounded retry timer after command transport termination fails. */
  cleanupRetryTimer: ReturnType<typeof setTimeout> | null;
  /** consecutive unexpected command cleanup failures. */
  cleanupFailureCount: number;
  /** onData unsubscribe function. */
  unsubscribe: (() => void) | null;
  /** True once close() has been initiated — prevents re-entry. */
  closing: boolean;
  /** Set when the process exits naturally — session stays around for view/wait. */
  exitedNaturally: { exitCode: number | null } | null;
  executionRecord?: CreateSessionOpts["executionRecord"];
  recordQueue: Promise<void>;
  recordWriting: boolean;
  recordDirty: boolean;
  recordTimer: ReturnType<typeof setTimeout> | null;
  exitReason: string | null;
}

/**
 * 8 hex chars = 32 bits of entropy. With MAX_CONCURRENT_PTYS_PER_CHAT
 * collisions are negligible (~10^-8 per chat at the cap), but we still
 * retry a handful of times on the off chance.
 *
 * Short ids matter because the agent has to copy this value into every
 * `interact_terminal_session` call — full UUIDs cost tokens and make
 * tool args more error-prone.
 */
function shortSessionId(
  taken: ReadonlyMap<string, unknown> | undefined,
): string {
  for (let i = 0; i < 5; i++) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    if (!taken || !taken.has(id)) return id;
  }
  throw new Error("Failed to generate unique session id after 5 attempts");
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
    const sessionId = shortSessionId(chat);
    const now = Date.now();

    try {
      const session: InternalSession = {
        sessionId,
        chatId,
        kind: opts.kind ?? "pty",
        // Keep a defensive Cloud default for untyped legacy callers while
        // requiring all current typed call sites to provide the identity.
        sandboxIdentity: opts.sandboxIdentity ?? "e2b",
        originalCommand: opts.originalCommand,
        ...(opts.workingDirectory
          ? { workingDirectory: opts.workingDirectory }
          : {}),
        get pid() {
          return handle.pid;
        },
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
        cleanupRetryTimer: null,
        cleanupFailureCount: 0,
        unsubscribe: null,
        closing: false,
        exitedNaturally: null,
        executionRecord: opts.executionRecord,
        recordQueue: Promise.resolve(),
        recordWriting: false,
        recordDirty: false,
        recordTimer: null,
        exitReason: null,
      };

      // Subscribe to handle output
      session.unsubscribe = handle.onData((bytes) => {
        this.onData(session, bytes);
      });

      // idle + lifetime timers
      this.armIdleTimer(session);
      session.lifetimeTimer = setTimeout(() => {
        void this.killAndRemove(session, "lifetime").catch(() => {});
      }, SESSION_MAX_LIFETIME_MS);

      // Natural exit — mark as exited but keep session around so the model
      // can still call view/wait to read the final output. closeAll() or
      // kill will do the actual cleanup.
      handle.exited
        .then(
          (info) => {
            session.exitedNaturally = { exitCode: info.exitCode };
            void this.checkpoint(session);
          },
          () => {
            session.exitedNaturally = { exitCode: null };
            session.exitReason ??= "transport_error";
            void this.checkpoint(session);
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
      void this.checkpoint(session);
      // Keep retention outside the critical command launch path.
      void opts.executionRecord?.prune();

      return session;
    } catch (wiringErr) {
      // Handle was spawned but we failed to wire it up — kill it to avoid
      // leaking a live PTY in the sandbox.
      try {
        await handle.kill();
      } catch (killErr) {
        if (isExpectedAlreadyGoneCleanupError(killErr)) {
          console.debug(
            "[pty-session-manager] orphan already gone pid=" + handle.pid + ":",
            killErr,
          );
          throw wiringErr;
        }
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

  /** Persist bounded evidence before a tool yields or live handles are removed. */
  async checkpoint(session: PtySession, reason?: string): Promise<void> {
    const internal = session as InternalSession;
    if (reason) internal.exitReason = reason;
    if (!internal.executionRecord) return;
    internal.recordDirty = true;
    if (!internal.recordWriting) {
      internal.recordWriting = true;
      internal.recordQueue = (async () => {
        // Coalesce updates while the sandbox file transport is slow. Writes
        // remain ordered, so a late running snapshot cannot replace a stop.
        while (internal.recordDirty) {
          internal.recordDirty = false;
          const exit = internal.exitedNaturally;
          const status =
            internal.exitReason === "termination_unconfirmed"
              ? "unknown"
              : internal.exitReason && internal.exitReason !== "transport_error"
                ? "stopped"
                : exit
                  ? exit.exitCode === 0
                    ? "completed"
                    : "failed"
                  : "running";
          const path = await internal.executionRecord!.save({
            version: 1,
            session: session.sessionId,
            sandboxInstance: internal.executionRecord!.sandboxInstance,
            command: (session.originalCommand ?? "").slice(0, 32_768),
            workingDirectory: session.workingDirectory,
            pid: session.pid,
            status,
            exitCode: exit?.exitCode ?? null,
            exitReason: internal.exitReason ?? (exit ? "process_exit" : null),
            createdAt: session.createdAt,
            updatedAt: Date.now(),
            output: new TextDecoder().decode(this.snapshot(session)),
            outputTruncated: session.bufferTruncated,
            artifactPaths: [
              ...new Set([
                ...(session.outputPath ? [session.outputPath] : []),
                ...internal.executionRecord!.artifactPaths,
              ]),
            ]
              .filter((path) => path.length <= 4096)
              .slice(0, 32),
          });
          session.recordPersistenceFailed = !path;
          if (path) session.recordPath = path;
        }
      })()
        .catch(() => {
          session.recordPersistenceFailed = true;
        })
        .finally(async () => {
          internal.recordWriting = false;
          if (internal.recordDirty) await this.checkpoint(session);
        });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      internal.recordQueue,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          session.recordPersistenceFailed = true;
          resolve();
        }, RECORD_CHECKPOINT_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Remove a completed, unexposed session without sending a redundant kill.
   * Used for ordinary non-interactive commands that finish inside the initial
   * run_terminal_cmd wait window.
   */
  async forget(chatId: string, sessionId: string): Promise<void> {
    const session = this.chats.get(chatId)?.get(sessionId);
    if (!session) return;
    await this.checkpoint(session);
    this.removeSession(session);
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private onData(session: InternalSession, bytes: Uint8Array): void {
    // Copy into an owned Uint8Array so callers can recycle buffers
    const chunk = new Uint8Array(bytes);
    session.buffer.push(chunk);
    session.lastActivityAt = Date.now();
    this.enforceRing(session);
    if (!session.closing) this.armIdleTimer(session);
    if (!session.closing && session.executionRecord && !session.recordTimer) {
      session.recordTimer = setTimeout(() => {
        session.recordTimer = null;
        void this.checkpoint(session);
      }, RECORD_CHECKPOINT_INTERVAL_MS);
    }
  }

  private armIdleTimer(session: InternalSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.killAndRemove(session, "idle").catch(() => {});
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  private enforceRing(session: InternalSession): void {
    let total = session.buffer.reduce((n, c) => n + c.byteLength, 0);
    while (total > MAX_BUFFER_BYTES && session.buffer.length > 0) {
      const first = session.buffer[0];
      const dropCount = Math.min(first.byteLength, total - MAX_BUFFER_BYTES);
      if (dropCount === first.byteLength) session.buffer.shift();
      else session.buffer[0] = first.slice(dropCount);
      total -= dropCount;
      session.droppedBytes += dropCount;
      session.bufferTruncated = true;
      // Adjust readCursor — if bytes we had not yet shown were dropped,
      // clamp to 0 relative to the new buffer start.
      if (session.readCursor >= dropCount) {
        session.readCursor -= dropCount;
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
    reason: "close" | "closeAll" | "idle" | "lifetime",
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
    if (!session.exitedNaturally) {
      if (
        !session.exitReason ||
        session.exitReason === "termination_unconfirmed"
      )
        session.exitReason =
          reason === "closeAll"
            ? "response_cleanup"
            : reason === "close"
              ? "user_cancelled"
              : `${reason}_limit`;
    }

    // Stop timers before kicking kill — avoids the timer re-entering kill.
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.lifetimeTimer) {
      clearTimeout(session.lifetimeTimer);
      session.lifetimeTimer = null;
    }
    if (session.cleanupRetryTimer) {
      clearTimeout(session.cleanupRetryTimer);
      session.cleanupRetryTimer = null;
    }

    let unexpectedKillError: unknown;
    try {
      await session.handle.kill();
    } catch (err) {
      if (isExpectedAlreadyGoneCleanupError(err)) {
        console.debug(
          "[pty-session-manager] session already gone pid=" + session.pid + ":",
          err,
        );
      } else {
        console.error(
          "[pty-session-manager] kill failed pid=" + session.pid + ":",
          err,
        );
        unexpectedKillError = err;
      }
    }

    // A command session represents a still-running foreground execution. If
    // its transport could not confirm termination, keep the handle and output
    // buffer registered rather than claiming success and losing the only safe
    // way to retry cleanup. Natural exit or a later cleanup attempt can still
    // settle and remove it.
    if (unexpectedKillError && session.kind === "command") {
      await this.checkpoint(session, "termination_unconfirmed");
      session.closing = false;
      session.cleanupFailureCount += 1;
      const lifetimeRemaining =
        session.createdAt + SESSION_MAX_LIFETIME_MS - Date.now();
      const cleanupExhausted =
        session.cleanupFailureCount >= MAX_FAILED_COMMAND_CLEANUP_ATTEMPTS ||
        lifetimeRemaining <= 0;

      if (cleanupExhausted) {
        // The transport repeatedly failed to terminate a command. Drop only
        // the local bookkeeping at the bounded retry/lifetime cap so one
        // broken handle cannot permanently consume a per-chat session slot.
        this.removeSession(session);
        throw unexpectedKillError;
      }

      const retryDelayMs = Math.min(
        FAILED_COMMAND_CLEANUP_RETRY_BASE_MS *
          2 ** (session.cleanupFailureCount - 1),
        FAILED_COMMAND_CLEANUP_RETRY_MAX_MS,
      );
      session.cleanupRetryTimer = setTimeout(() => {
        void this.killAndRemove(session, "idle").catch(() => {});
      }, retryDelayMs);
      session.lifetimeTimer = setTimeout(() => {
        void this.killAndRemove(session, "lifetime").catch(() => {});
      }, lifetimeRemaining);
      throw unexpectedKillError;
    }

    await Promise.race([
      session.handle.exited.catch(() => undefined),
      new Promise<void>((resolve) =>
        setTimeout(resolve, CLOSE_EXIT_FALLBACK_MS),
      ),
    ]);
    await this.checkpoint(session);
    this.removeSession(session);
  }

  private removeSession(session: InternalSession): void {
    if (session.recordTimer) clearTimeout(session.recordTimer);
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
    if (session.cleanupRetryTimer) {
      clearTimeout(session.cleanupRetryTimer);
      session.cleanupRetryTimer = null;
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
