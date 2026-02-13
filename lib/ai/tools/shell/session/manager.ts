/**
 * Manages persistent PTY sessions using tmux as the cross-platform PTY backend.
 *
 * Works with any sandbox that implements `TmuxSandbox` — both local
 * (TmuxSandbox) and cloud (E2B Sandbox) environments. tmux provides
 * consistent behavior across macOS, Linux, and Windows (via Docker/WSL).
 */

import { randomUUID } from "crypto";
import { stripSentinelNoise } from "../utils/pty-output";
import { TMUX_SPECIAL_KEYS } from "../utils/pty-keys";
import { cleanOutput, normalizePaneCapture } from "./output";
import type { LocalPtySession, TmuxSandbox } from "./types";
import { TmuxNotAvailableError } from "./types";

const TMUX_CMD_TIMEOUT_MS = 10_000;

function sanitizeForShell(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

// ---------------------------------------------------------------------------
// LocalPtySessionManager
// ---------------------------------------------------------------------------

export class LocalPtySessionManager {
  /** Sessions keyed by auto-generated session ID (e.g. "s0", "s1"). */
  private sessions: Map<string, LocalPtySession> = new Map();
  private streamCallbacks: Map<string, (data: string) => void> = new Map();
  /** Sentinel from an exec that timed out -- `wait` uses this for early completion. */
  private pendingSentinels: Map<string, string> = new Map();

  /** Sessions currently executing a command -- not available for reuse. */
  private busySessions: Set<string> = new Set();
  /** Pool of idle sessions available for reuse (LIFO for locality). */
  private idleSessions: string[] = [];
  /** Auto-incrementing counter for generating unique session IDs. */
  private nextSessionId = 0;

  /** Unique ID for this manager instance, used to scope tmux sessions per chat. */
  private readonly chatId: string;

  private tmuxVerified = false;
  private motdSuppressed = false;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  // =========================================================================
  // Stream callback management
  // =========================================================================

  setStreamCallback(sessionId: string, cb: (data: string) => void): void {
    this.streamCallbacks.set(sessionId, cb);
  }

  clearStreamCallback(sessionId: string): void {
    this.streamCallbacks.delete(sessionId);
  }

  // =========================================================================
  // tmux availability
  // =========================================================================

  /**
   * Check if tmux is available on the target machine. If not, attempt to
   * install it using the first available package manager. Throws
   * `TmuxNotAvailableError` if tmux cannot be made available.
   */
  async ensureTmux(sandbox: TmuxSandbox): Promise<void> {
    if (this.tmuxVerified) return;

    // Quick check — try multiple methods (PATH may be minimal in some sandboxes)
    // 1. command -v (POSIX) 2. /usr/bin/tmux (common apt path) 3. which
    // On sandbox wake from pause, first command can return empty stdout; retry once.
    const runCheck = async () => {
      const r = await this.tmuxRun(
        sandbox,
        "command -v tmux 2>/dev/null || test -x /usr/bin/tmux && echo /usr/bin/tmux || which tmux 2>/dev/null || true",
        { displayName: "Checking for tmux" },
      );
      return r.stdout.trim().split("\n")[0] || "";
    };

    let tmuxPath = await runCheck();
    if (!tmuxPath) {
      // Empty stdout often happens when sandbox is waking from pause — try direct path first
      const directCheck = await this.tmuxRun(sandbox, "/usr/bin/tmux -V 2>&1", {
        displayName: "",
      });
      if (directCheck.exitCode === 0) {
        this.tmuxVerified = true;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
      tmuxPath = await runCheck();
    }

    if (tmuxPath) {
      // Verify tmux actually runs (catches broken installs)
      const verCheck = await this.tmuxRun(sandbox, `${tmuxPath} -V 2>&1`, {
        displayName: "",
      });
      if (verCheck.exitCode === 0) {
        this.tmuxVerified = true;
        return;
      }
    }

    // Attempt installation via the first available package manager
    const installResult = await sandbox.commands.run(
      "(" +
        "command -v apt-get >/dev/null 2>&1 && apt-get update -qq && apt-get install -y -qq tmux || " +
        "command -v apk >/dev/null 2>&1 && apk add --no-cache tmux || " +
        "command -v yum >/dev/null 2>&1 && yum install -y -q tmux || " +
        "command -v dnf >/dev/null 2>&1 && dnf install -y -q tmux || " +
        "command -v brew >/dev/null 2>&1 && brew install tmux || " +
        "(echo TMUX_INSTALL_FAILED; echo 'tmux installation failed — no supported package manager found (apt-get, apk, yum, dnf, brew). Install tmux manually.' >&2; exit 1)" +
        ")",
      {
        timeoutMs: 120_000,
        displayName: "Installing tmux (required for terminal sessions)",
      },
    );

    if (installResult.stdout.includes("TMUX_INSTALL_FAILED")) {
      console.error(
        "[tmux] Install failed: no supported package manager",
        installResult.stderr,
      );
      throw new TmuxNotAvailableError();
    }

    // Verify (same multi-method check as above)
    const verify = await this.tmuxRun(
      sandbox,
      "command -v tmux 2>/dev/null || test -x /usr/bin/tmux && echo /usr/bin/tmux || which tmux 2>/dev/null || true",
      {
        displayName: "Verifying tmux installation",
      },
    );
    const verifyPath = verify.stdout.trim();
    if (!verifyPath) {
      console.error("[tmux] Verify failed after install", {
        exitCode: verify.exitCode,
        stderr: verify.stderr,
      });
      throw new TmuxNotAvailableError();
    }

    const verCheck = await this.tmuxRun(sandbox, `${verifyPath} -V 2>&1`, {
      displayName: "",
    });
    if (verCheck.exitCode !== 0) {
      console.error("[tmux] tmux -V failed after install", verCheck.exitCode);
      throw new TmuxNotAvailableError();
    }
    this.tmuxVerified = true;
  }

  // =========================================================================
  // Session lifecycle
  // =========================================================================

  /**
   * Create a new tmux session for the given session ID.
   * The tmux session name is scoped by chatId to avoid collisions across chats.
   */
  async createSession(sandbox: TmuxSandbox, sessionId: string): Promise<void> {
    await this.ensureTmux(sandbox);

    // Suppress MOTD on first session creation (matches E2B PtySessionManager)
    if (!this.motdSuppressed) {
      await sandbox.commands
        .run(
          "touch ~/.hushlogin 2>/dev/null; touch /root/.hushlogin 2>/dev/null; touch /home/user/.hushlogin 2>/dev/null || true",
          {
            timeoutMs: 5000,
            displayName: "",
          },
        )
        .catch(() => {
          /* non-critical */
        });
      this.motdSuppressed = true;
    }

    // Deterministic tmux name scoped by chatId + sessionId.
    // Sanitize to prevent shell injection via crafted session names.
    const tmuxName = `hai_${sanitizeForShell(this.chatId)}_${sanitizeForShell(sessionId)}`;

    // Kill any stale session with the same name (e.g. leftover from a previous run)
    await this.tmuxRun(
      sandbox,
      `tmux kill-session -t ${tmuxName} 2>/dev/null || true`,
    ).catch(() => {
      /* ignore -- session likely doesn't exist */
    });

    // Create a detached tmux session with a generous scrollback.
    const result = await this.tmuxRun(
      sandbox,
      `tmux new-session -d -s ${tmuxName} -x 200 -y 50 \\; ` +
        `set-option -t ${tmuxName} history-limit 50000`,
    );

    if (result.exitCode !== 0) {
      const errMsg = result.stderr || result.stdout;

      // Safety net: if the session already exists (e.g. race condition we
      // didn't fully prevent), verify it's alive and reuse it instead of
      // throwing a cryptic error.
      if (errMsg.includes("duplicate session")) {
        const check = await this.tmuxRun(
          sandbox,
          `tmux has-session -t ${tmuxName} 2>/dev/null && echo ALIVE`,
        ).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));

        if (check.stdout.includes("ALIVE")) {
          // Session exists and is alive -- reuse it
          this.sessions.set(sessionId, {
            tmuxSessionName: tmuxName,
            lastCapturedOutput: "",
          });
          return;
        }
      }

      console.error("[tmux] new-session failed", { tmuxName, err: errMsg });
      throw new Error(`Failed to create tmux session: ${errMsg}`);
    }

    // Let initial shell prompt settle, then clear history so we start clean
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.tmuxRun(sandbox, `tmux clear-history -t ${tmuxName}`);

    // Disable history expansion to prevent `!` inside double-quoted strings
    // from triggering zsh's bang-hist (causes `dquote>` / corrupted output).
    // `set +H` works in both bash and zsh.
    await this.tmuxRun(
      sandbox,
      `tmux send-keys -t ${tmuxName} 'set +H 2>/dev/null || true' Enter`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Also send a clear to reset the visible pane (removes any lingering prompt)
    await this.tmuxRun(sandbox, `tmux send-keys -t ${tmuxName} C-l`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.tmuxRun(sandbox, `tmux clear-history -t ${tmuxName}`);

    this.sessions.set(sessionId, {
      tmuxSessionName: tmuxName,
      lastCapturedOutput: "",
    });
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Try to attach to an existing tmux session created in a previous request.
   * Session managers are recreated per request, but tmux sessions persist in the
   * sandbox. This reconnects our in-memory map to existing tmux sessions.
   *
   * @returns true if the session is now in our map (was present or we attached)
   */
  async ensureSessionAttached(
    sandbox: TmuxSandbox,
    sessionId: string,
  ): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;

    const sanitized = sanitizeForShell(sessionId).slice(0, 32);
    if (!sanitized) return false;

    const tmuxName = `hai_${sanitizeForShell(this.chatId)}_${sanitized}`;
    const check = await this.tmuxRun(
      sandbox,
      `tmux has-session -t ${tmuxName} 2>/dev/null && echo ALIVE`,
    ).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));

    if (!check.stdout.includes("ALIVE")) return false;

    // Restore persisted sentinel + baseline from tmux env (survives manager recreation)
    const envResult = await this.tmuxRun(
      sandbox,
      `tmux show-environment -t ${tmuxName} HAI_SENTINEL 2>/dev/null || true; ` +
        `tmux show-environment -t ${tmuxName} HAI_BASELINE 2>/dev/null || true`,
    ).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    const sentinelMatch = envResult.stdout.match(/HAI_SENTINEL=(.*)/);
    const baselineMatch = envResult.stdout.match(/HAI_BASELINE=(\d+)/);

    console.log(
      `[Shell attach] session=${sessionId} envRaw=${JSON.stringify(envResult.stdout.trim())} sentinel=${sentinelMatch ? "found" : "none"} baseline=${baselineMatch?.[1] ?? "none"}`,
    );

    if (sentinelMatch) {
      this.pendingSentinels.set(sessionId, sentinelMatch[1]);
      this.busySessions.add(sessionId);
    }

    const captured = await this.capturePaneOutput(
      sandbox,
      tmuxName,
      `attach session "${sessionId}"`,
    );

    // Use stored baseline length so output accumulated since the timeout
    // isn't silently consumed as "already seen"
    const storedBaseline = baselineMatch
      ? parseInt(baselineMatch[1], 10)
      : null;
    const baseline =
      storedBaseline !== null && captured
        ? captured.slice(0, Math.min(storedBaseline, captured.length))
        : captured || "";

    this.sessions.set(sessionId, {
      tmuxSessionName: tmuxName,
      lastCapturedOutput: baseline,
    });
    return true;
  }

  /**
   * Acquire a PTY session for an exec call.
   *
   * When preferredSessionId is provided:
   * - If that session exists and is idle, reuse it.
   * - If it exists and is busy, create a new one with a numeric suffix (e.g. server_1).
   * - If it does not exist, create it with that name.
   *
   * When preferredSessionId is omitted:
   * - Reuse an idle session from the pool (LIFO), or create a new auto-named one (s0, s1, ...).
   *
   * Mirrors E2B's `PtySessionManager.acquireSession` pattern.
   */
  async acquireSession(
    sandbox: TmuxSandbox,
    preferredSessionId?: string,
  ): Promise<string> {
    const sanitizedPreferred = preferredSessionId
      ? sanitizeForShell(preferredSessionId).slice(0, 32) || undefined
      : undefined;

    if (sanitizedPreferred) {
      // Agent requested a specific session name — try to use or create it
      if (this.sessions.has(sanitizedPreferred)) {
        const session = this.sessions.get(sanitizedPreferred)!;
        if (!this.busySessions.has(sanitizedPreferred)) {
          // Idle — reuse it
          this.idleSessions = this.idleSessions.filter(
            (s) => s !== sanitizedPreferred,
          );
          try {
            await this.tmuxRun(
              sandbox,
              `tmux clear-history -t ${session.tmuxSessionName}`,
            );
          } catch {
            this.sessions.delete(sanitizedPreferred);
            // Session died — create fresh with same name
            await this.createSession(sandbox, sanitizedPreferred);
            this.busySessions.add(sanitizedPreferred);
            return sanitizedPreferred;
          }
          session.lastCapturedOutput = "";
          this.busySessions.add(sanitizedPreferred);
          return sanitizedPreferred;
        }
        // Busy — create new with suffix: preferred_1, preferred_2, ...
        let suffix = 1;
        let candidateId = `${sanitizedPreferred}_${suffix}`;
        while (this.sessions.has(candidateId)) {
          suffix++;
          candidateId = `${sanitizedPreferred}_${suffix}`;
        }
        await this.createSession(sandbox, candidateId);
        this.busySessions.add(candidateId);
        return candidateId;
      }
      // Session does not exist — create with preferred name
      await this.createSession(sandbox, sanitizedPreferred);
      this.busySessions.add(sanitizedPreferred);
      return sanitizedPreferred;
    }

    // No preferred name — use idle pool or auto-generate
    while (this.idleSessions.length > 0) {
      const sessionId = this.idleSessions.pop()!;
      if (this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!;
        try {
          await this.tmuxRun(
            sandbox,
            `tmux clear-history -t ${session.tmuxSessionName}`,
          );
        } catch {
          this.sessions.delete(sessionId);
          continue;
        }
        session.lastCapturedOutput = "";
        this.busySessions.add(sessionId);
        return sessionId;
      }
    }

    const sessionId = `s${this.nextSessionId++}`;
    await this.createSession(sandbox, sessionId);
    this.busySessions.add(sessionId);
    return sessionId;
  }

  /**
   * Return a session to the idle pool after a command completes.
   * Should NOT be called for timed-out execs (the session stays busy
   * until `wait` or `kill` finishes).
   */
  releaseSession(sessionId: string): void {
    this.busySessions.delete(sessionId);
    if (this.sessions.has(sessionId)) {
      this.idleSessions.push(sessionId);
    }
  }

  // =========================================================================
  // exec
  // =========================================================================

  /**
   * Execute a command within a tmux session.
   *
   * Two modes:
   * 1. **Streaming mode** (E2B with `supportsStreaming`): Outputs periodic
   *    snapshots that are streamed via `onStdout` for real-time updates.
   * 2. **Batch mode** (local): Single poll loop that outputs once at the end.
   */
  async execInSession(
    sandbox: TmuxSandbox,
    sessionId: string,
    command: string,
    timeoutSeconds: number,
    abortSignal?: AbortSignal,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        output: "[Error: session not found]",
        exitCode: null,
        timedOut: false,
      };
    }

    const uid = randomUUID().replace(/-/g, "");
    const startMarker = `__START_${uid}__`;
    const sentinel = `__DONE_${uid}__`;
    // Use newlines instead of `;` to separate the markers from the user command.
    const fullCommand = `echo ${startMarker}\n${command}\necho ${sentinel}$?`;
    const base64Cmd = Buffer.from(fullCommand).toString("base64");
    const timeoutMarker = `__TMUX_TIMEOUT__`;
    const sn = session.tmuxSessionName;

    // Use streaming mode for sandboxes that support it (E2B)
    if (sandbox.supportsStreaming) {
      // Streaming uses 0.5s sleep intervals
      const maxIterations = Math.ceil(timeoutSeconds / 0.5);
      return this.execInSessionStreaming(
        sandbox,
        session,
        sessionId,
        command,
        base64Cmd,
        sn,
        startMarker,
        sentinel,
        timeoutMarker,
        maxIterations,
        timeoutSeconds,
      );
    }

    // Batch mode for local: single poll loop, output at the end
    // Batch uses 0.3s sleep intervals
    const maxIterations = Math.ceil(timeoutSeconds / 0.3);
    return this.execInSessionBatch(
      sandbox,
      session,
      sessionId,
      command,
      base64Cmd,
      sn,
      startMarker,
      sentinel,
      timeoutMarker,
      maxIterations,
      timeoutSeconds,
    );
  }

  /**
   * Streaming exec: outputs periodic snapshots for real-time updates.
   * Used by E2B where `onStdout` callbacks provide real-time streaming.
   */
  private async execInSessionStreaming(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    command: string,
    base64Cmd: string,
    sn: string,
    startMarker: string,
    sentinel: string,
    timeoutMarker: string,
    maxIterations: number,
    timeoutSeconds: number,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    // Markers for parsing streaming snapshots
    const snapStart = `__SNAP_S_${randomUUID().replace(/-/g, "")}__`;
    const snapEnd = `__SNAP_E_${randomUUID().replace(/-/g, "")}__`;

    // Streaming script: outputs periodic snapshots wrapped in markers
    const execScript = [
      // Paste the command into the tmux session via base64
      `printf '%s' '${base64Cmd}' | base64 -d | tmux load-buffer -b hai_cmd -`,
      `tmux paste-buffer -t ${sn} -b hai_cmd -d`,
      `tmux send-keys -t ${sn} Enter`,
      // Poll loop: detect completion via sentinel
      `i=0`,
      `while [ "$i" -lt ${maxIterations} ]; do ` +
        `sleep 0.5; ` +
        `echo '${snapStart}'; ` +
        `tmux capture-pane -t ${sn} -e -p -S -; ` +
        `echo '${snapEnd}'; ` +
        `if tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'; then ` +
        `exit 0; ` +
        `fi; ` +
        `i=$((i + 1)); ` +
        `done`,
      // Timeout — final snapshot
      `echo '${timeoutMarker}'`,
      `echo '${snapStart}'`,
      `tmux capture-pane -t ${sn} -e -p -S -`,
      `echo '${snapEnd}'`,
    ].join(" && ");

    // Track state for streaming delta computation
    let lastStreamedContent = "";
    let latestSnapshot = "";
    const streamCb = this.streamCallbacks.get(sessionId);
    let pendingBuffer = "";

    // onStdout handler: parse snapshots and stream deltas
    const onStdout = (data: string) => {
      pendingBuffer += data;

      // Extract complete snapshots from the buffer
      while (true) {
        const startIdx = pendingBuffer.indexOf(snapStart);
        const endIdx = pendingBuffer.indexOf(snapEnd);

        if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
          break;
        }

        // Extract snapshot content
        const snapshotContent = pendingBuffer.slice(
          startIdx + snapStart.length,
          endIdx,
        );
        latestSnapshot = normalizePaneCapture(snapshotContent);

        // Compute and stream delta
        if (streamCb) {
          const cleaned = cleanOutput(
            latestSnapshot,
            startMarker,
            sentinel,
            command,
          );
          if (cleaned.length > lastStreamedContent.length) {
            const delta = cleaned.slice(lastStreamedContent.length);
            if (delta.trim()) {
              streamCb(delta);
            }
            lastStreamedContent = cleaned;
          }
        }

        // Remove processed snapshot from buffer
        pendingBuffer = pendingBuffer.slice(endIdx + snapEnd.length);
      }
    };

    try {
      const result = await sandbox.commands.run(execScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        onStdout,
        displayName: command,
      });

      const rawOutput = result.stdout;
      const timedOut = rawOutput.includes(timeoutMarker);

      // Use the latest snapshot for final processing
      const finalCapture = latestSnapshot || normalizePaneCapture(rawOutput);
      session.lastCapturedOutput = finalCapture;

      if (timedOut) {
        this.pendingSentinels.set(sessionId, sentinel);
        // Persist to tmux env so a new manager on the next request can restore it
        await this.tmuxRun(
          sandbox,
          `tmux set-environment -t ${sn} HAI_SENTINEL '${sentinel}' && tmux set-environment -t ${sn} HAI_BASELINE '${session.lastCapturedOutput.length}'`,
        ).catch(() => {});
        const cleaned = cleanOutput(
          finalCapture,
          startMarker,
          sentinel,
          command,
        );
        return { output: cleaned, exitCode: null, timedOut: true };
      }

      // Extract exit code from sentinel
      const sentinelRegex = new RegExp(`${sentinel}(\\d+)`, "m");
      const match = finalCapture.match(sentinelRegex);
      const exitCode = match ? parseInt(match[1], 10) : null;

      const cleaned = cleanOutput(finalCapture, startMarker, sentinel, command);
      return { output: cleaned, exitCode, timedOut: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: `[Shell execution error: ${message}]`,
        exitCode: null,
        timedOut: false,
      };
    }
  }

  /**
   * Batch exec: single poll loop, output at the end.
   * Used by local sandboxes where streaming isn't needed/supported.
   */
  private async execInSessionBatch(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    command: string,
    base64Cmd: string,
    sn: string,
    startMarker: string,
    sentinel: string,
    timeoutMarker: string,
    maxIterations: number,
    timeoutSeconds: number,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    // Build the full exec-and-poll script as a single shell command.
    const execScript = [
      // Paste the command into the tmux session via base64
      `printf '%s' '${base64Cmd}' | base64 -d | tmux load-buffer -b hai_cmd -`,
      `tmux paste-buffer -t ${sn} -b hai_cmd -d`,
      `tmux send-keys -t ${sn} Enter`,
      // Poll loop: detect completion via sentinel
      `i=0`,
      `while [ "$i" -lt ${maxIterations} ]; do ` +
        `sleep 0.3; ` +
        `if tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'; then ` +
        `tmux capture-pane -t ${sn} -e -p -S -; ` +
        `exit 0; ` +
        `fi; ` +
        `i=$((i + 1)); ` +
        `done`,
      // Timeout — output marker + whatever we have
      `echo '${timeoutMarker}'`,
      `tmux capture-pane -t ${sn} -e -p -S -`,
    ].join(" && ");

    try {
      const result = await sandbox.commands.run(execScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        displayName: command,
      });

      const rawOutput = result.stdout;
      const timedOut = rawOutput.includes(timeoutMarker);

      // Stream cleaned output to the frontend
      const streamCb = this.streamCallbacks.get(sessionId);
      if (streamCb) {
        const cleanedForStream = cleanOutput(
          rawOutput,
          startMarker,
          sentinel,
          command,
        );
        if (cleanedForStream.trim()) {
          streamCb(cleanedForStream);
        }
      }

      if (timedOut) {
        this.pendingSentinels.set(sessionId, sentinel);
        const afterMarker = rawOutput.split(timeoutMarker).pop() || "";
        const cleaned = cleanOutput(
          afterMarker,
          startMarker,
          sentinel,
          command,
        );
        session.lastCapturedOutput = normalizePaneCapture(afterMarker);
        // Persist to tmux env so a new manager on the next request can restore it
        await this.tmuxRun(
          sandbox,
          `tmux set-environment -t ${sn} HAI_SENTINEL '${sentinel}' && tmux set-environment -t ${sn} HAI_BASELINE '${session.lastCapturedOutput.length}'`,
        ).catch(() => {});
        return { output: cleaned, exitCode: null, timedOut: true };
      }

      // Extract exit code from sentinel
      const sentinelRegex = new RegExp(`${sentinel}(\\d+)`, "m");
      const match = rawOutput.match(sentinelRegex);
      const exitCode = match ? parseInt(match[1], 10) : null;

      const cleaned = cleanOutput(rawOutput, startMarker, sentinel, command);
      session.lastCapturedOutput = normalizePaneCapture(rawOutput);

      return { output: cleaned, exitCode, timedOut: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        output: `[Shell execution error: ${message}]`,
        exitCode: null,
        timedOut: false,
      };
    }
  }

  // =========================================================================
  // wait
  // =========================================================================

  /**
   * Wait for additional output from an already-running session.
   *
   * Two modes (streaming vs batch) similar to execInSession.
   * Two cases within each mode:
   * - **Sentinel case**: Poll for sentinel from a timed-out exec
   * - **No-sentinel case**: Poll for shell idle detection
   */
  async waitForSession(
    sandbox: TmuxSandbox,
    sessionId: string,
    timeoutSeconds: number,
    _abortSignal?: AbortSignal,
  ): Promise<{ output: string; timedOut: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { output: "[Error: session not found]", timedOut: false };
    }

    const sentinel = this.pendingSentinels.get(sessionId) || null;
    const sn = session.tmuxSessionName;

    console.log(
      `[Shell wait] session=${sessionId} tmux=${sn} sentinel=${sentinel ? "yes" : "no"} baseline=${session.lastCapturedOutput.length} streaming=${!!sandbox.supportsStreaming}`,
    );

    // Use streaming mode for E2B
    if (sandbox.supportsStreaming) {
      return this.waitForSessionStreaming(
        sandbox,
        session,
        sessionId,
        sn,
        sentinel,
        timeoutSeconds,
      );
    }

    // Batch mode for local
    return this.waitForSessionBatch(
      sandbox,
      session,
      sessionId,
      sn,
      sentinel,
      timeoutSeconds,
    );
  }

  /**
   * Streaming wait: outputs periodic snapshots for real-time updates.
   */
  private async waitForSessionStreaming(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    sn: string,
    sentinel: string | null,
    timeoutSeconds: number,
  ): Promise<{ output: string; timedOut: boolean }> {
    const uid = randomUUID().replace(/-/g, "");
    const snapStart = `__SNAP_S_${uid}__`;
    const snapEnd = `__SNAP_E_${uid}__`;
    const timeoutMarker = `__WAIT_TIMEOUT_${uid}__`;
    const completionMarker = `__WAIT_COMPLETE_${uid}__`;

    const pollIntervalSec = 0.5;
    const maxIter = Math.ceil(timeoutSeconds / pollIntervalSec);
    const shellNames = "bash|zsh|sh|fish|dash|ksh|csh|tcsh";

    let waitScript: string;
    if (sentinel) {
      waitScript = [
        `i=0`,
        `while [ "$i" -lt ${maxIter} ]; do ` +
          `sleep ${pollIntervalSec}; ` +
          `echo '${snapStart}'; ` +
          `tmux capture-pane -t ${sn} -e -p -S -; ` +
          `echo '${snapEnd}'; ` +
          `if tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'; then ` +
          `echo '${completionMarker}'; ` +
          `exit 0; ` +
          `fi; ` +
          `i=$((i + 1)); ` +
          `done`,
        `echo '${timeoutMarker}'`,
      ].join(" && ");
    } else {
      waitScript = [
        `sleep 0.3`,
        `i=0`,
        `while [ "$i" -lt ${maxIter} ]; do ` +
          `sleep ${pollIntervalSec}; ` +
          `echo '${snapStart}'; ` +
          `tmux capture-pane -t ${sn} -e -p -S -; ` +
          `echo '${snapEnd}'; ` +
          `PCMD=$(tmux display-message -t ${sn} -p "#{pane_current_command}" 2>/dev/null); ` +
          `if echo "$PCMD" | grep -qE "^(${shellNames})$"; then ` +
          `PANE_PID=$(tmux display-message -t ${sn} -p "#{pane_pid}" 2>/dev/null); ` +
          `if ! pgrep -P "$PANE_PID" >/dev/null 2>&1; then ` +
          `echo '${completionMarker}'; ` +
          `exit 0; ` +
          `fi; ` +
          `fi; ` +
          `i=$((i + 1)); ` +
          `done`,
        `echo '${timeoutMarker}'`,
      ].join(" && ");
    }

    // Track state for streaming
    let lastStreamedLength = 0;
    let latestSnapshot = "";
    const streamCb = this.streamCallbacks.get(sessionId);
    let pendingBuffer = "";
    const baselineLength = session.lastCapturedOutput.length;

    const onStdout = (data: string) => {
      pendingBuffer += data;

      // Extract complete snapshots
      while (true) {
        const startIdx = pendingBuffer.indexOf(snapStart);
        const endIdx = pendingBuffer.indexOf(snapEnd);

        if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
          break;
        }

        const snapshotContent = pendingBuffer.slice(
          startIdx + snapStart.length,
          endIdx,
        );
        latestSnapshot = normalizePaneCapture(snapshotContent);

        // Compute delta from baseline and stream
        if (streamCb) {
          const newContent =
            latestSnapshot.length > baselineLength
              ? latestSnapshot.slice(baselineLength)
              : "";
          const cleaned = stripSentinelNoise(newContent);
          if (cleaned.length > lastStreamedLength) {
            const delta = cleaned.slice(lastStreamedLength);
            if (delta.trim()) {
              streamCb(delta);
            }
            lastStreamedLength = cleaned.length;
          }
        }

        pendingBuffer = pendingBuffer.slice(endIdx + snapEnd.length);
      }
    };

    try {
      const result = await sandbox.commands.run(waitScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        onStdout,
        displayName: `wait (session: ${sessionId})`,
      });

      const rawOutput = result.stdout;
      const timedOut = rawOutput.includes(timeoutMarker);

      // Use latest snapshot for final result
      const captured = latestSnapshot || session.lastCapturedOutput;
      const newContent =
        captured.length > baselineLength ? captured.slice(baselineLength) : "";

      session.lastCapturedOutput = captured;
      if (sentinel && !timedOut) {
        this.pendingSentinels.delete(sessionId);
        await this.tmuxRun(
          sandbox,
          `tmux set-environment -t ${sn} -u HAI_SENTINEL 2>/dev/null; tmux set-environment -t ${sn} -u HAI_BASELINE 2>/dev/null`,
        ).catch(() => {});
      }

      const cleaned = stripSentinelNoise(newContent);
      return { output: cleaned.trim() || "[No new output]", timedOut };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = (error as any)?.stderr || "";
      console.error(
        `[Shell wait streaming] error session=${sessionId} tmux=${sn} sentinel=${sentinel ? "yes" : "no"} msg=${message}${stderr ? ` stderr=${stderr}` : ""}`,
      );
      return { output: `[Shell wait error: ${message}]`, timedOut: false };
    }
  }

  /**
   * Batch wait: single script, output at the end.
   */
  private async waitForSessionBatch(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    sn: string,
    sentinel: string | null,
    timeoutSeconds: number,
  ): Promise<{ output: string; timedOut: boolean }> {
    // Sentinel case — poll until sentinel appears (from timed-out exec)
    if (sentinel) {
      const maxIterations = Math.ceil(timeoutSeconds / 0.3);
      const uid = randomUUID().replace(/-/g, "");
      const timeoutMarker = `__WAIT_TIMEOUT_${uid}__`;

      const waitScript = [
        `i=0`,
        `while [ "$i" -lt ${maxIterations} ]; do ` +
          `sleep 0.3; ` +
          `if tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'; then ` +
          `tmux capture-pane -t ${sn} -e -p -S -; ` +
          `exit 0; ` +
          `fi; ` +
          `i=$((i + 1)); ` +
          `done`,
        `echo '${timeoutMarker}'`,
        `tmux capture-pane -t ${sn} -e -p -S -`,
      ].join(" && ");

      try {
        const result = await sandbox.commands.run(waitScript, {
          timeoutMs: (timeoutSeconds + 10) * 1000,
          displayName: `wait (session: ${sessionId})`,
        });

        const rawOutput = result.stdout;
        const timedOut = rawOutput.includes(timeoutMarker);

        const captureRaw = timedOut
          ? rawOutput.split(timeoutMarker).pop() || ""
          : rawOutput;
        const captured = normalizePaneCapture(captureRaw);

        const baselineLength = session.lastCapturedOutput.length;
        const newContent =
          captured.length > baselineLength
            ? captured.slice(baselineLength)
            : "";

        const streamCb = this.streamCallbacks.get(sessionId);
        if (streamCb) {
          const cleanedForStream = stripSentinelNoise(newContent);
          if (cleanedForStream.trim()) streamCb(cleanedForStream);
        }

        session.lastCapturedOutput = captured;
        if (!timedOut) {
          this.pendingSentinels.delete(sessionId);
          await this.tmuxRun(
            sandbox,
            `tmux set-environment -t ${sn} -u HAI_SENTINEL 2>/dev/null; tmux set-environment -t ${sn} -u HAI_BASELINE 2>/dev/null`,
          ).catch(() => {});
        }

        const cleaned = stripSentinelNoise(newContent);
        return { output: cleaned.trim() || "[No new output]", timedOut };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderr = (error as any)?.stderr || "";
        console.error(
          `[Shell wait batch-sentinel] error session=${sessionId} tmux=${sn} msg=${message}${stderr ? ` stderr=${stderr}` : ""}`,
        );
        return { output: `[Shell wait error: ${message}]`, timedOut: false };
      }
    }

    // No sentinel — poll for shell idle
    const pollIntervalSec = 0.5;
    const maxIter = Math.ceil(timeoutSeconds / pollIntervalSec);
    const waitUid = randomUUID().replace(/-/g, "");
    const completionMarker = `__WAIT_COMPLETE_${waitUid}__`;
    const waitTimeoutMarker = `__WAIT_TIMEOUT_${waitUid}__`;
    const shellNames = "bash|zsh|sh|fish|dash|ksh|csh|tcsh";

    const waitScript = [
      `sleep 0.3`,
      `i=0`,
      `while [ "$i" -lt ${maxIter} ]; do ` +
        `sleep ${pollIntervalSec}; ` +
        `PCMD=$(tmux display-message -t ${sn} -p "#{pane_current_command}" 2>/dev/null); ` +
        `if echo "$PCMD" | grep -qE "^(${shellNames})$"; then ` +
        `PANE_PID=$(tmux display-message -t ${sn} -p "#{pane_pid}" 2>/dev/null); ` +
        `if ! pgrep -P "$PANE_PID" >/dev/null 2>&1; then ` +
        `echo "${completionMarker}"; ` +
        `tmux capture-pane -t ${sn} -e -p -S -; ` +
        `exit 0; ` +
        `fi; ` +
        `fi; ` +
        `i=$((i + 1)); ` +
        `done`,
      `echo '${waitTimeoutMarker}'`,
      `tmux capture-pane -t ${sn} -e -p -S -`,
    ].join(" && ");

    try {
      const result = await sandbox.commands.run(waitScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        displayName: `wait (session: ${sessionId})`,
      });

      const rawOutput = result.stdout;
      const completed = rawOutput.includes(completionMarker);
      const timedOut = rawOutput.includes(waitTimeoutMarker);

      const captureRaw = completed
        ? rawOutput.split(completionMarker).pop() || ""
        : timedOut
          ? rawOutput.split(waitTimeoutMarker).pop() || ""
          : rawOutput;
      const captured = normalizePaneCapture(captureRaw);

      const baselineLength = session.lastCapturedOutput.length;
      const newContent =
        captured.length > baselineLength ? captured.slice(baselineLength) : "";

      // Stream delta to frontend
      const streamCb = this.streamCallbacks.get(sessionId);
      if (streamCb) {
        const cleanedForStream = stripSentinelNoise(newContent);
        if (cleanedForStream.trim()) streamCb(cleanedForStream);
      }

      session.lastCapturedOutput = captured;

      const cleaned = stripSentinelNoise(newContent);
      return { output: cleaned.trim() || "[No new output]", timedOut };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = (error as any)?.stderr || "";
      console.error(
        `[Shell wait batch-idle] error session=${sessionId} tmux=${sn} msg=${message}${stderr ? ` stderr=${stderr}` : ""}`,
      );
      return { output: `[Shell wait error: ${message}]`, timedOut: false };
    }
  }

  // =========================================================================
  // send
  // =========================================================================

  async sendToSession(
    sandbox: TmuxSandbox,
    sessionId: string,
    input: string,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: "Session not found" };

    const sn = session.tmuxSessionName;

    const displayName = `send-keys: ${input.length > 60 ? input.slice(0, 60) + "..." : input}`;

    // Check if input is a tmux special key name
    if (TMUX_SPECIAL_KEYS.has(input)) {
      await this.tmuxRun(sandbox, `tmux send-keys -t ${sn} ${input}`, {
        displayName,
      });
      return { success: true };
    }

    // Check for M- (Alt) or C-S- (Ctrl+Shift) prefixes.
    // Validate the character is alphanumeric to prevent shell metacharacter injection
    // (e.g. "M-;" would let `;` terminate the shell command).
    if (
      (input.startsWith("M-") &&
        input.length === 3 &&
        /^[a-zA-Z0-9]$/.test(input[2])) ||
      (input.startsWith("C-S-") &&
        input.length === 5 &&
        /^[a-zA-Z0-9]$/.test(input[4]))
    ) {
      await this.tmuxRun(sandbox, `tmux send-keys -t ${sn} ${input}`, {
        displayName,
      });
      return { success: true };
    }

    // Raw text -- send via base64 paste-buffer to avoid escaping issues.
    // Automatically press Enter afterwards unless the input already ends
    // with a newline (prevents consecutive sends from concatenating on the
    // same line).
    const base64Input = Buffer.from(input).toString("base64");
    const needsEnter = !input.endsWith("\n");
    await this.tmuxRun(
      sandbox,
      `printf '%s' '${base64Input}' | base64 -d | tmux load-buffer -b hai_input - && ` +
        `tmux paste-buffer -t ${sn} -b hai_input -d` +
        (needsEnter ? ` && tmux send-keys -t ${sn} Enter` : ""),
      { displayName },
    );

    return { success: true };
  }

  // =========================================================================
  // kill
  // =========================================================================

  async killSession(
    sandbox: TmuxSandbox,
    sessionId: string,
  ): Promise<{ killed: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { killed: false };

    try {
      // Clear persisted exec state before killing
      await this.tmuxRun(
        sandbox,
        `tmux set-environment -t ${session.tmuxSessionName} -u HAI_SENTINEL 2>/dev/null; tmux set-environment -t ${session.tmuxSessionName} -u HAI_BASELINE 2>/dev/null`,
      ).catch(() => {});
      await this.tmuxRun(
        sandbox,
        `tmux kill-session -t ${session.tmuxSessionName}`,
        { displayName: `kill session "${sessionId}"` },
      );
    } catch {
      /* session may already be dead */
    }

    this.sessions.delete(sessionId);
    this.streamCallbacks.delete(sessionId);
    this.pendingSentinels.delete(sessionId);
    this.busySessions.delete(sessionId);
    // Remove from idle pool if present
    const idleIdx = this.idleSessions.indexOf(sessionId);
    if (idleIdx !== -1) this.idleSessions.splice(idleIdx, 1);

    return { killed: true };
  }

  // =========================================================================
  // viewSessionAsync -- async capture for pending output
  // =========================================================================

  /**
   * Capture current pane output and return content accumulated since the
   * last read. Used by the shell tool to flush pending output before a
   * `wait` call.
   */
  async viewSessionAsync(
    sandbox: TmuxSandbox,
    sessionId: string,
  ): Promise<{ output: string; exists: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { output: "", exists: false };

    const captured = await this.capturePaneOutput(
      sandbox,
      session.tmuxSessionName,
    );
    if (!captured) return { output: "[No new output]", exists: true };

    const prevLength = session.lastCapturedOutput.length;
    const newContent =
      captured.length > prevLength ? captured.slice(prevLength) : "";
    session.lastCapturedOutput = captured;

    const cleaned = stripSentinelNoise(newContent);
    return {
      output: cleaned.trim() || "[No new output]",
      exists: true,
    };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Run a tmux management command with a short timeout. */
  private async tmuxRun(
    sandbox: TmuxSandbox,
    cmd: string,
    opts?: { timeout?: number; displayName?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return sandbox.commands.run(cmd, {
      timeoutMs: opts?.timeout || TMUX_CMD_TIMEOUT_MS,
      displayName: opts?.displayName ?? "",
    });
  }

  /** Capture the full scrollback of a tmux pane. */
  private async capturePaneOutput(
    sandbox: TmuxSandbox,
    sessionName: string,
    displayName?: string,
  ): Promise<string> {
    const result = await this.tmuxRun(
      sandbox,
      `tmux capture-pane -t ${sessionName} -e -p -S -`,
      displayName ? { displayName } : undefined,
    );
    if (result.exitCode !== 0) return "";

    // tmux pads lines with trailing spaces to fill terminal width -- strip them
    return result.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  }
}
