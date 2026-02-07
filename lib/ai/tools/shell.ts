import { tool } from "ai";
import { z } from "zod";
import { Sandbox, CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext, AnySandbox } from "@/types";
import {
  truncateContent,
  TOOL_DEFAULT_MAX_TOKENS,
  TIMEOUT_MESSAGE,
} from "@/lib/token-utils";
import { waitForSandboxReady } from "./utils/sandbox-health";
import { isE2BSandbox } from "./utils/sandbox-types";
import { buildSandboxCommandOptions } from "./utils/sandbox-command-options";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { retryWithBackoff } from "./utils/retry-with-backoff";
import {
  parseGuardrailConfig,
  getEffectiveGuardrails,
  checkCommandGuardrails,
} from "./utils/guardrails";
import { PtySessionManager } from "./utils/pty-session-manager";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

export const createShell = (context: ToolContext) => {
  const { sandboxManager, writer, guardrailsConfig } = context;

  const userGuardrailConfig = parseGuardrailConfig(guardrailsConfig);
  const effectiveGuardrails = getEffectiveGuardrails(userGuardrailConfig);
  const sessionManager = new PtySessionManager();

  // Only health-check the sandbox once per chat context
  let healthChecked = false;

  return tool({
    description: `Interact with persistent shell sessions in the sandbox environment.

<supported_actions>
- \`exec\`: Execute command in a shell session
- \`wait\`: Wait for the running process in a shell session to return
- \`send\`: Send input to the active process (stdin) in a shell session
- \`kill\`: Terminate the running process in a shell session
</supported_actions>

<instructions>
- Prioritize using \`file\` tool instead of this tool for file content operations to avoid escaping errors
- \`exec\` runs the command and returns output along with a \`pid\` — save this \`pid\` for subsequent \`wait\`, \`send\`, and \`kill\` actions
- The default working directory for newly created shell sessions is /home/user
- Working directory will be reset to /home/user in every new shell session; Use \`cd\` command to change directories as needed
- MUST avoid commands that require confirmation; use flags like \`-y\` or \`-f\` for automatic execution
- Avoid commands with excessive output; redirect to files when necessary
- Chain multiple commands with \`&&\` to reduce interruptions and handle errors cleanly
- Use pipes (\`|\`) to simplify workflows by passing outputs between commands
- NEVER run code directly via interpreter commands; MUST save code to a file using the \`file\` tool before execution
- Set a short \`timeout\` (such as 5s) for commands that don't return (like starting web servers) to avoid meaningless waiting time
- Commands are NEVER killed on timeout - they keep running in the background; timeout only controls how long to wait for output before returning
- For daemons, servers, or very long-running jobs, append \`&\` to run in background (e.g., \`python app.py > server.log 2>&1 &\`)
- Use \`wait\` action when a command needs additional time to complete and return
- Only use \`wait\` after \`exec\`, and determine whether to wait based on the result of \`exec\`
- DO NOT use \`wait\` for long-running daemon processes
- When using \`send\`, add a newline character (\\n) at the end of the \`input\` parameter to simulate pressing Enter
- For special keys, use official tmux key names: C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), Up, Down, Left, Right, Home, End, Escape, Tab, Enter, Space, F1-F12, PageUp, PageDown
- For modifier combinations: M-key (Alt), S-key (Shift), C-S-key (Ctrl+Shift)
- Note: Use official tmux names (BSpace not Backspace, DC not Delete, Escape not Esc)
- For non-key strings in \`input\`, DO NOT perform any escaping; send the raw string directly
</instructions>

<recommended_usage>
- Use \`exec\` to install packages or dependencies
- Use \`exec\` to copy, move, or delete files
- Use \`exec\` to run scripts and tools
- Use \`wait\` to wait for the completion of long-running commands
- Use \`send\` to interact with processes that require user input (e.g., responding to prompts)
- Use \`send\` with special keys like C-c to interrupt, C-d to send EOF
- Use \`kill\` to stop background processes that are no longer needed
- Use \`kill\` to clean up dead or unresponsive processes
- After creating files that the user needs (reports, scan results, generated documents), use the \`get_terminal_files\` tool to share them as downloadable attachments
</recommended_usage>

When making charts for the user: 1) never use seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never set any specific colors – unless explicitly asked to by the user.
I REPEAT: when making charts for the user: 1) use matplotlib over seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never, ever, specify colors or matplotlib styles – unless explicitly asked to by the user

If you are generating files:
- You MUST use the instructed library for each supported file format. (Do not assume any other libraries are available):
    - pdf --> reportlab
    - docx --> python-docx
    - xlsx --> openpyxl
    - pptx --> python-pptx
    - csv --> pandas
    - rtf --> pypandoc
    - txt --> pypandoc
    - md --> pypandoc
    - ods --> odfpy
    - odt --> odfpy
    - odp --> odfpy
- If you are generating a pdf:
    - You MUST prioritize generating text content using reportlab.platypus rather than canvas
    - If you are generating text in korean, chinese, OR japanese, you MUST use the following built-in UnicodeCIDFont. To use these fonts, you must call pdfmetrics.registerFont(UnicodeCIDFont(font_name)) and apply the style to all text elements:
        - japanese --> HeiseiMin-W3 or HeiseiKakuGo-W5
        - simplified chinese --> STSong-Light
        - traditional chinese --> MSung-Light
        - korean --> HYSMyeongJo-Medium
- If you are to use pypandoc, you are only allowed to call the method pypandoc.convert_text and you MUST include the parameter extra_args=['--standalone']. Otherwise the file will be corrupt/incomplete
    - For example: pypandoc.convert_text(text, 'rtf', format='md', outputfile='output.rtf', extra_args=['--standalone'])`,
    inputSchema: z.object({
      action: z
        // TODO: re-add "view" once terminal output persistence is implemented
        .enum([/* "view", */ "exec", "wait", "send", "kill"])
        .describe("The action to perform"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      command: z
        .string()
        .optional()
        .describe("The shell command to execute. Required for `exec` action."),
      input: z
        .string()
        .optional()
        .describe(
          "Input text to send to the interactive session. End with a newline character (\\n) to simulate pressing Enter if needed. Required for `send` action.",
        ),
      pid: z
        .number()
        .int()
        .optional()
        .describe(
          "The process ID of the target shell session. Returned by `exec`. Required for `wait`, `send`, and `kill` actions.",
        ),
      timeout: z
        .number()
        .int()
        .optional()
        .default(DEFAULT_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for command execution. Only used for \`exec\` and \`wait\` actions. Defaults to ${DEFAULT_TIMEOUT_SECONDS} seconds. Max ${MAX_TIMEOUT_SECONDS} seconds.`,
        ),
    }),
    execute: async (
      {
        action,
        command,
        input,
        pid,
        timeout,
      }: {
        action: /* "view" | */ "exec" | "wait" | "send" | "kill";
        command?: string;
        input?: string;
        pid?: number;
        timeout?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      const defaultForAction =
        action === "wait" ? MAX_TIMEOUT_SECONDS : DEFAULT_TIMEOUT_SECONDS;
      const effectiveTimeout = Math.min(
        timeout ?? defaultForAction,
        MAX_TIMEOUT_SECONDS,
      );

      try {
        const { sandbox } = await sandboxManager.getSandbox();

        const fallbackInfo = sandboxManager.consumeFallbackInfo?.();
        if (fallbackInfo?.occurred) {
          writer.write({
            type: "data-sandbox-fallback",
            id: `sandbox-fallback-${toolCallId}`,
            data: fallbackInfo,
          });
        }

        // Non-E2B sandboxes don't support PTY — fall back to commands.run for exec only
        if (!isE2BSandbox(sandbox)) {
          return handleConvexFallback(
            sandbox,
            action,
            command,
            effectiveTimeout,
            toolCallId,
            abortSignal,
          );
        }

        const e2b = sandbox as Sandbox;

        // Health-check the sandbox before first PTY creation
        if (action === "exec" && !healthChecked) {
          healthChecked = true;
          try {
            await waitForSandboxReady(sandbox, 5, abortSignal);
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError")
              throw err;

            console.warn("[Shell] Sandbox health check failed, recreating");
            sandboxManager.setSandbox(null as any);
            const { sandbox: fresh } = await sandboxManager.getSandbox();

            if (!isE2BSandbox(fresh)) {
              return handleConvexFallback(
                fresh,
                action,
                command,
                effectiveTimeout,
                toolCallId,
                abortSignal,
              );
            }
            await waitForSandboxReady(fresh, 5, abortSignal);
            return dispatch(
              fresh as Sandbox,
              action,
              command,
              input,
              pid,
              effectiveTimeout,
              toolCallId,
              abortSignal,
            );
          }
        }

        return dispatch(
          e2b,
          action,
          command,
          input,
          pid,
          effectiveTimeout,
          toolCallId,
          abortSignal,
        );
      } catch (error) {
        console.error("[Shell] Error:", error);
        return {
          output:
            error instanceof Error ? error.message : "Unknown error occurred",
          error: true,
        };
      }
    },
  });

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
    const streamToFrontend = (text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    };

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
    const streamToFrontend = (text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    };

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
    const combinedOutput = (pendingOutput + output).trim() || "[No new output]";

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
      writer.write({
        type: "data-terminal",
        id: `terminal-${randomUUID()}-1`,
        data: { terminal: output, toolCallId },
      });
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

  // ===========================================================================
  // ConvexSandbox fallback (no PTY support)
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
        output: `The "${action}" action is not supported in local sandbox mode. Only "exec" is available.`,
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
    const streamToFrontend = (text: string) => {
      writer.write({
        type: "data-terminal",
        id: `${termId}-${++counter}`,
        data: { terminal: text, toolCallId },
      });
    };

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
};
