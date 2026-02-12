import { Sandbox } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { UIMessageStreamWriter } from "ai";
import {
  truncateContent,
  TOOL_DEFAULT_MAX_TOKENS,
  STREAM_MAX_TOKENS,
  TIMEOUT_MESSAGE,
} from "@/lib/token-utils";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { checkCommandGuardrails } from "../../utils/guardrails";
import type { GuardrailConfig } from "../../utils/guardrails";
import { LocalPtySessionManager, TmuxNotAvailableError } from "../session";
import type { TmuxSandbox } from "../session";

// ---------------------------------------------------------------------------
// E2B sandbox adapter — wraps E2B Sandbox as TmuxSandbox so the tmux-based
// LocalPtySessionManager can drive terminal sessions inside E2B.
// ---------------------------------------------------------------------------

export function wrapE2BAsTmuxSandbox(sandbox: Sandbox): TmuxSandbox {
  return {
    // E2B supports streaming via onStdout callback
    supportsStreaming: true,
    commands: {
      run: async (command, opts) => {
        const result = await sandbox.commands.run(command, {
          timeoutMs: opts?.timeoutMs,
          // E2B needs root for network tools (ping, nmap, etc.)
          user: "root",
          cwd: "/home/user",
          // Pass through onStdout for streaming support
          // E2B SDK v1.x passes {line: string}, v2.x passes string directly
          onStdout: opts?.onStdout
            ? (output: unknown) => {
                const text =
                  typeof output === "string"
                    ? output
                    : ((output as { line?: string })?.line ?? "");
                if (text) opts.onStdout!(text);
              }
            : undefined,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createE2BHandlers(deps: {
  sessionManager: LocalPtySessionManager;
  writer: UIMessageStreamWriter;
  effectiveGuardrails: GuardrailConfig[];
}) {
  const { sessionManager, writer, effectiveGuardrails } = deps;

  /** Set when tmux is not available in the E2B sandbox. */
  let tmuxUnavailable = false;

  return { dispatch };

  // ===========================================================================
  // Action dispatcher (tmux-based, same as local)
  // ===========================================================================

  function dispatch(
    sandbox: Sandbox,
    action: string,
    command: string | undefined,
    input: string | undefined,
    session: string | undefined,
    timeout: number,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ) {
    const tmuxSandbox = wrapE2BAsTmuxSandbox(sandbox);

    // If tmux is unavailable, non-exec actions cannot work
    if (tmuxUnavailable && action !== "exec") {
      return {
        output:
          `The "${action}" action requires tmux, which could not be installed in the E2B sandbox. ` +
          `Only "exec" is available without tmux.`,
        error: true,
      };
    }

    switch (action) {
      case "exec":
        return handleExec(
          tmuxSandbox,
          command,
          session,
          timeout,
          toolCallId,
          abortSignal,
        );
      case "wait":
        return handleWait(
          tmuxSandbox,
          session,
          timeout,
          toolCallId,
          abortSignal,
        );
      case "send":
        return handleSend(tmuxSandbox, session, input, toolCallId);
      case "kill":
        return handleKill(tmuxSandbox, session);
      default:
        return { output: `Unknown action: ${action}`, error: true };
    }
  }

  // ===========================================================================
  // exec — tmux with sentinel-based completion detection
  // ===========================================================================

  async function handleExec(
    sandbox: TmuxSandbox,
    command: string | undefined,
    preferredSession: string | undefined,
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
      sessionId = await sessionManager.acquireSession(
        sandbox,
        preferredSession,
      );
    } catch (error) {
      if (error instanceof TmuxNotAvailableError) {
        tmuxUnavailable = true;
        return {
          output:
            "[Error: tmux could not be installed in the E2B sandbox. " +
            "Shell exec is not available without tmux in this environment.]",
          error: true,
        };
      }
      throw error;
    }

    const termId = `terminal-${randomUUID()}`;
    let counter = 0;
    const streamToFrontend = (text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    };

    const streamHandler = createTerminalHandler(streamToFrontend, {
      maxTokens: STREAM_MAX_TOKENS,
    });
    sessionManager.setStreamCallback(sessionId, streamHandler.stdout);

    let timedOut = false;
    try {
      const result = await sessionManager.execInSession(
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
      sessionManager.clearStreamCallback(sessionId);
      if (!timedOut) {
        sessionManager.releaseSession(sessionId);
      }
    }
  }

  // ===========================================================================
  // wait
  // ===========================================================================

  async function handleWait(
    sandbox: TmuxSandbox,
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
    if (!sessionManager.hasSession(session)) {
      return {
        output: `No shell session found with name "${session}". Use \`exec\` action to create one.`,
      };
    }

    const termId = `terminal-${randomUUID()}`;
    let counter = 0;
    const streamToFrontend = (text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    };

    const streamHandler = createTerminalHandler(streamToFrontend, {
      maxTokens: STREAM_MAX_TOKENS,
    });

    // Flush any output that accumulated before this wait call
    const pending = await sessionManager.viewSessionAsync(sandbox, session);
    const pendingOutput =
      pending.output && pending.output !== "[No new output]"
        ? pending.output
        : "";
    if (pendingOutput) {
      streamHandler.stdout(pendingOutput);
    }

    sessionManager.setStreamCallback(session, streamHandler.stdout);

    const { output, timedOut } = await sessionManager.waitForSession(
      sandbox,
      session,
      timeout,
      abortSignal,
    );

    sessionManager.clearStreamCallback(session);

    if (!timedOut) {
      sessionManager.releaseSession(session);
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

  async function handleSend(
    sandbox: TmuxSandbox,
    session: string | undefined,
    input: string | undefined,
    toolCallId: string,
  ) {
    if (!input?.trim()) {
      return {
        output:
          "Error: `input` parameter is required for `send` action (cannot be empty or whitespace-only).",
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
    if (!sessionManager.hasSession(session)) {
      return {
        output: `No shell session found with name "${session}". Use \`exec\` action to create one.`,
      };
    }

    const result = await sessionManager.sendToSession(sandbox, session, input);
    if (!result.success) {
      return { output: `Error: ${result.error}`, error: true };
    }

    // Brief pause so the terminal has time to echo a response
    await new Promise((resolve) => setTimeout(resolve, 500));

    const viewResult = await sessionManager.viewSessionAsync(sandbox, session);
    const rawOutput = viewResult.output || "[Input sent successfully]";
    const output =
      rawOutput === "[No new output]"
        ? "Input sent. No new output since last read."
        : rawOutput;

    if (
      output !== "Input sent. No new output since last read." &&
      output !== "[Input sent successfully]"
    ) {
      const truncatedOutput = truncateContent(
        output,
        undefined,
        STREAM_MAX_TOKENS,
      );
      writer.write({
        type: "data-terminal",
        id: `terminal-${randomUUID()}-1`,
        data: { terminal: truncatedOutput, toolCallId },
      });
    }

    return {
      output: truncateContent(output, undefined, TOOL_DEFAULT_MAX_TOKENS),
      session,
    };
  }

  // ===========================================================================
  // kill
  // ===========================================================================

  async function handleKill(sandbox: TmuxSandbox, session: string | undefined) {
    if (!session) {
      return {
        output: "Error: `session` is required for `kill` action.",
        error: true,
      };
    }
    const { killed } = await sessionManager.killSession(sandbox, session);
    if (!killed) {
      return {
        output: `Session "${session}" already terminated or not found.`,
      };
    }
    return { output: `Shell session "${session}" terminated.` };
  }
}
