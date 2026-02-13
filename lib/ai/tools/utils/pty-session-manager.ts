import { randomUUID } from "crypto";
import {
  stripTerminalEscapes,
  stripCommandEcho,
  stripSentinelNoise,
} from "./pty-output";
import { translateInput } from "./pty-keys";

/**
 * Minimal interface for a sandbox with PTY support.
 * Both E2B Sandbox and ConvexSandbox implement this.
 */
export interface SandboxWithPty {
  pty: {
    create: (opts: {
      cols: number;
      rows: number;
      onData: (data: Uint8Array) => void;
      timeoutMs?: number;
      envs?: Record<string, string>;
      cwd?: string;
      user?: string;
    }) => Promise<{
      pid: number;
      disconnect: () => Promise<void>;
      kill: () => Promise<boolean>;
      wait: () => Promise<{ exitCode: number }>;
    }>;
    sendInput: (pid: number, data: Uint8Array) => Promise<void>;
    kill: (pid: number) => Promise<boolean>;
    connect: (
      pid: number,
      opts: { onData: (data: Uint8Array) => void },
    ) => Promise<{
      pid: number;
      disconnect: () => Promise<void>;
      wait: () => Promise<{ exitCode: number }>;
    }>;
  };
  commands: {
    run: (
      command: string,
      opts?: { timeoutMs?: number },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  /**
   * Optional: Returns true if the sandbox is running in dangerous mode on Windows.
   * When true, the sentinel command uses PowerShell syntax instead of bash.
   * Only ConvexSandbox implements this; E2B Sandbox always returns false/undefined.
   */
  isWindowsDangerousMode?: () => boolean;
}

interface PtySession {
  outputBuffer: string;
  lastReadIndex: number;
}

/**
 * Manages persistent PTY sessions scoped to a single chat context.
 *
 * Sessions are keyed by their PTY process ID (pid). The `exec` action
 * creates a new PTY and returns the pid; all subsequent actions reference
 * that pid directly.
 *
 * Works with both E2B Sandbox and ConvexSandbox (local) through the
 * SandboxWithPty interface — both implement the same pty.* API surface.
 *
 * Completion detection:
 * `execInSession` appends a sentinel marker (`echo __DONE_<uuid>__$?`) after
 * the user's command. When the marker appears in the PTY output, the command
 * has finished and we extract the exit code from the marker line. This avoids
 * both the "wait the full timeout" problem and the fragile idle-threshold hack.
 */
export class PtySessionManager {
  private sessions: Map<number, PtySession> = new Map();
  private streamCallbacks: Map<number, (data: string) => void> = new Map();
  /** Per-pid callback fired on every data chunk (for sentinel detection). */
  private dataCallbacks: Map<number, () => void> = new Map();
  /** Active sentinel per pid — used to filter sentinel noise from real-time stream. */
  private activeSentinels: Map<number, string> = new Map();
  /** Sentinel from an exec that timed out — `wait` uses this for early completion. */
  private pendingSentinels: Map<number, string> = new Map();
  private motdSuppressed = false;

  /** Sessions currently executing a command — not available for reuse. */
  private busySessions: Set<number> = new Set();
  /** Pool of idle sessions available for reuse (LIFO for locality). */
  private idleSessions: number[] = [];

  // ---------------------------------------------------------------------------
  // Callback management
  // ---------------------------------------------------------------------------

  setStreamCallback(pid: number, cb: (data: string) => void): void {
    this.streamCallbacks.set(pid, cb);
  }

  clearStreamCallback(pid: number): void {
    this.streamCallbacks.delete(pid);
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async createSession(sandbox: SandboxWithPty): Promise<number> {
    if (!this.motdSuppressed) {
      try {
        await sandbox.commands.run(
          "touch /root/.hushlogin /home/user/.hushlogin",
          { timeoutMs: 3000 },
        );
      } catch {
        /* non-critical */
      }
      this.motdSuppressed = true;
    }

    const session: PtySession = { outputBuffer: "", lastReadIndex: 0 };

    let sessionReady = false;
    let pid = 0;

    const terminal = await sandbox.pty.create({
      cols: 200,
      rows: 50,
      timeoutMs: 0,
      onData: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        session.outputBuffer += text;

        if (sessionReady) {
          // Forward to frontend stream — filter out sentinel noise + prompts
          const streamCb = this.streamCallbacks.get(pid);
          if (streamCb && text.trim()) {
            const sentinel = this.activeSentinels.get(pid);
            let filtered = text
              .split("\n")
              .filter((line) => {
                // Active sentinel from current exec (command echo + result marker)
                if (sentinel && line.includes(sentinel)) return false;
                // Stale sentinels from a previous exec that finished post-timeout
                if (/__DONE_[a-f0-9]+__/.test(line)) return false;
                return true;
              })
              .join("\n");
            filtered = stripTerminalEscapes(filtered);
            if (filtered.trim()) streamCb(filtered);
          }
          // Notify sentinel watcher
          const dataCb = this.dataCallbacks.get(pid);
          if (dataCb) dataCb();
        }
      },
      user: "root",
      cwd: "/home/user",
    });

    pid = terminal.pid;
    this.sessions.set(pid, session);

    // Let initial prompt settle, then discard startup noise
    await new Promise((resolve) => setTimeout(resolve, 1000));
    session.outputBuffer = "";
    session.lastReadIndex = 0;
    sessionReady = true;

    return pid;
  }

  hasSession(pid: number): boolean {
    return this.sessions.has(pid);
  }

  /**
   * Acquire a PTY session for an exec call.
   *
   * Returns an idle session when available (preserving working directory for
   * sequential commands) or creates a new one. This ensures parallel execs
   * each get their own isolated PTY so output never bleeds between tool calls.
   */
  async acquireSession(sandbox: SandboxWithPty): Promise<number> {
    // Try to reuse an idle session
    while (this.idleSessions.length > 0) {
      const pid = this.idleSessions.pop()!;
      if (this.sessions.has(pid)) {
        this.busySessions.add(pid);
        return pid;
      }
    }
    // No idle sessions available — create a fresh one
    const pid = await this.createSession(sandbox);
    this.busySessions.add(pid);
    return pid;
  }

  /**
   * Return a session to the idle pool after a command completes.
   * Should NOT be called for timed-out execs (the session stays busy
   * until `wait` or `kill` finishes).
   */
  releaseSession(pid: number): void {
    this.busySessions.delete(pid);
    if (this.sessions.has(pid)) {
      this.idleSessions.push(pid);
    }
  }

  /**
   * Reconnect to an existing PTY process that is still running in the sandbox
   * but is no longer tracked locally (e.g., after a new HTTP request).
   */
  async reconnectSession(
    sandbox: SandboxWithPty,
    pid: number,
  ): Promise<boolean> {
    if (this.sessions.has(pid)) return true;

    const session: PtySession = { outputBuffer: "", lastReadIndex: 0 };

    try {
      await sandbox.pty.connect(pid, {
        onData: (data: Uint8Array) => {
          const text = new TextDecoder().decode(data);
          session.outputBuffer += text;

          const streamCb = this.streamCallbacks.get(pid);
          if (streamCb && text.trim()) {
            const sentinel = this.activeSentinels.get(pid);
            let filtered = text
              .split("\n")
              .filter((line) => {
                if (sentinel && line.includes(sentinel)) return false;
                if (/__DONE_[a-f0-9]+__/.test(line)) return false;
                return true;
              })
              .join("\n");
            filtered = stripTerminalEscapes(filtered);
            if (filtered.trim()) streamCb(filtered);
          }

          const dataCb = this.dataCallbacks.get(pid);
          if (dataCb) dataCb();
        },
      });

      this.sessions.set(pid, session);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Execute a command in a PTY session.
   *
   * Sends `command ; echo __DONE_<uuid>__$?\n` so we can detect when the
   * command finishes AND capture its exit code from the marker line.
   * Resolves as soon as the sentinel is found, or on timeout/abort.
   */
  async execInSession(
    sandbox: SandboxWithPty,
    pid: number,
    command: string,
    timeoutSeconds: number,
    abortSignal?: AbortSignal,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    const session = this.sessions.get(pid);
    if (!session) {
      return {
        output: "[Error: session not found]",
        exitCode: null,
        timedOut: false,
      };
    }

    const sentinel = `__DONE_${randomUUID().replace(/-/g, "")}__`;
    const startIndex = session.outputBuffer.length;

    // Register sentinel so the onData handler filters it from the live stream
    this.activeSentinels.set(pid, sentinel);

    // Build platform-appropriate sentinel command:
    // - Bash/zsh: `command ; echo __DONE_uuid__$?`
    // - PowerShell (Windows dangerous mode): `command ; Write-Host "${sentinel}$LASTEXITCODE"`
    // - Background commands (ending with &): use newline instead of semicolon to avoid syntax errors
    const isWindowsPS = sandbox.isWindowsDangerousMode?.() ?? false;
    const isBackgroundCommand = command.trim().endsWith("&");

    let fullCommand: string;
    if (isWindowsPS) {
      fullCommand = isBackgroundCommand
        ? `${command}\nWrite-Host "${sentinel}$LASTEXITCODE"\n`
        : `${command} ; Write-Host "${sentinel}$LASTEXITCODE"\n`;
    } else {
      fullCommand = isBackgroundCommand
        ? `${command}\necho ${sentinel}$?\n`
        : `${command} ; echo ${sentinel}$?\n`;
    }

    await sandbox.pty.sendInput(pid, new TextEncoder().encode(fullCommand));

    const timeoutMs = timeoutSeconds * 1000;

    return new Promise<{
      output: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        this.activeSentinels.delete(pid);
        this.dataCallbacks.delete(pid);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        abortSignal?.removeEventListener("abort", abortHandler);
      };

      const finish = (timedOut: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup();

        // Stash sentinel so a future `wait` can detect completion
        if (timedOut) {
          this.pendingSentinels.set(pid, sentinel);
        } else {
          this.pendingSentinels.delete(pid);
        }

        const rawOutput = session.outputBuffer.slice(startIndex);
        session.lastReadIndex = session.outputBuffer.length;

        // Extract exit code and strip sentinel from output
        const sentinelRegex = new RegExp(`${sentinel}(\\d+)`, "m");
        const match = rawOutput.match(sentinelRegex);
        const exitCode = match ? parseInt(match[1], 10) : null;

        // Remove the sentinel line (and surrounding blank lines) and command echo
        let cleaned = rawOutput.replace(
          new RegExp(`\\n?.*${sentinel}\\d*.*\\n?`, "g"),
          "",
        );
        cleaned = stripCommandEcho(cleaned, command);
        cleaned = stripTerminalEscapes(cleaned);

        resolve({ output: cleaned, exitCode, timedOut });
      };

      // Abort handler — treat like timeout so the session stays busy
      // and the sentinel is preserved (the command is still running).
      const abortHandler = () => finish(true);
      if (abortSignal) {
        if (abortSignal.aborted) {
          finish(true);
          return;
        }
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }

      // Timeout handler
      const timeoutTimer = setTimeout(() => finish(true), timeoutMs);

      // Watch for sentinel *with resolved exit code* in output.
      // The PTY echoes back the raw command (`echo __DONE_xx__$?`) immediately,
      // but the actual output line has digits instead of `$?` (e.g. `__DONE_xx__0`).
      // By requiring a digit after the sentinel, we only match the real output.
      const sentinelWithDigit = new RegExp(`${sentinel}\\d`);
      const checkSentinel = () => {
        const recent = session.outputBuffer.slice(startIndex);
        if (sentinelWithDigit.test(recent)) {
          finish(false);
        }
      };
      this.dataCallbacks.set(pid, checkSentinel);
    });
  }

  /**
   * Wait for additional output from an already-running session.
   *
   * If the session has a pending sentinel (from a timed-out `exec`), we watch
   * for it and resolve early when the command finishes. Otherwise falls back
   * to the full timeout.
   */
  async waitForSession(
    pid: number,
    timeoutSeconds: number,
    abortSignal?: AbortSignal,
  ): Promise<{ output: string; timedOut: boolean }> {
    const session = this.sessions.get(pid);
    if (!session)
      return { output: "[Error: session not found]", timedOut: false };

    const startIndex = session.lastReadIndex;
    const timeoutMs = timeoutSeconds * 1000;
    const sentinel = this.pendingSentinels.get(pid);

    return new Promise<{ output: string; timedOut: boolean }>((resolve) => {
      let resolved = false;

      const cleanup = (timedOut: boolean) => {
        this.dataCallbacks.delete(pid);
        if (sentinel) {
          if (timedOut) {
            // Preserve sentinel so a subsequent wait can still detect completion
            this.pendingSentinels.set(pid, sentinel);
          } else {
            this.pendingSentinels.delete(pid);
          }
          this.activeSentinels.delete(pid);
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        abortSignal?.removeEventListener("abort", abortHandler);
      };

      const finish = (timedOut: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup(timedOut);

        const rawOutput = session.outputBuffer.slice(startIndex);
        session.lastReadIndex = session.outputBuffer.length;
        resolve({
          output: stripTerminalEscapes(stripSentinelNoise(rawOutput)),
          timedOut,
        });
      };

      // Abort handler — treat like timeout so the session stays busy
      // and the pending sentinel is preserved (the command is still running).
      const abortHandler = () => finish(true);
      if (abortSignal) {
        if (abortSignal.aborted) {
          finish(true);
          return;
        }
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }

      const timeoutTimer = setTimeout(() => finish(true), timeoutMs);

      // If there's a pending sentinel from a timed-out exec, watch for it
      if (sentinel) {
        this.activeSentinels.set(pid, sentinel);
        const sentinelWithDigit = new RegExp(`${sentinel}\\d`);
        const checkSentinel = () => {
          const recent = session.outputBuffer.slice(startIndex);
          if (sentinelWithDigit.test(recent)) {
            finish(false);
          }
        };
        this.dataCallbacks.set(pid, checkSentinel);
        // Check immediately — sentinel may have arrived before wait was called
        checkSentinel();
      }
    });
  }

  async sendToSession(
    sandbox: SandboxWithPty,
    pid: number,
    input: string,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(pid);
    if (!session) return { success: false, error: "Session not found" };

    try {
      await sandbox.pty.sendInput(pid, translateInput(input));
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "sendInput failed",
      };
    }
    return { success: true };
  }

  async killSession(
    sandbox: SandboxWithPty,
    pid: number,
  ): Promise<{ killed: boolean }> {
    const session = this.sessions.get(pid);
    if (!session) return { killed: false };

    try {
      await sandbox.pty.kill(pid);
    } catch {
      /* may already be dead */
    }

    this.sessions.delete(pid);
    this.streamCallbacks.delete(pid);
    this.dataCallbacks.delete(pid);
    this.activeSentinels.delete(pid);
    this.pendingSentinels.delete(pid);
    this.busySessions.delete(pid);
    // Remove from idle pool if present
    const idleIdx = this.idleSessions.indexOf(pid);
    if (idleIdx !== -1) this.idleSessions.splice(idleIdx, 1);
    return { killed: true };
  }

  viewSession(pid: number): { output: string; exists: boolean } {
    const session = this.sessions.get(pid);
    if (!session) return { output: "", exists: false };

    const rawOutput = session.outputBuffer.slice(session.lastReadIndex);
    session.lastReadIndex = session.outputBuffer.length;

    const cleaned = stripTerminalEscapes(stripSentinelNoise(rawOutput));

    return {
      output: cleaned.trim() || "[No new output]",
      exists: true,
    };
  }
}
