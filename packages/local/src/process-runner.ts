import * as os from "os";

import * as pty from "node-pty";

import type { IPty } from "node-pty";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface ProcessRunResult {
  pid: number;
}

export interface ProcessRunnerEvents {
  data: (sessionId: string, data: string) => void;
  exit: (sessionId: string, exitCode: number) => void;
  error: (sessionId: string, error: Error) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 16;
const FLUSH_THRESHOLD_BYTES = 32 * 1024; // 32 KB
const SIGTERM_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// ProcessRunner
// ---------------------------------------------------------------------------

export class ProcessRunner {
  private readonly activeProcesses: Map<string, IPty> = new Map();
  private readonly outputBuffers: Map<string, string> = new Map();
  private readonly killTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly listeners: Map<
    keyof ProcessRunnerEvents,
    ProcessRunnerEvents[keyof ProcessRunnerEvents]
  > = new Map();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Event registration
  // -----------------------------------------------------------------------

  on<K extends keyof ProcessRunnerEvents>(
    event: K,
    listener: ProcessRunnerEvents[K],
  ): void {
    this.listeners.set(event, listener);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  run(
    sessionId: string,
    command: string,
    opts: ProcessRunOptions = {},
  ): ProcessRunResult {
    const cwd = opts.cwd ?? process.cwd();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    const shell = os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash";

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
    };

    if (opts.env) {
      Object.assign(env, opts.env);
    }

    const proc: IPty = pty.spawn(shell, ["-l", "-c", command], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    this.activeProcesses.set(sessionId, proc);
    this.outputBuffers.set(sessionId, "");

    proc.onData((data: string) => {
      const current = this.outputBuffers.get(sessionId) ?? "";
      const updated = current + data;
      this.outputBuffers.set(sessionId, updated);

      if (updated.length >= FLUSH_THRESHOLD_BYTES) {
        this.flush(sessionId);
      }
    });

    proc.onExit(({ exitCode }) => {
      this.flush(sessionId);
      this.activeProcesses.delete(sessionId);
      this.outputBuffers.delete(sessionId);
      this.clearKillTimer(sessionId);
      this.emit("exit", sessionId, exitCode ?? -1);
    });

    return { pid: proc.pid };
  }

  write(sessionId: string, data: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }
    proc.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }
    proc.resize(cols, rows);
    return true;
  }

  stop(sessionId: string, _signal?: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }

    proc.kill("SIGTERM");

    const timer = setTimeout(() => {
      if (this.activeProcesses.has(sessionId)) {
        proc.kill("SIGKILL");
        this.activeProcesses.delete(sessionId);
        this.outputBuffers.delete(sessionId);
      }
    }, SIGTERM_GRACE_MS);
    this.killTimers.set(sessionId, timer);

    return true;
  }

  stopAll(): void {
    for (const sessionId of this.activeProcesses.keys()) {
      this.stop(sessionId);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.activeProcesses.has(sessionId);
  }

  dispose(): void {
    this.stopAll();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const timer of this.killTimers.values()) {
      clearTimeout(timer);
    }
    this.killTimers.clear();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private emit<K extends keyof ProcessRunnerEvents>(
    event: K,
    ...args: Parameters<ProcessRunnerEvents[K]>
  ): void {
    const listener = this.listeners.get(event) as
      | ProcessRunnerEvents[K]
      | undefined;
    if (listener) {
      (listener as (...a: Parameters<ProcessRunnerEvents[K]>) => void)(...args);
    }
  }

  private flush(sessionId: string): void {
    const buffer = this.outputBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) {
      return;
    }
    this.outputBuffers.set(sessionId, "");
    this.emit("data", sessionId, buffer);
  }

  private flushAll(): void {
    for (const sessionId of this.outputBuffers.keys()) {
      this.flush(sessionId);
    }
  }

  private clearKillTimer(sessionId: string): void {
    const timer = this.killTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(sessionId);
    }
  }
}
