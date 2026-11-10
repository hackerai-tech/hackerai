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

import { createHash } from "node:crypto";
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

type RecordCheckpointIssueReason =
  "save_unacknowledged" | "checkpoint_threw" | "wait_deadline";

export type RecordCheckpointIssue = {
  terminalSessionId: string;
  sessionKind: "pty" | "command";
  reason: RecordCheckpointIssueReason;
};

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
  /** Latest checkpoint write; pending does not invalidate an earlier recordPath. */
  recordPersistenceStatus?: "pending" | "saved" | "failed";
  /** Compatibility flag: a bounded wait deadline is not a failed write. */
  readonly recordPersistenceFailed?: boolean;
  outputPath?: string;
}

/** Share checkpoint state across both terminal tools without treating delay as loss. */
export function terminalRecordPersistenceFields(session: PtySession) {
  return {
    ...(session.recordPersistenceStatus
      ? { recordPersistenceStatus: session.recordPersistenceStatus }
      : {}),
    ...(session.recordPersistenceFailed
      ? { recordPersistenceFailed: true }
      : {}),
  };
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
    /** Stop admitting retention I/O on shutdown; already sent operations settle normally. */
    prune: (signal?: AbortSignal) => Promise<void>;
    reportCheckpointIssue?: (issue: RecordCheckpointIssue) => void;
    /** High-overhead transports may persist only at lifecycle boundaries. */
    checkpointOnStart?: boolean;
    checkpointOnOutput?: boolean;
    pruneOnStart?: boolean;
  };
}

type RecordWork = {
  sessionId: string;
  pending: Set<Promise<void>>;
  checkpoints: Set<Promise<void>>;
  checkpointWaiters: Set<() => void>;
  retention: Set<AbortController>;
};

interface InternalSession extends PtySession {
  recordWork: RecordWork;
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
  /** A rejected transport observation is not proof the process exited. */
  processExitConfirmed: boolean;
  executionRecord?: CreateSessionOpts["executionRecord"];
  recordQueue: Promise<void>;
  recordWriting: boolean;
  recordDirty: boolean;
  reportedRecordCheckpointIssues: Set<RecordCheckpointIssueReason>;
  persistedRecordFingerprint?: string;
  persistedRecordAt?: number;
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
  private pendingCreates = new Map<string, Set<Promise<PtySession>>>();
  // Record work can outlive a tool's short checkpoint wait and a forgotten
  // foreground session. Keep ownership until the underlying transport settles.
  private recordWork = new Map<string, Set<RecordWork>>();

  private trackRecordWork(
    chatId: string,
    work: RecordWork,
    operation: Promise<void>,
    checkpoint = false,
  ): void {
    let groups = this.recordWork.get(chatId);
    if (!groups) this.recordWork.set(chatId, (groups = new Set()));
    groups.add(work);
    const pending = operation
      .catch(() => undefined)
      .finally(() => {
        work.pending.delete(pending);
        work.checkpoints.delete(pending);
        if (!work.pending.size && !work.retention.size) {
          const groups = this.recordWork.get(chatId);
          groups?.delete(work);
          if (groups?.size === 0) this.recordWork.delete(chatId);
        }
        for (const notify of work.checkpointWaiters) notify();
      });
    work.pending.add(pending);
    if (checkpoint) work.checkpoints.add(pending);
  }

  /** Wait only for this record's writes; a slow transport must remain pending. */
  async waitForPendingRecord(
    chatId: string,
    sessionId: string,
  ): Promise<boolean> {
    const groups = [...(this.recordWork.get(chatId) ?? [])].filter(
      (work) => work.sessionId === sessionId,
    );
    const pending = () => groups.some((work) => work.checkpoints.size > 0);
    if (!pending()) return false;
    return new Promise<boolean>((resolve) => {
      const finish = (stillPending: boolean) => {
        clearTimeout(timer);
        for (const work of groups) work.checkpointWaiters.delete(notify);
        resolve(stillPending);
      };
      const notify = () => {
        // Coalesced writes stay owned by the same group until its final save.
        if (!pending()) finish(false);
      };
      const timer = setTimeout(() => finish(true), RECORD_CHECKPOINT_WAIT_MS);
      for (const work of groups) work.checkpointWaiters.add(notify);
      // Timeout removes observers even if the underlying transport never settles.
      notify();
    });
  }

  async create(chatId: string, opts: CreateSessionOpts): Promise<PtySession> {
    const chat = this.chats.get(chatId);
    const count =
      [...(chat?.values() ?? [])].filter(
        (session) => !session.processExitConfirmed,
      ).length + (this.pendingCreates.get(chatId)?.size ?? 0);
    if (count >= MAX_CONCURRENT_PTYS_PER_CHAT) {
      throw new Error(
        `MAX_CONCURRENT_PTYS_PER_CHAT reached (limit=${MAX_CONCURRENT_PTYS_PER_CHAT}) for chatId=${chatId}`,
      );
    }

    // Reserve synchronously, before any asynchronous factory can spawn. The
    // same promise is owned by closeAll if shutdown starts during creation.
    let pending = this.pendingCreates.get(chatId);
    if (!pending) this.pendingCreates.set(chatId, (pending = new Set()));
    const creation = Promise.resolve().then(() =>
      this.createSession(chatId, opts),
    );
    pending.add(creation);
    try {
      return await creation;
    } finally {
      pending.delete(creation);
      if (!pending.size) this.pendingCreates.delete(chatId);
    }
  }

  private async createSession(
    chatId: string,
    opts: CreateSessionOpts,
  ): Promise<PtySession> {
    // The factory is invoked BY the manager so that concurrency cap rejection
    // above happens without spawning anything. If the factory itself throws,
    // nothing leaks — there is no handle to clean up. If wiring the handle
    // *after* it's spawned throws, we best-effort kill the orphan so it
    // doesn't leak in the sandbox.
    const handle = await opts.createHandle();
    const sessionId = shortSessionId(this.chats.get(chatId));
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
        get recordPersistenceFailed() {
          return this.recordPersistenceStatus === "failed";
        },
        droppedBytes: 0,
        idleTimer: null,
        lifetimeTimer: null,
        cleanupRetryTimer: null,
        cleanupFailureCount: 0,
        unsubscribe: null,
        closing: false,
        exitedNaturally: null,
        processExitConfirmed: false,
        executionRecord: opts.executionRecord,
        recordWork: {
          sessionId,
          pending: new Set(),
          checkpoints: new Set(),
          checkpointWaiters: new Set(),
          retention: new Set(),
        },
        recordQueue: Promise.resolve(),
        recordWriting: false,
        recordDirty: false,
        reportedRecordCheckpointIssues: new Set(),
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
            session.processExitConfirmed = true;
            void this.checkpoint(session).finally(() =>
              this.pruneCompleted(chatId),
            );
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
      if (opts.executionRecord?.checkpointOnStart !== false)
        void this.checkpoint(session);
      // Keep retention outside the critical command launch path. Some file
      // transports expand one scan into many remote exec/file requests, so
      // they defer retention instead of doing it for every command.
      if (opts.executionRecord && opts.executionRecord.pruneOnStart !== false) {
        const controller = new AbortController();
        const work = session.recordWork;
        work.retention.add(controller);
        this.trackRecordWork(
          chatId,
          work,
          Promise.resolve()
            .then(() => opts.executionRecord!.prune(controller.signal))
            .finally(() => {
              work.retention.delete(controller);
            }),
        );
      }

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
    const sessions = Array.from(this.chats.get(chatId)?.values() ?? []);
    const pending = [...(this.pendingCreates.get(chatId) ?? [])];
    const groups = new Set([
      ...(this.recordWork.get(chatId) ?? []),
      ...sessions.map((session) => session.recordWork),
    ]);
    // Include only factories admitted before this drain. Later responses own
    // their own creations, even if those factories finish first.
    const created = await Promise.allSettled(pending);
    for (const result of created) {
      if (result.status === "fulfilled") {
        const session = result.value as InternalSession;
        if (!sessions.includes(session)) sessions.push(session);
        groups.add(session.recordWork);
      }
    }
    // Capture only work owned at shutdown. A later response on this chat
    // must not be canceled or included in this response's drain.
    for (const work of groups) {
      for (const controller of work.retention) controller.abort();
    }
    const results = await Promise.allSettled(
      sessions.map((s) => this.killAndRemove(s, "closeAll")),
    );
    // The short checkpoint wait bounds a tool call, not receiver lifetime.
    // Await actual transports, including coalesced final writes, under their
    // existing deadlines. Already dispatched native work is never replayed.
    for (const work of groups) {
      while (work.pending.size) await Promise.allSettled([...work.pending]);
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  /** At most three observations per session; a wait deadline is not a failed write. */
  private reportRecordCheckpointIssue(
    session: InternalSession,
    reason: RecordCheckpointIssueReason,
  ): void {
    if (session.reportedRecordCheckpointIssues.has(reason)) return;
    session.reportedRecordCheckpointIssues.add(reason);
    try {
      session.executionRecord?.reportCheckpointIssue?.({
        terminalSessionId: session.sessionId,
        sessionKind: session.kind,
        reason,
      });
    } catch {
      // Diagnostics must not change persistence, coalescing, or cancellation.
    }
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
          const record: TerminalExecutionRecord = {
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
            // Ignore observation time when deciding whether a poll changed evidence.
            updatedAt: 0,
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
          };
          const fingerprint = createHash("sha256")
            .update(JSON.stringify(record))
            .digest("hex");
          // Retention can remove an older running record while other commands
          // finish. Refresh quiet sessions at most once a minute when polled.
          if (
            fingerprint === internal.persistedRecordFingerprint &&
            Date.now() - (internal.persistedRecordAt ?? 0) < 60_000
          )
            continue;
          record.updatedAt = Date.now();
          session.recordPersistenceStatus = "pending";
          const path = await internal.executionRecord!.save(record);
          session.recordPersistenceStatus = path ? "saved" : "failed";
          if (!path)
            this.reportRecordCheckpointIssue(internal, "save_unacknowledged");
          if (path) {
            session.recordPath = path;
            // Only acknowledge successful writes; unchanged failed snapshots retry.
            internal.persistedRecordFingerprint = fingerprint;
            internal.persistedRecordAt = record.updatedAt;
          }
        }
      })()
        .catch(() => {
          session.recordPersistenceStatus = "failed";
          this.reportRecordCheckpointIssue(internal, "checkpoint_threw");
        })
        .finally(async () => {
          internal.recordWriting = false;
          if (internal.recordDirty) await this.checkpoint(session);
        });
      this.trackRecordWork(
        session.chatId,
        internal.recordWork,
        internal.recordQueue,
        true,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      internal.recordQueue,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.reportRecordCheckpointIssue(internal, "wait_deadline");
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

  private pruneCompleted(chatId: string): void {
    // Retain a bounded in-memory history independently of the live-process cap.
    // Persisted records and outstanding writes retain their separate ownership.
    const completed = [...(this.chats.get(chatId)?.values() ?? [])].filter(
      (session) => session.processExitConfirmed && !session.closing,
    );
    for (const session of completed.slice(0, -MAX_CONCURRENT_PTYS_PER_CHAT)) {
      this.removeSession(session);
    }
  }

  private onData(session: InternalSession, bytes: Uint8Array): void {
    // Copy into an owned Uint8Array so callers can recycle buffers
    const chunk = new Uint8Array(bytes);
    session.buffer.push(chunk);
    session.lastActivityAt = Date.now();
    this.enforceRing(session);
    if (!session.closing) this.armIdleTimer(session);
    if (
      !session.closing &&
      session.executionRecord &&
      session.executionRecord.checkpointOnOutput !== false &&
      !session.recordTimer
    ) {
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
