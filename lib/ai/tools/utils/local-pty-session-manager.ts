/**
 * Manages persistent PTY sessions for local (ConvexSandbox) environments
 * using tmux as the cross-platform PTY backend.
 *
 * tmux provides consistent behavior across macOS, Linux, and Windows (via
 * Docker/WSL). Commands are sent via base64 encoding to avoid shell escaping
 * issues. Sentinel-based completion detection matches the E2B PtySessionManager
 * pattern.
 *
 * Architecture:
 *  - Each session is a detached tmux session on the local machine.
 *  - `exec` sends the command + sentinel, then polls `capture-pane` until the
 *    sentinel appears or timeout. The polling runs as a single `commands.run()`
 *    call on the local machine (no per-poll Convex round-trips).
 *  - `wait` polls from Node.js (separate `commands.run()` calls) since it needs
 *    to stream deltas to the frontend between polls.
 *  - `send` uses `tmux send-keys` for special keys and base64 `paste-buffer`
 *    for raw text.
 *  - `kill` uses `tmux kill-session`.
 */

import { randomUUID } from "crypto";
import type { ConvexSandbox } from "./convex-sandbox";
import { stripSentinelNoise } from "./pty-output";
import { TMUX_SPECIAL_KEYS } from "./pty-keys";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for internal tmux management commands (not user commands). */
const TMUX_CMD_TIMEOUT_MS = 10_000;

/** Interval between polls when using Node.js-level polling (wait action). */
const POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LocalPtySession {
  tmuxSessionName: string;
  /** Full captured output from the last capture-pane call. */
  lastCapturedOutput: string;
}

// ---------------------------------------------------------------------------
// Error class for tmux availability
// ---------------------------------------------------------------------------

export class TmuxNotAvailableError extends Error {
  constructor(
    message = "tmux is not installed and could not be auto-installed. " +
      "Install it manually to enable full terminal features (wait, send, kill):\n" +
      "  macOS:   brew install tmux\n" +
      "  Linux:   sudo apt-get install tmux  (or: dnf, apk, yum)\n" +
      "  Windows: available via WSL or Docker (tmux is not native to Windows)",
  ) {
    super(message);
    this.name = "TmuxNotAvailableError";
  }
}

// ---------------------------------------------------------------------------
// LocalPtySessionManager
// ---------------------------------------------------------------------------

export class LocalPtySessionManager {
  /** Sessions keyed by user-facing session name (e.g. "default", "server"). */
  private sessions: Map<string, LocalPtySession> = new Map();
  private streamCallbacks: Map<string, (data: string) => void> = new Map();
  /** Sentinel from an exec that timed out -- `wait` uses this for early completion. */
  private pendingSentinels: Map<string, string> = new Map();

  /** Sessions currently executing a command -- not available for reuse. */
  private busySessions: Set<string> = new Set();

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
  async ensureTmux(sandbox: ConvexSandbox): Promise<void> {
    if (this.tmuxVerified) return;

    // Quick check
    const check = await this.tmuxRun(sandbox, "command -v tmux", {
      displayName: "Checking for tmux",
    });
    if (check.exitCode === 0 && check.stdout.trim()) {
      this.tmuxVerified = true;
      return;
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
      throw new TmuxNotAvailableError();
    }

    // Verify
    const verify = await this.tmuxRun(sandbox, "command -v tmux", {
      displayName: "Verifying tmux installation",
    });
    if (verify.exitCode !== 0 || !verify.stdout.trim()) {
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
  async createSession(
    sandbox: ConvexSandbox,
    sessionId: string,
  ): Promise<void> {
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
    const tmuxName = `hai_${this.chatId}_${sessionId}`;

    // Kill any stale session with the same name (e.g. leftover from a previous run)
    await this.tmuxRun(
      sandbox,
      `tmux kill-session -t ${tmuxName} 2>/dev/null || true`,
    ).catch(() => {
      /* ignore -- session likely doesn't exist */
    });

    // Create a detached tmux session with a generous scrollback
    const result = await this.tmuxRun(
      sandbox,
      `tmux new-session -d -s ${tmuxName} -x 200 -y 50 \\; ` +
        `set-option -t ${tmuxName} history-limit 50000`,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create tmux session: ${result.stderr || result.stdout}`,
      );
    }

    // Let initial shell prompt settle, then clear history so we start clean
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.tmuxRun(sandbox, `tmux clear-history -t ${tmuxName}`);
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
   * Acquire a PTY session for an exec call. If a session with the given ID
   * already exists and is idle, reuse it (preserving working directory).
   * Otherwise create a new one.
   */
  async acquireSession(
    sandbox: ConvexSandbox,
    sessionId: string,
  ): Promise<void> {
    // Reuse existing idle session
    if (this.sessions.has(sessionId) && !this.busySessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      // Clear scrollback so previous command output doesn't bleed through
      await this.tmuxRun(
        sandbox,
        `tmux clear-history -t ${session.tmuxSessionName}`,
      ).catch(() => {
        /* session may have died */
      });
      session.lastCapturedOutput = "";
      this.busySessions.add(sessionId);
      return;
    }

    // No existing idle session -- create a new one
    await this.createSession(sandbox, sessionId);
    this.busySessions.add(sessionId);
  }

  /**
   * Return a session to the idle pool after a command completes.
   */
  releaseSession(sessionId: string): void {
    this.busySessions.delete(sessionId);
  }

  // =========================================================================
  // exec
  // =========================================================================

  /**
   * Execute a command in a tmux session with sentinel-based completion
   * detection.
   *
   * Sends the command + sentinel as a single `commands.run()` that includes
   * an inline polling loop. This way the polling runs locally on the user's
   * machine (zero extra Convex round-trips).
   */
  async execInSession(
    sandbox: ConvexSandbox,
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
    const fullCommand = `echo ${startMarker} ; ${command} ; echo ${sentinel}$?`;
    const base64Cmd = Buffer.from(fullCommand).toString("base64");
    const maxIterations = Math.ceil(timeoutSeconds / 0.3);
    const timeoutMarker = `__TMUX_TIMEOUT__`;
    const sn = session.tmuxSessionName;

    // Build the full exec-and-poll script as a single shell command.
    // Steps:
    //   1. Decode base64 command -> load into tmux paste buffer -> paste into session
    //   2. Send Enter to execute
    //   3. Poll `capture-pane` until sentinel appears or iteration limit
    //   4. Output the final captured pane content
    //
    // IMPORTANT: The grep pattern uses `${sentinel}[0-9]` (regex, NOT -F)
    // to require a digit after the sentinel. This prevents matching the
    // echoed command line where the sentinel is followed by literal `$?`
    // instead of an actual exit code digit. This mirrors the E2B
    // PtySessionManager's `sentinelWithDigit` regex.
    const execScript = [
      // Paste the command into the tmux session via base64 (avoids escaping)
      `printf '%s' '${base64Cmd}' | base64 -d | tmux load-buffer -b hai_cmd -`,
      `tmux paste-buffer -t ${sn} -b hai_cmd -d`,
      `tmux send-keys -t ${sn} Enter`,
      // Poll loop (runs locally, no Convex round-trips)
      `i=0`,
      `while [ "$i" -lt ${maxIterations} ]; do ` +
        `sleep 0.3; ` +
        `if tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'; then ` +
        `tmux capture-pane -t ${sn} -e -p -S -; ` +
        `exit 0; ` +
        `fi; ` +
        `i=$((i + 1)); ` +
        `done`,
      // Timeout -- output marker + whatever we have
      `echo '${timeoutMarker}'`,
      `tmux capture-pane -t ${sn} -e -p -S -`,
    ].join(" && ");

    try {
      const result = await sandbox.commands.run(execScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000, // buffer above the poll timeout
        displayName: command,
      });

      const rawOutput = result.stdout;
      const timedOut = rawOutput.includes(timeoutMarker);

      // Stream the output to the frontend
      const streamCb = this.streamCallbacks.get(sessionId);
      if (streamCb) {
        const cleanedForStream = this.cleanOutput(
          rawOutput,
          startMarker,
          sentinel,
        );
        if (cleanedForStream.trim()) {
          streamCb(cleanedForStream);
        }
      }

      if (timedOut) {
        this.pendingSentinels.set(sessionId, sentinel);

        // Extract whatever output we have (after the timeout marker)
        const afterMarker = rawOutput.split(timeoutMarker).pop() || "";
        const cleaned = this.cleanOutput(afterMarker, startMarker, sentinel);

        // Normalize to match capturePaneOutput format for consistent delta calculations
        session.lastCapturedOutput = this.normalizePaneCapture(afterMarker);
        return { output: cleaned, exitCode: null, timedOut: true };
      }

      // Extract exit code from sentinel
      const sentinelRegex = new RegExp(`${sentinel}(\\d+)`, "m");
      const match = rawOutput.match(sentinelRegex);
      const exitCode = match ? parseInt(match[1], 10) : null;

      const cleaned = this.cleanOutput(rawOutput, startMarker, sentinel);
      // Normalize to match capturePaneOutput format for consistent delta calculations
      session.lastCapturedOutput = this.normalizePaneCapture(rawOutput);

      return { output: cleaned, exitCode, timedOut: false };
    } catch (error) {
      // If the commands.run itself fails (network, timeout, etc.)
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
   * Uses Node.js-level polling (separate `commands.run` per poll) so we can
   * stream output deltas to the frontend between polls. If a pending sentinel
   * exists (from a timed-out exec), resolves early when the command finishes.
   */
  async waitForSession(
    sandbox: ConvexSandbox,
    sessionId: string,
    timeoutSeconds: number,
    abortSignal?: AbortSignal,
  ): Promise<{ output: string; timedOut: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { output: "[Error: session not found]", timedOut: false };
    }

    const sentinel = this.pendingSentinels.get(sessionId);
    const sentinelWithDigit = sentinel ? new RegExp(`${sentinel}\\d`) : null;

    const timeoutMs = timeoutSeconds * 1000;
    const startTime = Date.now();
    const baselineLength = session.lastCapturedOutput.length;
    let lastStreamedLength = 0;
    let latestCapture = session.lastCapturedOutput;
    let firstPoll = true;

    while (Date.now() - startTime < timeoutMs) {
      if (abortSignal?.aborted) break;

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const captured = await this.capturePaneOutput(
        sandbox,
        session.tmuxSessionName,
        firstPoll ? `wait (session: ${sessionId})` : undefined,
      );
      firstPoll = false;
      if (!captured) continue;

      latestCapture = captured;

      // Stream delta to frontend
      const newContent =
        captured.length > baselineLength ? captured.slice(baselineLength) : "";
      const streamCb = this.streamCallbacks.get(sessionId);
      if (streamCb && newContent.length > lastStreamedLength) {
        const delta = stripSentinelNoise(newContent.slice(lastStreamedLength));
        if (delta.trim()) streamCb(delta);
        lastStreamedLength = newContent.length;
      }

      // Check for sentinel
      if (sentinelWithDigit && sentinelWithDigit.test(captured)) {
        this.pendingSentinels.delete(sessionId);
        const output = stripSentinelNoise(newContent);
        session.lastCapturedOutput = captured;
        return { output: output.trim() || "[No new output]", timedOut: false };
      }
    }

    // Timed out
    const finalNew =
      latestCapture.length > baselineLength
        ? latestCapture.slice(baselineLength)
        : "";
    const cleaned = stripSentinelNoise(finalNew);
    session.lastCapturedOutput = latestCapture;

    return { output: cleaned.trim() || "[No new output]", timedOut: true };
  }

  // =========================================================================
  // send
  // =========================================================================

  async sendToSession(
    sandbox: ConvexSandbox,
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

    // Check for M- (Alt) or C-S- (Ctrl+Shift) prefixes
    if (
      (input.startsWith("M-") && input.length === 3) ||
      (input.startsWith("C-S-") && input.length === 5)
    ) {
      await this.tmuxRun(sandbox, `tmux send-keys -t ${sn} ${input}`, {
        displayName,
      });
      return { success: true };
    }

    // Raw text -- send via base64 paste-buffer to avoid escaping issues
    const base64Input = Buffer.from(input).toString("base64");
    await this.tmuxRun(
      sandbox,
      `printf '%s' '${base64Input}' | base64 -d | tmux load-buffer -b hai_input - && ` +
        `tmux paste-buffer -t ${sn} -b hai_input -d`,
      { displayName },
    );

    return { success: true };
  }

  // =========================================================================
  // kill
  // =========================================================================

  async killSession(
    sandbox: ConvexSandbox,
    sessionId: string,
  ): Promise<{ killed: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { killed: false };

    try {
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
    sandbox: ConvexSandbox,
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
    sandbox: ConvexSandbox,
    cmd: string,
    opts?: { timeout?: number; displayName?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return sandbox.commands.run(cmd, {
      timeoutMs: opts?.timeout || TMUX_CMD_TIMEOUT_MS,
      displayName: opts?.displayName ?? "",
    });
  }

  /**
   * Normalize raw tmux capture-pane output to match the format returned by
   * `capturePaneOutput`. This ensures delta calculations (slice by length)
   * are consistent between exec-stored snapshots and later live captures.
   */
  private normalizePaneCapture(raw: string): string {
    return raw
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  }

  /** Capture the full scrollback of a tmux pane. */
  private async capturePaneOutput(
    sandbox: ConvexSandbox,
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

  /**
   * Clean raw captured output for the AI model:
   *  - Remove sentinel lines
   *  - Remove the echoed command
   *  - Strip terminal escape sequences
   *  - Remove shell prompts (bash, zsh, kali multi-line, etc.)
   */
  private cleanOutput(
    content: string,
    startMarker: string,
    sentinel: string,
  ): string {
    const lines = content.split("\n");

    // Find the LAST start-marker line and the LAST sentinel line.
    // We want the last occurrence because the first match is typically the
    // echoed command (e.g. "echo __START_xxx__ ; cmd ; echo __DONE_xxx__$?")
    // while the last match is the actual marker output on its own line.
    let startIdx = -1;
    let endIdx = -1;
    const sentinelWithDigitRegex = new RegExp(`${sentinel}\\d`);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(startMarker)) {
        startIdx = i;
      }
      if (lines[i].match(sentinelWithDigitRegex)) {
        endIdx = i;
      }
    }

    let extracted: string;

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Happy path: extract content between start marker and sentinel (exclusive)
      extracted = lines.slice(startIdx + 1, endIdx).join("\n");
    } else if (startIdx !== -1) {
      // Start marker found but no sentinel yet (timeout case) — take everything after the start marker
      extracted = lines.slice(startIdx + 1).join("\n");
    } else if (endIdx !== -1) {
      // No start marker found but sentinel exists — take everything before the sentinel
      extracted = lines.slice(0, endIdx).join("\n");
    } else {
      // Neither marker found — return content as-is (shouldn't normally happen)
      extracted = content;
    }

    // Collapse multiple blank lines
    const cleaned = extracted.replace(/\n{3,}/g, "\n\n");

    return cleaned.trim();
  }
}
