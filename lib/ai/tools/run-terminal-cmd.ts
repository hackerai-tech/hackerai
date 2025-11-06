import { tool } from "ai";
import { z } from "zod";
import { CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { TIMEOUT_MESSAGE } from "@/lib/token-utils";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { terminateProcessReliably } from "./utils/process-termination";
import { findProcessPid } from "./utils/pid-discovery";
import { retryWithBackoff } from "./utils/retry-with-backoff";
import { waitForSandboxReady } from "./utils/sandbox-health";

const MAX_COMMAND_EXECUTION_TIME = 6 * 60 * 1000; // 6 minutes
const STREAM_TIMEOUT_SECONDS = 60;

export const createRunTerminalCmd = (context: ToolContext) => {
  const { sandboxManager, writer, backgroundProcessTracker } = context;

  return tool({
    description: `PROPOSE a command to run on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly on the USER's system.
Note that the user may have to approve the command before it is executed.
The user may reject it if it is not to their liking, or may modify the command before approving it.  If they do change it, take those changes into account.
In using these tools, adhere to the following guidelines:
1. Based on the contents of the conversation, you will be told if you are in the same shell as a previous step or a different shell.
2. If in a new shell, you should \`cd\` to the appropriate directory and do necessary setup in addition to running the command. By default, the shell will initialize in the project root.
3. If in the same shell, LOOK IN CHAT HISTORY for your current working directory.
4. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
5. If the command would use a pager, append \` | cat\` to the command.
6. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command. Background processes are automatically tracked with their PIDs and output files, so you'll be informed when the process completes before accessing output files. EXCEPTION: Never use background mode if you plan to retrieve the output file immediately afterward.
7. Dont include any newlines in the command.
8. For complex and long-running scans (e.g., nmap, dirb, gobuster), save results to files using appropriate output flags (e.g., -oN for nmap) if the tool supports it, otherwise use redirect with > operator for future reference and documentation.
9. Avoid commands with excessive output; redirect to files when necessary.
10. After creating files that the user needs (reports, scan results, generated documents), use the get_terminal_files tool to share them as downloadable attachments.`,
    inputSchema: z.object({
      command: z.string().describe("The terminal command to execute"),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
      is_background: z
        .boolean()
        .describe(
          "Whether the command should be run in the background. Set to FALSE if you need to retrieve output files immediately after with get_terminal_files. Only use TRUE for indefinite processes where you don't need immediate file access.",
        ),
    }),
    execute: async (
      {
        command,
        is_background,
      }: {
        command: string;
        is_background: boolean;
      },
      { toolCallId, abortSignal },
    ) => {
      try {
        const { sandbox } = await sandboxManager.getSandbox();

        // Wait for sandbox to be ready before executing commands
        // This prevents wasting retry attempts on a sandbox that's being recreated
        await waitForSandboxReady(sandbox);

        const terminalSessionId = `terminal-${randomUUID()}`;
        let outputCounter = 0;

        const createTerminalWriter = (output: string) => {
          writer.write({
            type: "data-terminal",
            id: `${terminalSessionId}-${++outputCounter}`,
            data: { terminal: output, toolCallId },
          });
        };

        return new Promise((resolve, reject) => {
          let resolved = false;
          let execution: any = null;
          let handler: ReturnType<typeof createTerminalHandler> | null = null;
          let processId: number | null = null; // Store PID for all processes

          // Handle abort signal
          const onAbort = async () => {
            if (resolved) {
              return;
            }

            // Set resolved IMMEDIATELY to prevent race with retry logic
            // This must happen before we kill the process, otherwise the error
            // from the killed process might trigger retries
            resolved = true;

            // For foreground commands, attempt to discover PID if not already known
            if (!processId && !is_background) {
              processId = await findProcessPid(sandbox, command);
            }

            // Terminate the current process
            try {
              if ((execution && execution.kill) || processId) {
                await terminateProcessReliably(sandbox, execution, processId);
              } else {
                console.warn(
                  "[Terminal Command] Cannot kill process: no execution handle or PID available",
                );
              }
            } catch (error) {
              console.error(
                "[Terminal Command] Error during abort termination:",
                error,
              );
            }

            // Clean up and resolve
            const result = handler ? handler.getResult() : { output: "" };
            if (handler) {
              handler.cleanup();
            }

            resolve({
              result: {
                output: result.output,
                exitCode: 130, // Standard SIGINT exit code
                error: "Command execution aborted by user",
              },
            });
          };

          // Check if already aborted before starting
          if (abortSignal?.aborted) {
            return resolve({
              result: {
                output: "",
                exitCode: 130,
                error: "Command execution aborted by user",
              },
            });
          }

          handler = createTerminalHandler(
            (output) => createTerminalWriter(output),
            {
              timeoutSeconds: STREAM_TIMEOUT_SECONDS,
              onTimeout: async () => {
                if (resolved) {
                  return;
                }

                createTerminalWriter(TIMEOUT_MESSAGE(STREAM_TIMEOUT_SECONDS));

                // For foreground commands, attempt to discover PID if not already known
                if (!processId && !is_background) {
                  processId = await findProcessPid(sandbox, command);
                }

                // Attempt to kill the running process on timeout
                if ((execution && execution.kill) || processId) {
                  try {
                    await terminateProcessReliably(
                      sandbox,
                      execution,
                      processId,
                    );
                  } catch (error) {
                    console.error(
                      "[Terminal Command] Error during timeout termination:",
                      error,
                    );
                  }
                }

                resolved = true;
                const result = handler ? handler.getResult() : { output: "" };
                if (handler) {
                  handler.cleanup();
                }
                resolve({
                  result: { output: result.output, exitCode: null },
                });
              },
            },
          );

          // Register abort listener
          abortSignal?.addEventListener("abort", onAbort, { once: true });

          const commonOptions = {
            timeoutMs: MAX_COMMAND_EXECUTION_TIME,
            user: "root" as const,
            cwd: "/home/user",
            ...(is_background
              ? {}
              : {
                  onStdout: handler!.stdout,
                  onStderr: handler!.stderr,
                }),
          };

          // Determine if an error is a permanent command failure (don't retry)
          // vs a transient sandbox issue (do retry)
          const isPermanentError = (error: unknown): boolean => {
            // Command exit errors are permanent (command ran but failed)
            if (error instanceof CommandExitError) {
              return true;
            }

            if (error instanceof Error) {
              // Signal errors (like "signal: killed") are permanent - they occur when
              // a process is terminated externally (e.g., by our abort handler).
              // We must not retry these as the termination was intentional.
              if (error.message.includes("signal:")) {
                return true;
              }

              // Sandbox termination errors are permanent
              return (
                error.name === "NotFoundError" ||
                error.message.includes("not running anymore") ||
                error.message.includes("Sandbox not found")
              );
            }

            return false;
          };

          // Execute command with retry logic for transient failures
          // Sandbox readiness already checked, so these retries handle race conditions
          // Retries: 6 attempts with exponential backoff (500ms, 1s, 2s, 4s, 8s, 16s) + jitter (±50ms)
          const runPromise = is_background
            ? retryWithBackoff(
                () =>
                  sandbox.commands.run(command, {
                    ...commonOptions,
                    background: true,
                  }),
                {
                  maxRetries: 6,
                  baseDelayMs: 500,
                  jitterMs: 50,
                  isPermanentError,
                  logger: (message, error) => {
                    // Don't log if we've already resolved via abort handler
                    if (!resolved) {
                      console.warn(`[Terminal Command] ${message}`, error);
                    }
                  },
                },
              )
            : retryWithBackoff(
                () => sandbox.commands.run(command, commonOptions),
                {
                  maxRetries: 6,
                  baseDelayMs: 500,
                  jitterMs: 50,
                  isPermanentError,
                  logger: (message, error) => {
                    // Don't log if we've already resolved via abort handler
                    if (!resolved) {
                      console.warn(`[Terminal Command] ${message}`, error);
                    }
                  },
                },
              );

          runPromise
            .then(async (exec) => {
              execution = exec;

              // Capture PID for background processes
              if (is_background && (exec as any)?.pid) {
                processId = (exec as any).pid;
              }

              if (handler) {
                handler.cleanup();
              }

              if (!resolved) {
                resolved = true;
                abortSignal?.removeEventListener("abort", onAbort);
                const finalResult = handler
                  ? handler.getResult()
                  : { output: "" };

                // Track background processes with their output files
                if (is_background && processId) {
                  const backgroundOutput = `Background process started with PID: ${processId}\n`;
                  createTerminalWriter(backgroundOutput);

                  const outputFiles =
                    BackgroundProcessTracker.extractOutputFiles(command);
                  backgroundProcessTracker.addProcess(
                    processId,
                    command,
                    outputFiles,
                  );
                }

                resolve({
                  result: is_background
                    ? {
                        pid: processId,
                        output: `Background process started with PID: ${processId ?? "unknown"}\n`,
                      }
                    : {
                        exitCode: 0,
                        output: finalResult.output,
                      },
                });
              }
            })
            .catch((error) => {
              if (handler) {
                handler.cleanup();
              }
              if (!resolved) {
                resolved = true;
                abortSignal?.removeEventListener("abort", onAbort);
                // Handle CommandExitError as a valid result (non-zero exit code)
                if (error instanceof CommandExitError) {
                  const finalResult = handler
                    ? handler.getResult()
                    : { output: "" };
                  resolve({
                    result: {
                      exitCode: error.exitCode,
                      output: finalResult.output,
                      error: error.message,
                    },
                  });
                } else {
                  reject(error);
                }
              }
            });
        });
      } catch (error) {
        return error as CommandExitError;
      }
    },
  });
};
