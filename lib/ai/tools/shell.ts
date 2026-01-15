import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { SESSION_MANAGER_PATH } from "./utils/session-manager-script";
import {
  ensureSessionManager,
  escapeShellArg,
  parseSessionResult,
} from "./utils/session-manager-utils";
import { retryWithBackoff } from "./utils/retry-with-backoff";
import { waitForSandboxReady } from "./utils/sandbox-health";
import {
  parseScopeExclusions,
  checkCommandScopeExclusion,
} from "./utils/scope-exclusions";
import {
  parseGuardrailConfig,
  getEffectiveGuardrails,
  checkCommandGuardrails,
} from "./utils/guardrails";
import { buildSandboxCommandOptions } from "./utils/sandbox-command-options";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;

export const createShell = (context: ToolContext) => {
  const { sandboxManager, writer, scopeExclusions, guardrailsConfig, chatId } =
    context;
  const exclusionsList = parseScopeExclusions(scopeExclusions || "");

  // Parse user guardrail configuration and get effective guardrails
  const userGuardrailConfig = parseGuardrailConfig(guardrailsConfig);
  const effectiveGuardrails = getEffectiveGuardrails(userGuardrailConfig);

  return tool({
    description: `Interact with persistent shell sessions in the sandbox environment.

<supported_actions>
- \`view\`: View the content of a shell session
- \`exec\`: Execute command in a shell session
- \`wait\`: Wait for the running process in a shell session to return
- \`send\`: Send input to the active process (stdin) in a shell session
- \`kill\`: Terminate the running process in a shell session
</supported_actions>

<instructions>
- Prioritize using \`write_file\` tool instead of this tool for file content operations to avoid escaping errors
- When using \`view\` action, ensure command has completed execution before using its output
- \`exec\` action will automatically create new shell sessions based on unique identifier
- The default working directory for newly created shell sessions is /home/user
- Working directory will be reset to /home/user in every new shell session; Use \`cd\` command to change directories as needed
- MUST avoid commands that require confirmation; use flags like \`-y\` or \`-f\` for automatic execution
- Avoid commands with excessive output; redirect to files when necessary
- Chain multiple commands with \`&&\` to reduce interruptions and handle errors cleanly
- Use pipes (\`|\`) to simplify workflows by passing outputs between commands
- NEVER run code directly via interpreter commands; MUST save code to a file using the \`write_file\` tool before execution
- Set a short \`timeout\` (such as 5s) for commands that don't return (like starting web servers) to avoid meaningless waiting time
- Use \`wait\` action when a command needs additional time to complete and return
- Only use \`wait\` after \`exec\`, and determine whether to wait based on the result of \`exec\`
- DO NOT use \`wait\` for long-running daemon processes
- When using \`send\`, add a newline character (\\n) at the end of the \`input\` parameter to simulate pressing Enter
- For special keys, use tmux key names: C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), Up, Down, Left, Right, Escape, Tab, Enter
- For non-key strings in \`input\`, DO NOT perform any escaping; send the raw string directly
</instructions>

<recommended_usage>
- Use \`view\` to check shell session history and latest status
- Use \`exec\` to install packages or dependencies
- Use \`exec\` to copy, move, or delete files
- Use \`exec\` to run scripts and tools
- Use \`wait\` to wait for the completion of long-running commands
- Use \`send\` to interact with processes that require user input (e.g., responding to prompts)
- Use \`send\` with special keys like C-c to interrupt, C-d to send EOF
- Use \`kill\` to stop background processes that are no longer needed
- Use \`kill\` to clean up dead or unresponsive processes
</recommended_usage>`,
    inputSchema: z.object({
      action: z
        .enum(["view", "exec", "wait", "send", "kill"])
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
          "Input text to send to the interactive session. End with \\n to simulate pressing Enter. For special keys use tmux names: C-c, C-d, Up, Down, Escape, etc. Required for `send` action.",
        ),
      session: z
        .string()
        .default("default")
        .describe("The unique identifier of the target shell session"),
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
        session,
        timeout,
      }: {
        action: "view" | "exec" | "wait" | "send" | "kill";
        brief: string;
        command?: string;
        input?: string;
        session: string;
        timeout?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      // Validate required parameters
      if (action === "exec" && !command) {
        return {
          result: {
            content: "The 'command' parameter is required for 'exec' action.",
            status: "error" as const,
            exitCode: null,
            workingDir: "/home/user",
          },
        };
      }

      if (action === "send" && input === undefined) {
        return {
          result: {
            content: "The 'input' parameter is required for 'send' action.",
            status: "error" as const,
            exitCode: null,
            workingDir: "/home/user",
          },
        };
      }

      // Check guardrails for exec action
      if (action === "exec" && command) {
        const guardrailResult = checkCommandGuardrails(
          command,
          effectiveGuardrails,
        );
        if (!guardrailResult.allowed) {
          return {
            result: {
              content: `Command blocked by security guardrail "${guardrailResult.policyName}": ${guardrailResult.message}`,
              status: "error" as const,
              exitCode: null,
              workingDir: "/home/user",
            },
          };
        }

        // Check scope exclusions
        const scopeViolation = checkCommandScopeExclusion(
          command,
          exclusionsList,
        );
        if (scopeViolation) {
          return {
            result: {
              content: `Command blocked: Target "${scopeViolation.target}" is out of scope. It matches the scope exclusion pattern: ${scopeViolation.exclusion}`,
              status: "error" as const,
              exitCode: null,
              workingDir: "/home/user",
            },
          };
        }
      }

      const effectiveTimeout = Math.min(
        timeout && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
      );

      try {
        // Get sandbox
        const { sandbox } = await sandboxManager.getSandbox();

        // Ensure sandbox is ready
        try {
          await waitForSandboxReady(sandbox);
        } catch {
          // Reset and retry
          sandboxManager.setSandbox(null as never);
          const { sandbox: freshSandbox } = await sandboxManager.getSandbox();
          await waitForSandboxReady(freshSandbox);
          return executeAction(freshSandbox);
        }

        return executeAction(sandbox);

        async function executeAction(sandboxInstance: typeof sandbox) {
          // Ensure session manager is installed
          const installed = await ensureSessionManager(sandboxInstance);
          if (!installed) {
            return {
              result: {
                content:
                  "Failed to install session manager in sandbox. Please try again.",
                status: "error" as const,
                exitCode: null,
                workingDir: "/home/user",
              },
            };
          }

          const terminalSessionId = `session-${randomUUID()}`;
          let outputCounter = 0;
          let hasStreamedOutput = false;

          const createTerminalWriter = (output: string) => {
            if (output) {
              writer.write({
                type: "data-terminal",
                id: `${terminalSessionId}-${++outputCounter}`,
                data: { terminal: output, toolCallId },
              });
            }
          };

          // Parse streaming output from Python script
          const parseStreamOutput = (line: string): { output: string; final: boolean } | null => {
            if (line.startsWith("STREAM:")) {
              try {
                const data = JSON.parse(line.slice(7));
                if (data.type === "stream" && data.output) {
                  return { output: data.output, final: data.final || false };
                }
              } catch {
                // Ignore parse errors
              }
            }
            return null;
          };

          // Build tmux session name with chatId to avoid session reuse across different chats
          // Format: hackerai-{session}-{chatId}
          const tmuxSessionName = `hackerai-${session}-${chatId}`;

          // Build the session manager command based on action
          let sessionManagerCmd: string;

          switch (action) {
            case "view":
              sessionManagerCmd = `python3 ${SESSION_MANAGER_PATH} view ${escapeShellArg(tmuxSessionName)}`;
              break;

            case "exec":
              sessionManagerCmd = `python3 ${SESSION_MANAGER_PATH} exec ${escapeShellArg(tmuxSessionName)} ${escapeShellArg(command!)} ${effectiveTimeout}`;
              break;

            case "wait":
              sessionManagerCmd = `python3 ${SESSION_MANAGER_PATH} wait ${escapeShellArg(tmuxSessionName)} ${effectiveTimeout}`;
              break;

            case "send":
              sessionManagerCmd = `python3 ${SESSION_MANAGER_PATH} send ${escapeShellArg(tmuxSessionName)} ${escapeShellArg(input!)}`;
              break;

            case "kill":
              sessionManagerCmd = `python3 ${SESSION_MANAGER_PATH} kill ${escapeShellArg(tmuxSessionName)}`;
              break;
          }

          return new Promise((resolve) => {
            let resolved = false;

            // Handle abort signal
            const onAbort = () => {
              if (resolved) return;
              resolved = true;
              resolve({
                result: {
                  content: "Operation aborted by user",
                  status: "error" as const,
                  exitCode: null,
                  workingDir: "/home/user",
                },
              });
            };

            if (abortSignal?.aborted) {
              return resolve({
                result: {
                  content: "Operation aborted by user",
                  status: "error" as const,
                  exitCode: null,
                  workingDir: "/home/user",
                },
              });
            }

            abortSignal?.addEventListener("abort", onAbort, { once: true });

            // Calculate total timeout including buffer for session manager
            const totalTimeoutMs = (effectiveTimeout + 10) * 1000;

            const handler = createTerminalHandler(
              () => {
                // Not used directly - we use customStdoutHandler instead
              },
              {
                timeoutSeconds: effectiveTimeout + 10,
                onTimeout: () => {
                  if (resolved) return;
                  resolved = true;
                  handler.cleanup();
                  resolve({
                    result: {
                      content: `Session manager operation timed out after ${effectiveTimeout}s`,
                      status: "error" as const,
                      exitCode: null,
                      workingDir: "/home/user",
                    },
                  });
                },
              },
            );

            // Custom stdout handler that intercepts streaming output
            const customStdoutHandler = (data: string) => {
              // Process streaming lines
              const lines = data.split("\n");
              for (const line of lines) {
                const streamData = parseStreamOutput(line);
                if (streamData) {
                  hasStreamedOutput = true;
                  createTerminalWriter(streamData.output);
                }
              }
              // Also pass to original handler for timeout tracking
              handler.stdout(data);
            };

            const commonOptions = buildSandboxCommandOptions(sandboxInstance, {
              onStdout: customStdoutHandler,
              onStderr: handler.stderr,
            });

            // Execute the session manager command
            retryWithBackoff(
              () =>
                sandboxInstance.commands.run(sessionManagerCmd, {
                  ...commonOptions,
                  timeoutMs: totalTimeoutMs,
                }),
              {
                maxRetries: 3,
                baseDelayMs: 500,
                jitterMs: 50,
                isPermanentError: (error: unknown) => {
                  if (error instanceof Error) {
                    return (
                      error.name === "NotFoundError" ||
                      error.message.includes("not running anymore") ||
                      error.message.includes("signal:")
                    );
                  }
                  return false;
                },
                logger: () => {},
              },
            )
              .then((exec) => {
                handler.cleanup();
                abortSignal?.removeEventListener("abort", onAbort);

                if (resolved) return;
                resolved = true;

                // Filter out STREAM: lines from stdout before parsing JSON result
                const cleanStdout = exec.stdout
                  .split("\n")
                  .filter((line) => !line.startsWith("STREAM:"))
                  .join("\n");

                // Parse the result from session manager
                const parsedResult = parseSessionResult(
                  cleanStdout,
                  exec.stderr,
                );

                // Replace internal tmux session name with user-friendly name in messages
                const result = {
                  ...parsedResult,
                  content: parsedResult.content.replace(
                    new RegExp(tmuxSessionName, "g"),
                    session,
                  ),
                };

                // Only write final content if we haven't been streaming
                // (streaming already sent the content as deltas)
                if (result.content && !hasStreamedOutput) {
                  createTerminalWriter(result.content);
                }

                resolve({ result });
              })
              .catch((error) => {
                handler.cleanup();
                abortSignal?.removeEventListener("abort", onAbort);

                if (resolved) return;
                resolved = true;

                resolve({
                  result: {
                    content:
                      error instanceof Error
                        ? error.message
                        : "Unknown error occurred",
                    status: "error" as const,
                    exitCode: null,
                    workingDir: "/home/user",
                  },
                });
              });
          });
        }
      } catch (error) {
        return {
          result: {
            content:
              error instanceof Error
                ? error.message
                : "Failed to get sandbox instance",
            status: "error" as const,
            exitCode: null,
            workingDir: "/home/user",
          },
        };
      }
    },
  });
};
