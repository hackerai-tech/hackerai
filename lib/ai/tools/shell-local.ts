import { CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { UIMessageStreamWriter } from "ai";
import type { AnySandbox } from "@/types";
import {
  truncateContent,
  TOOL_DEFAULT_MAX_TOKENS,
  TIMEOUT_MESSAGE,
} from "@/lib/token-utils";
import { checkCommandGuardrails } from "./utils/guardrails";
import type { GuardrailConfig } from "./utils/guardrails";
import { buildSandboxCommandOptions } from "./utils/sandbox-command-options";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { retryWithBackoff } from "./utils/retry-with-backoff";
import {
  LocalPtySessionManager,
  TmuxNotAvailableError,
} from "./utils/local-pty-session-manager";
import type { ConvexSandbox } from "./utils/convex-sandbox";
import { createTruncatingStreamCallback } from "./utils/stream-truncate";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalHandlers(deps: {
  localSessionManager: LocalPtySessionManager;
  writer: UIMessageStreamWriter;
  effectiveGuardrails: GuardrailConfig[];
}) {
  const { localSessionManager, writer, effectiveGuardrails } = deps;

  /** Set when tmux is not available — routes non-exec actions to the error path. */
  let tmuxUnavailable = false;

  return { dispatch };

  // ===========================================================================
  // Action dispatcher (tmux-based PTY for ConvexSandbox)
  // ===========================================================================

  function dispatch(
    sandbox: ConvexSandbox,
    action: string,
    command: string | undefined,
    input: string | undefined,
    session: string | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    // If tmux is unavailable, non-exec actions cannot work — return the install error
    if (tmuxUnavailable && action !== "exec") {
      return handleConvexFallback(
        sandbox,
        action,
        command,
        timeout,
        toolCallId,
        abortSignal,
      );
    }

    switch (action) {
      case "exec":
        return handleLocalExec(
          sandbox,
          command,
          timeout,
          toolCallId,
          abortSignal,
        );
      case "wait":
        return handleLocalWait(
          sandbox,
          session,
          timeout,
          toolCallId,
          abortSignal,
        );
      case "send":
        return handleLocalSend(sandbox, session, input, toolCallId);
      case "kill":
        return handleLocalKill(sandbox, session);
      default:
        return { output: `Unknown action: ${action}`, error: true };
    }
  }

  // ===========================================================================
  // exec — tmux with sentinel-based completion detection
  // ===========================================================================

  async function handleLocalExec(
    sandbox: ConvexSandbox,
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

    // Acquire a dedicated tmux session (reuses idle ones, auto-suffixes if busy)
    let sessionId: string;
    try {
      sessionId = await localSessionManager.acquireSession(sandbox);
    } catch (error) {
      // tmux not available -- fall back to basic commands.run (exec only)
      if (error instanceof TmuxNotAvailableError) {
        const isFirstFallback = !tmuxUnavailable;
        tmuxUnavailable = true;
        const result = await handleConvexFallback(
          sandbox,
          "exec",
          command,
          timeout,
          toolCallId,
          abortSignal,
        );
        // On the first fallback, append a note so the AI/user knows tmux is missing
        if (isFirstFallback) {
          const note =
            "\n\n[Note: tmux is not installed — running in basic mode. " +
            "Only `exec` is available. Install tmux for full terminal features (wait, send, kill).]";
          return { ...result, output: (result.output || "") + note };
        }
        return result;
      }
      throw error;
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

    localSessionManager.setStreamCallback(sessionId, streamToFrontend);

    let timedOut = false;
    try {
      const result = await localSessionManager.execInSession(
        sandbox,
        sessionId,
        command,
        timeout,
        abortSignal,
      );
      timedOut = result.timedOut;

      const timeoutSuffix = timedOut ? TIMEOUT_MESSAGE(timeout) : "";
      if (timedOut) {
        streamToFrontend(timeoutSuffix);
      }

      const combinedOutput = (result.output + timeoutSuffix).trim();
      return {
        output: truncateContent(
          combinedOutput,
          undefined,
          TOOL_DEFAULT_MAX_TOKENS,
        ),
        exitCode: result.exitCode,
        session: sessionId,
      };
    } finally {
      localSessionManager.clearStreamCallback(sessionId);
      if (!timedOut) {
        localSessionManager.releaseSession(sessionId);
      }
    }
  }

  // ===========================================================================
  // wait
  // ===========================================================================

  async function handleLocalWait(
    sandbox: ConvexSandbox,
    session: string | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    if (!session) {
      return {
        output:
          "Error: `session` is required for `wait` action. Run `exec` first to create a session.",
        error: true,
      };
    }
    if (!localSessionManager.hasSession(session)) {
      return {
        output: `No shell session found with name "${session}". Use \`exec\` action to create one.`,
      };
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
    const pending = await localSessionManager.viewSessionAsync(
      sandbox,
      session,
    );
    const pendingOutput =
      pending.output && pending.output !== "[No new output]"
        ? pending.output
        : "";
    if (pendingOutput) {
      streamToFrontend(pendingOutput);
    }

    localSessionManager.setStreamCallback(session, streamToFrontend);

    const { output, timedOut } = await localSessionManager.waitForSession(
      sandbox,
      session,
      timeout,
      abortSignal,
    );

    localSessionManager.clearStreamCallback(session);

    if (!timedOut) {
      localSessionManager.releaseSession(session);
    }

    const waitOutput = output !== "[No new output]" ? output : "";
    const combinedOutput =
      [pendingOutput, waitOutput].filter(Boolean).join("\n").trim() ||
      "[No new output]";

    return {
      output: truncateContent(
        combinedOutput,
        undefined,
        TOOL_DEFAULT_MAX_TOKENS,
      ),
      session,
      ...(timedOut && { timedOut: true }),
    };
  }

  // ===========================================================================
  // send
  // ===========================================================================

  async function handleLocalSend(
    sandbox: ConvexSandbox,
    session: string | undefined,
    input: string | undefined,
    toolCallId: string,
  ) {
    if (!input) {
      return {
        output: "Error: `input` parameter is required for `send` action.",
        error: true,
      };
    }
    if (!session) {
      return {
        output:
          "Error: `session` is required for `send` action. Run `exec` first to create a session.",
        error: true,
      };
    }
    if (!localSessionManager.hasSession(session)) {
      return {
        output: `No shell session found with name "${session}". Use \`exec\` action to create one.`,
      };
    }

    // No guardrails check here: `send` delivers keystrokes to an already-
    // running process (e.g. answering a prompt, Ctrl-C).  The command that
    // spawned the process was already validated by `exec`.
    const result = await localSessionManager.sendToSession(
      sandbox,
      session,
      input,
    );
    if (!result.success) {
      return { output: `Error: ${result.error}`, error: true };
    }

    // Brief pause so the terminal has time to echo a response
    await new Promise((resolve) => setTimeout(resolve, 500));

    const viewResult = await localSessionManager.viewSessionAsync(
      sandbox,
      session,
    );
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
      session,
    };
  }

  // ===========================================================================
  // kill
  // ===========================================================================

  async function handleLocalKill(
    sandbox: ConvexSandbox,
    session: string | undefined,
  ) {
    if (!session) {
      return {
        output: "Error: `session` is required for `kill` action.",
        error: true,
      };
    }
    const { killed } = await localSessionManager.killSession(sandbox, session);
    if (!killed) {
      return { output: `No shell session found with name "${session}".` };
    }
    return { output: `Shell session "${session}" terminated.` };
  }

  // ===========================================================================
  // ConvexSandbox fallback (basic commands.run — used when tmux unavailable)
  // ===========================================================================

  async function handleConvexFallback(
    sandbox: AnySandbox,
    action: string,
    command: string | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    if (action !== "exec") {
      return {
        output:
          `The "${action}" action requires tmux, which is not installed and could not be auto-installed. ` +
          `Only "exec" is available without tmux. ` +
          `Install tmux manually to enable wait/send/kill:\n` +
          `  macOS:   brew install tmux\n` +
          `  Linux:   sudo apt-get install tmux  (or: dnf, apk, yum)\n` +
          `  Windows: available via WSL or Docker (tmux is not native to Windows)`,
        error: true,
      };
    }
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
        output: `Command blocked by security guardrail "${guardrailResult.policyName}": ${guardrailResult.message}.`,
        error: true,
      };
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

    const handler = createTerminalHandler(streamToFrontend, {
      timeoutSeconds: timeout,
    });
    const opts = buildSandboxCommandOptions(sandbox, {
      onStdout: handler.stdout,
      onStderr: handler.stderr,
    });

    try {
      const result = await retryWithBackoff(
        () => sandbox.commands.run(command, opts),
        {
          maxRetries: 6,
          baseDelayMs: 500,
          jitterMs: 50,
          isPermanentError: (err: unknown) => {
            if (err instanceof CommandExitError) return true;
            if (err instanceof Error) {
              if (err.message.includes("signal:")) return true;
              return (
                err.name === "NotFoundError" ||
                err.message.includes("not running anymore") ||
                err.message.includes("Sandbox not found")
              );
            }
            return false;
          },
          logger: () => {},
        },
      );

      handler.cleanup();
      return {
        output: truncateContent(
          handler.getResult().output || "",
          undefined,
          TOOL_DEFAULT_MAX_TOKENS,
        ),
        exitCode: result.exitCode,
      };
    } catch (error) {
      handler.cleanup();
      if (error instanceof CommandExitError) {
        return {
          output: truncateContent(
            handler.getResult().output || "",
            undefined,
            TOOL_DEFAULT_MAX_TOKENS,
          ),
          exitCode: error.exitCode,
          error: error.message,
        };
      }
      throw error;
    }
  }
}
