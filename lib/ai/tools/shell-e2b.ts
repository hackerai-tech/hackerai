import { Sandbox } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { UIMessageStreamWriter } from "ai";
import {
  truncateContent,
  TOOL_DEFAULT_MAX_TOKENS,
  TIMEOUT_MESSAGE,
} from "@/lib/token-utils";
import { checkCommandGuardrails } from "./utils/guardrails";
import type { GuardrailConfig } from "./utils/guardrails";
import type { PtySessionManager } from "./utils/pty-session-manager";
import { createTruncatingStreamCallback } from "./utils/stream-truncate";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createE2BHandlers(deps: {
  sessionManager: PtySessionManager;
  writer: UIMessageStreamWriter;
  effectiveGuardrails: GuardrailConfig[];
}) {
  const { sessionManager, writer, effectiveGuardrails } = deps;

  return { dispatch };

  // ===========================================================================
  // Action dispatcher
  // ===========================================================================

  function dispatch(
    sandbox: Sandbox,
    action: string,
    command: string | undefined,
    input: string | undefined,
    pid: number | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    switch (action) {
      case "exec":
        return handleExec(sandbox, command, timeout, toolCallId, abortSignal);
      // TODO: re-enable once terminal output persistence is implemented
      // case "view":  return handleView(pid);
      case "wait":
        return handleWait(sandbox, pid, timeout, toolCallId, abortSignal);
      case "send":
        return handleSend(sandbox, pid, input, toolCallId);
      case "kill":
        return handleKill(sandbox, pid);
      default:
        return { output: `Unknown action: ${action}`, error: true };
    }
  }

  // ===========================================================================
  // exec — PTY with sentinel-based completion detection
  // ===========================================================================

  async function handleExec(
    sandbox: Sandbox,
    command: string | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    if (!command) {
      return {
        output: "Error: `command` parameter is required for `exec` action.",
        error: true,
      };
    }

    const guardrailResult = checkCommandGuardrails(
      command,
      effectiveGuardrails,
    );
    if (!guardrailResult.allowed) {
      return {
        output: `Command blocked by security guardrail "${guardrailResult.policyName}": ${guardrailResult.message}. This command pattern has been blocked for safety.`,
        error: true,
      };
    }

    // Acquire a dedicated PTY session (reuses idle ones, creates new if all busy)
    const sessionPid = await sessionManager.acquireSession(sandbox);

    const termId = `terminal-${randomUUID()}`;
    let counter = 0;
    const streamToFrontend = createTruncatingStreamCallback((text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    });

    sessionManager.setStreamCallback(sessionPid, streamToFrontend);

    let timedOut = false;
    try {
      const result = await sessionManager.execInSession(
        sandbox,
        sessionPid,
        command,
        timeout,
        abortSignal,
      );
      timedOut = result.timedOut;

      // Include timeout message in both the stream (for real-time display)
      // and the returned output (so it persists after the tool completes)
      const timeoutSuffix = timedOut
        ? TIMEOUT_MESSAGE(timeout, sessionPid)
        : "";
      if (timedOut) {
        streamToFrontend(timeoutSuffix);
      }

      return {
        output: truncateContent(
          result.output + timeoutSuffix,
          undefined,
          TOOL_DEFAULT_MAX_TOKENS,
        ),
        exitCode: result.exitCode,
        pid: sessionPid,
      };
    } finally {
      sessionManager.clearStreamCallback(sessionPid);
      // Release session back to idle pool only if command completed.
      // Timed-out sessions stay busy for subsequent wait/kill calls.
      if (!timedOut) {
        sessionManager.releaseSession(sessionPid);
      }
    }
  }

  // ===========================================================================
  // view (DISABLED)
  // ===========================================================================
  // TODO: The `view` action is currently broken because `viewSession` only
  // returns output accumulated since the last read (it advances `lastReadIndex`).
  // After `exec` finishes, the read index is already at the end of the buffer,
  // so `view` always returns "[No new output]".
  //
  // To fix this, we need to implement persistent terminal output saving:
  // 1. Store the full cleaned output of each `exec` command (keyed by pid + command).
  // 2. `view` should return the saved output for that session, not just the
  //    incremental delta from the PTY buffer.
  // 3. Consider saving output snapshots that can be replayed/viewed later
  //    (e.g., store in a Map<pid, Array<{ command, output, exitCode, timestamp }>>).
  //
  // Once implemented, uncomment the handler below and re-add "view" to the
  // action enum, type, dispatch switch, and tool description.
  //
  // function handleView(pid: number | undefined) {
  //   if (!pid) {
  //     return { output: "Error: `pid` is required for `view` action. Run `exec` first to create a session.", error: true };
  //   }
  //   const result = sessionManager.viewSession(pid);
  //   if (!result.exists) {
  //     return { output: `No shell session found with PID ${pid}. Use \`exec\` action to create one.` };
  //   }
  //   return {
  //     output: truncateContent(result.output, undefined, TOOL_DEFAULT_MAX_TOKENS),
  //     pid,
  //   };
  // }

  // ===========================================================================
  // wait
  // ===========================================================================

  async function handleWait(
    sandbox: Sandbox,
    pid: number | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    if (!pid) {
      return {
        output:
          "Error: `pid` is required for `wait` action. Run `exec` first to create a session.",
        error: true,
      };
    }
    if (!sessionManager.hasSession(pid)) {
      const reconnected = await sessionManager.reconnectSession(sandbox, pid);
      if (!reconnected) {
        return {
          output: `No shell session found with PID ${pid}. Use \`exec\` action to create one.`,
        };
      }
    }

    const termId = `terminal-${randomUUID()}`;
    let counter = 0;
    const streamToFrontend = createTruncatingStreamCallback((text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    });

    // Flush any output that accumulated before this wait call
    const pending = sessionManager.viewSession(pid);
    const pendingOutput =
      pending.output && pending.output !== "[No new output]"
        ? pending.output
        : "";
    if (pendingOutput) {
      streamToFrontend(pendingOutput);
    }

    sessionManager.setStreamCallback(pid, streamToFrontend);

    const { output, timedOut } = await sessionManager.waitForSession(
      pid,
      timeout,
      abortSignal,
    );

    sessionManager.clearStreamCallback(pid);

    // Release the session back to the idle pool if the command finished.
    // If wait also timed out, keep it busy for another wait/kill.
    if (!timedOut) {
      sessionManager.releaseSession(pid);
    }

    // Combine flushed pending output + wait output so the final result matches the stream
    const combinedOutput =
      [pendingOutput, output].filter(Boolean).join("\n").trim() ||
      "[No new output]";

    return {
      output: truncateContent(
        combinedOutput,
        undefined,
        TOOL_DEFAULT_MAX_TOKENS,
      ),
      pid,
      ...(timedOut && { timedOut: true }),
    };
  }

  // ===========================================================================
  // send
  // ===========================================================================

  async function handleSend(
    sandbox: Sandbox,
    pid: number | undefined,
    input: string | undefined,
    toolCallId: string,
  ) {
    if (!input) {
      return {
        output: "Error: `input` parameter is required for `send` action.",
        error: true,
      };
    }
    if (!pid) {
      return {
        output:
          "Error: `pid` is required for `send` action. Run `exec` first to create a session.",
        error: true,
      };
    }
    if (!sessionManager.hasSession(pid)) {
      const reconnected = await sessionManager.reconnectSession(sandbox, pid);
      if (!reconnected) {
        return {
          output: `No shell session found with PID ${pid}. Use \`exec\` action to create one.`,
        };
      }
    }

    // No guardrails check here: `send` delivers keystrokes to an already-
    // running process (e.g. answering a prompt, Ctrl-C).  The command that
    // spawned the process was already validated by `exec`.
    const result = await sessionManager.sendToSession(sandbox, pid, input);
    if (!result.success) {
      return { output: `Error: ${result.error}`, error: true };
    }

    // Brief pause so the PTY has time to echo a response
    await new Promise((resolve) => setTimeout(resolve, 300));

    const viewResult = sessionManager.viewSession(pid);
    const output = viewResult.output || "[Input sent successfully]";

    if (
      output !== "[No new output]" &&
      output !== "[Input sent successfully]"
    ) {
      const streamToFrontend = createTruncatingStreamCallback(
        (text: string) => {
          writer.write({
            type: "data-terminal",
            id: `terminal-${randomUUID()}-1`,
            data: { terminal: text, toolCallId },
          });
        },
      );
      streamToFrontend(output);
    }

    return {
      output: truncateContent(output, undefined, TOOL_DEFAULT_MAX_TOKENS),
      pid,
    };
  }

  // ===========================================================================
  // kill
  // ===========================================================================

  async function handleKill(sandbox: Sandbox, pid: number | undefined) {
    if (!pid) {
      return {
        output: "Error: `pid` is required for `kill` action.",
        error: true,
      };
    }
    const { killed } = await sessionManager.killSession(sandbox, pid);
    if (!killed) {
      // PTY may still be alive in the sandbox but not tracked locally (cross-request)
      try {
        await sandbox.pty.kill(pid);
        return { output: `Shell session (PID: ${pid}) terminated.` };
      } catch {
        return { output: `No shell session found with PID ${pid}.` };
      }
    }
    return { output: `Shell session (PID: ${pid}) terminated.` };
  }
}
