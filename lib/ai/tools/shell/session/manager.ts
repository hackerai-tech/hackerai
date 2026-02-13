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
const POLL_INTERVAL_STREAMING = 0.5;
const POLL_INTERVAL_BATCH = 0.3;
const SHELL_NAMES = "bash|zsh|sh|fish|dash|ksh|csh|tcsh";

type ExecResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
};
type WaitResult = { output: string; timedOut: boolean };

function sanitizeForShell(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function genUid(): string {
  return randomUUID().replace(/-/g, "");
}

function execErrorResult(message: string): ExecResult {
  return {
    output: `[Shell execution error: ${message}]`,
    exitCode: null,
    timedOut: false,
  };
}

function waitErrorResult(message: string): WaitResult {
  return { output: `[Shell wait error: ${message}]`, timedOut: false };
}

// ---------------------------------------------------------------------------
// Shell script builders (shared between streaming and batch)
// ---------------------------------------------------------------------------

function buildExecScript(
  sn: string,
  base64Cmd: string,
  sentinel: string,
  maxIterations: number,
  pollInterval: number,
  timeoutMarker: string,
  streaming: boolean,
): string {
  const snapStart = streaming ? `__SNAP_S_${genUid()}__` : "";
  const snapEnd = streaming ? `__SNAP_E_${genUid()}__` : "";
  const captureCmd = `tmux capture-pane -t ${sn} -e -p -S -`;
  const sentinelCheck = `tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'`;

  const pollBody = streaming
    ? `sleep ${pollInterval}; echo '${snapStart}'; ${captureCmd}; echo '${snapEnd}'; if ${sentinelCheck}; then exit 0; fi`
    : `sleep ${pollInterval}; if ${sentinelCheck}; then ${captureCmd}; exit 0; fi`;

  const parts = [
    `printf '%s' '${base64Cmd}' | base64 -d | tmux load-buffer -b hai_cmd -`,
    `tmux paste-buffer -t ${sn} -b hai_cmd -d`,
    `tmux send-keys -t ${sn} Enter`,
    `i=0`,
    `while [ "$i" -lt ${maxIterations} ]; do ${pollBody}; i=$((i + 1)); done`,
    `echo '${timeoutMarker}'`,
    streaming
      ? `echo '${snapStart}'; ${captureCmd}; echo '${snapEnd}'`
      : captureCmd,
  ];
  return parts.join(" && ");
}

function buildSentinelWaitScript(
  sn: string,
  sentinel: string,
  maxIter: number,
  pollInterval: number,
  completionMarker: string,
  timeoutMarker: string,
  streaming: boolean,
): string {
  const captureCmd = `tmux capture-pane -t ${sn} -e -p -S -`;
  const sentinelCheck = `tmux capture-pane -t ${sn} -p -S - 2>/dev/null | grep -q '${sentinel}[0-9]'`;

  const snapStart = streaming ? `__SNAP_S_${genUid()}__` : "";
  const snapEnd = streaming ? `__SNAP_E_${genUid()}__` : "";
  const pollBody = streaming
    ? `sleep ${pollInterval}; echo '${snapStart}'; ${captureCmd}; echo '${snapEnd}'; if ${sentinelCheck}; then echo '${completionMarker}'; exit 0; fi`
    : `sleep ${pollInterval}; if ${sentinelCheck}; then ${captureCmd}; exit 0; fi`;

  const parts = [
    `i=0`,
    `while [ "$i" -lt ${maxIter} ]; do ${pollBody}; i=$((i + 1)); done`,
    `echo '${timeoutMarker}'`,
    streaming
      ? `echo '${snapStart}'; ${captureCmd}; echo '${snapEnd}'`
      : captureCmd,
  ];
  return parts.join(" && ");
}

function buildIdleWaitScript(
  sn: string,
  maxIter: number,
  pollInterval: number,
  completionMarker: string,
  timeoutMarker: string,
  streaming: boolean,
): string {
  const captureCmd = `tmux capture-pane -t ${sn} -e -p -S -`;
  const idleCheck =
    `PCMD=$(tmux display-message -t ${sn} -p "#{pane_current_command}" 2>/dev/null); ` +
    `echo "$PCMD" | grep -qE "^(${SHELL_NAMES})$" && ` +
    `PANE_PID=$(tmux display-message -t ${sn} -p "#{pane_pid}" 2>/dev/null) && ` +
    `! pgrep -P "$PANE_PID" >/dev/null 2>&1`;

  const snapStart = streaming ? `__SNAP_S_${genUid()}__` : "";
  const snapEnd = streaming ? `__SNAP_E_${genUid()}__` : "";
  const pollBody = streaming
    ? `sleep ${pollInterval}; echo '${snapStart}'; ${captureCmd}; echo '${snapEnd}'; if ${idleCheck}; then echo '${completionMarker}'; exit 0; fi`
    : `sleep ${pollInterval}; if ${idleCheck}; then echo "${completionMarker}"; ${captureCmd}; exit 0; fi`;

  const parts = [
    `sleep 0.3`,
    `i=0`,
    `while [ "$i" -lt ${maxIter} ]; do ${pollBody}; i=$((i + 1)); done`,
    `echo '${timeoutMarker}'`,
    streaming
      ? `echo '${snapStart}'; ${captureCmd}; echo '${snapEnd}'`
      : captureCmd,
  ];
  return parts.join(" && ");
}

// ---------------------------------------------------------------------------
// Snapshot parser for streaming mode
// ---------------------------------------------------------------------------

function createSnapshotParser(snapStart: string, snapEnd: string) {
  let latestSnapshot = "";
  let pendingBuffer = "";

  const onData = (data: string, onSnapshot?: (snap: string) => void) => {
    pendingBuffer += data;
    while (true) {
      const startIdx = pendingBuffer.indexOf(snapStart);
      const endIdx = pendingBuffer.indexOf(snapEnd);
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) break;
      latestSnapshot = normalizePaneCapture(
        pendingBuffer.slice(startIdx + snapStart.length, endIdx),
      );
      onSnapshot?.(latestSnapshot);
      pendingBuffer = pendingBuffer.slice(endIdx + snapEnd.length);
    }
  };

  return { onData, getLatest: () => latestSnapshot };
}

// ---------------------------------------------------------------------------
// Tmux env helpers
// ---------------------------------------------------------------------------

async function persistSentinel(
  sandbox: TmuxSandbox,
  sn: string,
  sentinel: string,
  baselineLength: number,
  tmuxRun: (
    s: TmuxSandbox,
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<void> {
  await tmuxRun(
    sandbox,
    `tmux set-environment -t ${sn} HAI_SENTINEL '${sentinel}' && tmux set-environment -t ${sn} HAI_BASELINE '${baselineLength}'`,
  ).catch(() => {});
}

async function clearSentinel(
  sandbox: TmuxSandbox,
  sn: string,
  tmuxRun: (
    s: TmuxSandbox,
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<void> {
  await tmuxRun(
    sandbox,
    `tmux set-environment -t ${sn} -u HAI_SENTINEL 2>/dev/null; tmux set-environment -t ${sn} -u HAI_BASELINE 2>/dev/null`,
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// LocalPtySessionManager
// ---------------------------------------------------------------------------

export class LocalPtySessionManager {
  private sessions: Map<string, LocalPtySession> = new Map();
  private streamCallbacks: Map<string, (data: string) => void> = new Map();
  private pendingSentinels: Map<string, string> = new Map();
  private busySessions: Set<string> = new Set();
  private idleSessions: string[] = [];
  private nextSessionId = 0;
  private readonly chatId: string;
  private tmuxVerified = false;
  private motdSuppressed = false;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  setStreamCallback(sessionId: string, cb: (data: string) => void): void {
    this.streamCallbacks.set(sessionId, cb);
  }

  clearStreamCallback(sessionId: string): void {
    this.streamCallbacks.delete(sessionId);
  }

  async ensureTmux(sandbox: TmuxSandbox): Promise<void> {
    if (this.tmuxVerified) return;

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
      const verCheck = await this.tmuxRun(sandbox, `${tmuxPath} -V 2>&1`, {
        displayName: "",
      });
      if (verCheck.exitCode === 0) {
        this.tmuxVerified = true;
        return;
      }
    }

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

    const verify = await this.tmuxRun(
      sandbox,
      "command -v tmux 2>/dev/null || test -x /usr/bin/tmux && echo /usr/bin/tmux || which tmux 2>/dev/null || true",
      { displayName: "Verifying tmux installation" },
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

  async createSession(sandbox: TmuxSandbox, sessionId: string): Promise<void> {
    await this.ensureTmux(sandbox);

    if (!this.motdSuppressed) {
      await sandbox.commands
        .run(
          "touch ~/.hushlogin 2>/dev/null; touch /root/.hushlogin 2>/dev/null; touch /home/user/.hushlogin 2>/dev/null || true",
          { timeoutMs: 5000, displayName: "" },
        )
        .catch(() => {});
      this.motdSuppressed = true;
    }

    const tmuxName = `hai_${sanitizeForShell(this.chatId)}_${sanitizeForShell(sessionId)}`;

    await this.tmuxRun(
      sandbox,
      `tmux kill-session -t ${tmuxName} 2>/dev/null || true`,
    ).catch(() => {});

    const result = await this.tmuxRun(
      sandbox,
      `tmux new-session -d -s ${tmuxName} -x 200 -y 50 \\; set-option -t ${tmuxName} history-limit 50000`,
    );

    if (result.exitCode !== 0) {
      const errMsg = result.stderr || result.stdout;
      if (errMsg.includes("duplicate session")) {
        const check = await this.tmuxRun(
          sandbox,
          `tmux has-session -t ${tmuxName} 2>/dev/null && echo ALIVE`,
        ).catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));

        if (check.stdout.includes("ALIVE")) {
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

    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.tmuxRun(sandbox, `tmux clear-history -t ${tmuxName}`);
    await this.tmuxRun(
      sandbox,
      `tmux send-keys -t ${tmuxName} 'set +H 2>/dev/null || true' Enter`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
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

    const envResult = await this.tmuxRun(
      sandbox,
      `tmux show-environment -t ${tmuxName} HAI_SENTINEL 2>/dev/null || true; tmux show-environment -t ${tmuxName} HAI_BASELINE 2>/dev/null || true`,
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

  async acquireSession(
    sandbox: TmuxSandbox,
    preferredSessionId?: string,
  ): Promise<string> {
    const sanitizedPreferred = preferredSessionId
      ? sanitizeForShell(preferredSessionId).slice(0, 32) || undefined
      : undefined;

    if (sanitizedPreferred) {
      if (this.sessions.has(sanitizedPreferred)) {
        const session = this.sessions.get(sanitizedPreferred)!;
        if (!this.busySessions.has(sanitizedPreferred)) {
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
            await this.createSession(sandbox, sanitizedPreferred);
            this.busySessions.add(sanitizedPreferred);
            return sanitizedPreferred;
          }
          session.lastCapturedOutput = "";
          this.busySessions.add(sanitizedPreferred);
          return sanitizedPreferred;
        }
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
      await this.createSession(sandbox, sanitizedPreferred);
      this.busySessions.add(sanitizedPreferred);
      return sanitizedPreferred;
    }

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

  releaseSession(sessionId: string): void {
    this.busySessions.delete(sessionId);
    if (this.sessions.has(sessionId)) this.idleSessions.push(sessionId);
  }

  async execInSession(
    sandbox: TmuxSandbox,
    sessionId: string,
    command: string,
    timeoutSeconds: number,
    _abortSignal?: AbortSignal,
  ): Promise<ExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session)
      return {
        output: "[Error: session not found]",
        exitCode: null,
        timedOut: false,
      };

    const uid = genUid();
    const startMarker = `__START_${uid}__`;
    const sentinel = `__DONE_${uid}__`;
    const fullCommand = `echo ${startMarker}\n${command}\necho ${sentinel}$?`;
    const base64Cmd = Buffer.from(fullCommand).toString("base64");
    const timeoutMarker = `__TMUX_TIMEOUT__`;
    const sn = session.tmuxSessionName;
    const streaming = !!sandbox.supportsStreaming;
    const pollInterval = streaming
      ? POLL_INTERVAL_STREAMING
      : POLL_INTERVAL_BATCH;
    const maxIterations = Math.ceil(timeoutSeconds / pollInterval);

    const execScript = buildExecScript(
      sn,
      base64Cmd,
      sentinel,
      maxIterations,
      pollInterval,
      timeoutMarker,
      streaming,
    );

    try {
      if (streaming) {
        return await this.execStreaming(
          sandbox,
          session,
          sessionId,
          command,
          execScript,
          startMarker,
          sentinel,
          timeoutMarker,
          timeoutSeconds,
        );
      }
      return await this.execBatch(
        sandbox,
        session,
        sessionId,
        command,
        execScript,
        startMarker,
        sentinel,
        timeoutMarker,
        timeoutSeconds,
      );
    } catch (error) {
      return execErrorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async execStreaming(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    command: string,
    execScript: string,
    startMarker: string,
    sentinel: string,
    timeoutMarker: string,
    timeoutSeconds: number,
  ): Promise<ExecResult> {
    const sn = session.tmuxSessionName;
    const snapStart =
      execScript.match(/__SNAP_S_([a-f0-9]+)__/)?.[0] ??
      `__SNAP_S_${genUid()}__`;
    const snapEnd =
      execScript.match(/__SNAP_E_([a-f0-9]+)__/)?.[0] ??
      `__SNAP_E_${genUid()}__`;
    let lastStreamedContent = "";
    const streamCb = this.streamCallbacks.get(sessionId);
    const parser = createSnapshotParser(snapStart, snapEnd);

    const onStdout = (data: string) => {
      parser.onData(data, (latestSnapshot) => {
        if (streamCb) {
          const cleaned = cleanOutput(
            latestSnapshot,
            startMarker,
            sentinel,
            command,
          );
          if (cleaned.length > lastStreamedContent.length) {
            const delta = cleaned.slice(lastStreamedContent.length);
            if (delta.trim()) streamCb(delta);
            lastStreamedContent = cleaned;
          }
        }
      });
    };

    const result = await sandbox.commands.run(execScript, {
      timeoutMs: (timeoutSeconds + 10) * 1000,
      onStdout,
      displayName: command,
    });

    const rawOutput = result.stdout;
    const timedOut = rawOutput.includes(timeoutMarker);
    const finalCapture = parser.getLatest() || normalizePaneCapture(rawOutput);
    session.lastCapturedOutput = finalCapture;

    if (timedOut) {
      this.pendingSentinels.set(sessionId, sentinel);
      await persistSentinel(
        sandbox,
        sn,
        sentinel,
        session.lastCapturedOutput.length,
        (s, cmd) => this.tmuxRun(s, cmd),
      );
      return {
        output: cleanOutput(finalCapture, startMarker, sentinel, command),
        exitCode: null,
        timedOut: true,
      };
    }

    const sentinelRegex = new RegExp(`${sentinel}(\\d+)`, "m");
    const match = finalCapture.match(sentinelRegex);
    const exitCode = match ? parseInt(match[1], 10) : null;
    return {
      output: cleanOutput(finalCapture, startMarker, sentinel, command),
      exitCode,
      timedOut: false,
    };
  }

  private async execBatch(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    command: string,
    execScript: string,
    startMarker: string,
    sentinel: string,
    timeoutMarker: string,
    timeoutSeconds: number,
  ): Promise<ExecResult> {
    const sn = session.tmuxSessionName;
    const result = await sandbox.commands.run(execScript, {
      timeoutMs: (timeoutSeconds + 10) * 1000,
      displayName: command,
    });

    const rawOutput = result.stdout;
    const timedOut = rawOutput.includes(timeoutMarker);

    const streamCb = this.streamCallbacks.get(sessionId);
    if (streamCb) {
      const cleanedForStream = cleanOutput(
        rawOutput,
        startMarker,
        sentinel,
        command,
      );
      if (cleanedForStream.trim()) streamCb(cleanedForStream);
    }

    if (timedOut) {
      this.pendingSentinels.set(sessionId, sentinel);
      const afterMarker = rawOutput.split(timeoutMarker).pop() || "";
      session.lastCapturedOutput = normalizePaneCapture(afterMarker);
      await persistSentinel(
        sandbox,
        sn,
        sentinel,
        session.lastCapturedOutput.length,
        (s, cmd) => this.tmuxRun(s, cmd),
      );
      return {
        output: cleanOutput(afterMarker, startMarker, sentinel, command),
        exitCode: null,
        timedOut: true,
      };
    }

    const sentinelRegex = new RegExp(`${sentinel}(\\d+)`, "m");
    const match = rawOutput.match(sentinelRegex);
    const exitCode = match ? parseInt(match[1], 10) : null;
    session.lastCapturedOutput = normalizePaneCapture(rawOutput);
    return {
      output: cleanOutput(rawOutput, startMarker, sentinel, command),
      exitCode,
      timedOut: false,
    };
  }

  async waitForSession(
    sandbox: TmuxSandbox,
    sessionId: string,
    timeoutSeconds: number,
    _abortSignal?: AbortSignal,
  ): Promise<WaitResult> {
    const session = this.sessions.get(sessionId);
    if (!session)
      return { output: "[Error: session not found]", timedOut: false };

    const sentinel = this.pendingSentinels.get(sessionId) || null;
    const sn = session.tmuxSessionName;

    console.log(
      `[Shell wait] session=${sessionId} tmux=${sn} sentinel=${sentinel ? "yes" : "no"} baseline=${session.lastCapturedOutput.length} streaming=${!!sandbox.supportsStreaming}`,
    );

    if (sandbox.supportsStreaming) {
      return this.waitStreaming(
        sandbox,
        session,
        sessionId,
        sn,
        sentinel,
        timeoutSeconds,
      );
    }
    return this.waitBatch(
      sandbox,
      session,
      sessionId,
      sn,
      sentinel,
      timeoutSeconds,
    );
  }

  private async waitStreaming(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    sn: string,
    sentinel: string | null,
    timeoutSeconds: number,
  ): Promise<WaitResult> {
    const uid = genUid();
    const completionMarker = `__WAIT_COMPLETE_${uid}__`;
    const timeoutMarker = `__WAIT_TIMEOUT_${uid}__`;
    const maxIter = Math.ceil(timeoutSeconds / POLL_INTERVAL_STREAMING);

    const waitScript = sentinel
      ? buildSentinelWaitScript(
          sn,
          sentinel,
          maxIter,
          POLL_INTERVAL_STREAMING,
          completionMarker,
          timeoutMarker,
          true,
        )
      : buildIdleWaitScript(
          sn,
          maxIter,
          POLL_INTERVAL_STREAMING,
          completionMarker,
          timeoutMarker,
          true,
        );

    const snapStart =
      waitScript.match(/__SNAP_S_([a-f0-9]+)__/)?.[0] ??
      `__SNAP_S_${genUid()}__`;
    const snapEnd =
      waitScript.match(/__SNAP_E_([a-f0-9]+)__/)?.[0] ??
      `__SNAP_E_${genUid()}__`;
    let lastStreamedLength = 0;
    const streamCb = this.streamCallbacks.get(sessionId);
    const baselineLength = session.lastCapturedOutput.length;
    const parser = createSnapshotParser(snapStart, snapEnd);

    const onStdout = (data: string) => {
      parser.onData(data, (latestSnapshot) => {
        if (streamCb) {
          const newContent =
            latestSnapshot.length > baselineLength
              ? latestSnapshot.slice(baselineLength)
              : "";
          const cleaned = stripSentinelNoise(newContent);
          if (cleaned.length > lastStreamedLength) {
            const delta = cleaned.slice(lastStreamedLength);
            if (delta.trim()) streamCb(delta);
            lastStreamedLength = cleaned.length;
          }
        }
      });
    };

    try {
      const result = await sandbox.commands.run(waitScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        onStdout,
        displayName: `wait (session: ${sessionId})`,
      });

      const rawOutput = result.stdout;
      const timedOut = rawOutput.includes(timeoutMarker);
      const captured = parser.getLatest() || session.lastCapturedOutput;
      const newContent =
        captured.length > baselineLength ? captured.slice(baselineLength) : "";

      session.lastCapturedOutput = captured;
      if (sentinel && !timedOut) {
        this.pendingSentinels.delete(sessionId);
        await clearSentinel(sandbox, sn, (s, cmd) => this.tmuxRun(s, cmd));
      }

      return {
        output: stripSentinelNoise(newContent).trim() || "[No new output]",
        timedOut,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Shell wait streaming] error session=${sessionId} tmux=${sn} msg=${message}`,
      );
      return waitErrorResult(message);
    }
  }

  private async waitBatch(
    sandbox: TmuxSandbox,
    session: LocalPtySession,
    sessionId: string,
    sn: string,
    sentinel: string | null,
    timeoutSeconds: number,
  ): Promise<WaitResult> {
    const maxIter = Math.ceil(timeoutSeconds / POLL_INTERVAL_BATCH);
    const uid = genUid();
    const completionMarker = `__WAIT_COMPLETE_${uid}__`;
    const timeoutMarker = `__WAIT_TIMEOUT_${uid}__`;

    const waitScript = sentinel
      ? buildSentinelWaitScript(
          sn,
          sentinel,
          maxIter,
          POLL_INTERVAL_BATCH,
          completionMarker,
          timeoutMarker,
          false,
        )
      : buildIdleWaitScript(
          sn,
          maxIter,
          POLL_INTERVAL_BATCH,
          completionMarker,
          timeoutMarker,
          false,
        );

    const runAndProcess = async (): Promise<WaitResult> => {
      const result = await sandbox.commands.run(waitScript, {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        displayName: `wait (session: ${sessionId})`,
      });

      const rawOutput = result.stdout;
      const completed = rawOutput.includes(completionMarker);
      const timedOut = rawOutput.includes(timeoutMarker);
      const captureRaw = completed
        ? rawOutput.split(completionMarker).pop() || ""
        : timedOut
          ? rawOutput.split(timeoutMarker).pop() || ""
          : rawOutput;
      const captured = normalizePaneCapture(captureRaw);
      const baselineLength = session.lastCapturedOutput.length;
      const newContent =
        captured.length > baselineLength ? captured.slice(baselineLength) : "";

      const streamCb = this.streamCallbacks.get(sessionId);
      if (streamCb) {
        const cleanedForStream = stripSentinelNoise(newContent);
        if (cleanedForStream.trim()) streamCb(cleanedForStream);
      }

      session.lastCapturedOutput = captured;
      if (!timedOut && sentinel) {
        this.pendingSentinels.delete(sessionId);
        await clearSentinel(sandbox, sn, (s, cmd) => this.tmuxRun(s, cmd));
      }

      return {
        output: stripSentinelNoise(newContent).trim() || "[No new output]",
        timedOut,
      };
    };

    try {
      return await runAndProcess();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Shell wait batch] error session=${sessionId} tmux=${sn} msg=${message}`,
      );
      return waitErrorResult(message);
    }
  }

  async sendToSession(
    sandbox: TmuxSandbox,
    sessionId: string,
    input: string,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: "Session not found" };

    const sn = session.tmuxSessionName;
    const displayName = `send-keys: ${input.length > 60 ? input.slice(0, 60) + "..." : input}`;

    if (TMUX_SPECIAL_KEYS.has(input)) {
      await this.tmuxRun(sandbox, `tmux send-keys -t ${sn} ${input}`, {
        displayName,
      });
      return { success: true };
    }

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

    const base64Input = Buffer.from(input).toString("base64");
    const needsEnter = !input.endsWith("\n");
    await this.tmuxRun(
      sandbox,
      `printf '%s' '${base64Input}' | base64 -d | tmux load-buffer -b hai_input - && tmux paste-buffer -t ${sn} -b hai_input -d` +
        (needsEnter ? ` && tmux send-keys -t ${sn} Enter` : ""),
      { displayName },
    );
    return { success: true };
  }

  async killSession(
    sandbox: TmuxSandbox,
    sessionId: string,
  ): Promise<{ killed: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { killed: false };

    try {
      await clearSentinel(sandbox, session.tmuxSessionName, (s, cmd) =>
        this.tmuxRun(s, cmd),
      );
      await this.tmuxRun(
        sandbox,
        `tmux kill-session -t ${session.tmuxSessionName}`,
        {
          displayName: `kill session "${sessionId}"`,
        },
      );
    } catch {}

    this.sessions.delete(sessionId);
    this.streamCallbacks.delete(sessionId);
    this.pendingSentinels.delete(sessionId);
    this.busySessions.delete(sessionId);
    const idleIdx = this.idleSessions.indexOf(sessionId);
    if (idleIdx !== -1) this.idleSessions.splice(idleIdx, 1);

    return { killed: true };
  }

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

    return {
      output: stripSentinelNoise(newContent).trim() || "[No new output]",
      exists: true,
    };
  }

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
    return result.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
  }
}
