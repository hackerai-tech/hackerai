/**
 * E2B PTY adapter.
 *
 * Wraps E2B's callback-style `sandbox.pty.create({onData, cols, rows, ...})`
 * into a listener-set based handle that higher-level code (PtySessionManager,
 * run_terminal_cmd action dispatch) can consume without thinking about E2B
 * internals. Every byte chunk emitted by E2B fans out to all subscribed
 * listeners; `exited` is a single memoized promise resolved from the E2B
 * handle's `wait()`.
 */

import type { Sandbox } from "@e2b/code-interpreter";

// ── Narrow structural types over the E2B SDK surface we actually touch ─
// Prevents `any` leakage and keeps the adapter resilient to SDK churn.

type PtyDataCb = (data: Uint8Array) => void | Promise<void>;

interface E2BPtyCreateOpts {
  cols: number;
  rows: number;
  onData: PtyDataCb;
  cwd?: string;
  envs?: Record<string, string>;
}

interface E2BCommandHandle {
  readonly pid: number;
  wait(): Promise<{ exitCode: number | null | undefined }>;
}

interface E2BPtyModule {
  create(opts: E2BPtyCreateOpts): Promise<E2BCommandHandle>;
  sendInput(pid: number, data: Uint8Array): Promise<void>;
  resize(pid: number, size: { cols: number; rows: number }): Promise<void>;
  kill(pid: number): Promise<boolean>;
}

interface SandboxWithPty {
  pty: E2BPtyModule;
}

// ── Public contract ─────────────────────────────────────────────────

export interface PtyHandle {
  readonly pid: number;
  sendInput(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  /** Returns an unsubscribe function. */
  onData(cb: (bytes: Uint8Array) => void): () => void;
  readonly exited: Promise<{ exitCode: number | null }>;
}

export interface CreatePtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
  envs?: Record<string, string>;
}

// ── Implementation ──────────────────────────────────────────────────

const LOG_PREFIX = "[e2b-pty-adapter]";

export async function createE2BPtyHandle(
  sandbox: Sandbox,
  opts: CreatePtyOptions,
): Promise<PtyHandle> {
  const pty = (sandbox as unknown as SandboxWithPty).pty;

  const listeners = new Set<(bytes: Uint8Array) => void>();

  const onData: PtyDataCb = (data) => {
    // Snapshot to tolerate listener churn (unsubscribe during iteration).
    const snapshot = Array.from(listeners);
    for (const listener of snapshot) {
      try {
        listener(data);
      } catch (err) {
        console.error(`${LOG_PREFIX} listener threw:`, err);
      }
    }
  };

  const handle = await pty.create({
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    envs: opts.envs,
    onData,
  });

  const pid = handle.pid;

  // Kick off wait() immediately so `exited` resolves exactly once and all
  // consumers share the same resolution. Any rejection is normalized to
  // {exitCode: null} with a structured log — the error is surfaced, not
  // swallowed silently.
  const exited: Promise<{ exitCode: number | null }> = handle
    .wait()
    .then((result) => ({
      exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
    }))
    .catch((err: unknown) => {
      console.error(`${LOG_PREFIX} pty wait() rejected for pid=${pid}:`, err);
      return { exitCode: null };
    });

  return {
    pid,
    sendInput(bytes: Uint8Array): Promise<void> {
      return pty.sendInput(pid, bytes);
    },
    async resize(cols: number, rows: number): Promise<void> {
      await pty.resize(pid, { cols, rows });
    },
    async kill(): Promise<void> {
      await pty.kill(pid);
    },
    onData(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get exited() {
      return exited;
    },
  };
}
