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

const MAX_COMMAND_EXECUTION_TIME = 7 * 60 * 1000; // 7 minutes
const STREAM_TIMEOUT_SECONDS = 60;

export const createRunTerminalCmd = (context: ToolContext) => {
  const { sandboxManager, writer, backgroundProcessTracker, isE2BSandbox } =
    context;

  // Wait instructions for E2B sandbox (local sandbox uses different commands)
  const waitForProcessInstruction = `To wait for a background process to complete, use \`tail --pid=<pid> -f /dev/null\`. This will block until the process exits. Example workflow: Start scan with is_background=true (returns PID 12345) → Wait with \`tail --pid=12345 -f /dev/null\``;

  const timeoutWaitInstruction = `If a foreground command times out after 60 seconds but is still running and producing results (you'll see the timeout message), the process continues in the background. To wait for it: 1) Note the PID from the error/timeout message or use \`ps aux | grep <command_name>\` to find it, 2) Use \`tail --pid=<pid> -f /dev/null\` to wait for completion. This is common for long scans like comprehensive nmap, sqlmap, or nuclei scans.`;

  return tool({
    description: `Execute a command on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly in the sandbox environment.
Commands execute immediately without requiring user approval.
In using these tools, adhere to the following guidelines:
1. Use command chaining and pipes for efficiency:
   - Chain commands with \`&&\` to execute multiple commands together and handle errors cleanly (e.g., \`cd /app && npm install && npm start\`)
   - Use pipes \`|\` to pass outputs between commands and simplify workflows (e.g., \`cat log.txt | grep error | wc -l\`)
2. NEVER run code directly via interpreter inline commands (like \`python3 -c "..."\` or \`node -e "..."\`). ALWAYS save code to a file first, then execute the file.
3. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
4. If the command would use a pager, append \` | cat\` to the command.
5. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command. EXCEPTION: Never use background mode if you plan to retrieve the output file immediately afterward.
  - ${waitForProcessInstruction}
  - ${timeoutWaitInstruction}
6. Dont include any newlines in the command.
7. Handle large outputs and save scan results to files:
  - For complex and long-running scans (e.g., nmap, dirb, gobuster), save results to files using appropriate output flags (e.g., -oN for nmap) if the tool supports it, otherwise use redirect with > operator.
  - For large outputs (>10KB expected: sqlmap --dump, nmap -A, nikto full scan):
    - Pipe to file: \`sqlmap ... 2>&1 | tee sqlmap_output.txt\`
    - Extract relevant information: \`grep -E "password|hash|Database:" sqlmap_output.txt\`
    - Anti-pattern: Never let full verbose output return to context (causes overflow)
  - Always redirect excessive output to files to avoid context overflow.
8. Install missing tools when needed: Use \`apt install tool\` or \`pip install package\` (no sudo needed in container).
9. After creating files that the user needs (reports, scan results, generated documents), use the get_terminal_files tool to share them as downloadable attachments.
10. For pentesting tools, always use time-efficient flags and targeted scans to keep execution under 7 minutes (e.g., targeted ports for nmap, small wordlists for fuzzing, specific templates for nuclei, vulnerable-only enumeration for wpscan). Timeout handling: On timeout → reduce scope, break into smaller operations.
11. When users make vague requests (e.g., "do recon", "scan this", "check security"), start with fast, lightweight tools and quick scans to provide initial results quickly. Use comprehensive/deep scans only when explicitly requested or after initial findings warrant deeper investigation.

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
        // Get fresh sandbox and verify it's ready
        const { sandbox } = await sandboxManager.getSandbox();

        try {
          await waitForSandboxReady(sandbox);
        } catch (healthError) {
          // Sandbox health check failed - force recreation by resetting the cached instance
          console.warn(
            "[Terminal Command] Sandbox health check failed, recreating sandbox",
          );

          // Reset cached instance to force ensureSandboxConnection to create a fresh one
          sandboxManager.setSandbox(null as any);
          const { sandbox: freshSandbox } = await sandboxManager.getSandbox();

          // Verify the fresh sandbox is ready
          await waitForSandboxReady(freshSandbox);

          return executeCommand(freshSandbox);
        }

        return executeCommand(sandbox);

        async function executeCommand(sandboxInstance: typeof sandbox) {
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
                processId = await findProcessPid(sandboxInstance, command);
              }

              // Terminate the current process
              try {
                if ((execution && execution.kill) || processId) {
                  await terminateProcessReliably(
                    sandboxInstance,
                    execution,
                    processId,
                  );
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
              const result = handler
                ? handler.getResult(processId ?? undefined)
                : { output: "" };
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

            // For tail --pid commands (used to wait for processes), use MAX_COMMAND_EXECUTION_TIME
            // instead of STREAM_TIMEOUT_SECONDS since they're designed to wait for long-running processes
            const isWaitCommand = command.trim().startsWith("tail --pid");
            const streamTimeout = isWaitCommand
              ? Math.floor(MAX_COMMAND_EXECUTION_TIME / 1000)
              : STREAM_TIMEOUT_SECONDS;

            // Extract PID from tail --pid command for user-friendly messages
            let waitingForPid: number | null = null;
            if (isWaitCommand) {
              const pidMatch = command.match(/tail\s+--pid[=\s]+(\d+)/);
              if (pidMatch) {
                waitingForPid = parseInt(pidMatch[1], 10);
                createTerminalWriter(
                  `Waiting for process ${waitingForPid} to complete...\n`,
                );
              }
            }

            handler = createTerminalHandler(
              (output) => createTerminalWriter(output),
              {
                timeoutSeconds: streamTimeout,
                onTimeout: async () => {
                  if (resolved) {
                    return;
                  }

                  // Try to get PID from execution object first (if available)
                  if (!processId && execution && (execution as any)?.pid) {
                    processId = (execution as any).pid;
                  }

                  // For foreground commands on stream timeout, try to discover PID for user reference
                  // DO NOT kill the process - it may still be working and saving to files
                  // The process has its own MAX_COMMAND_EXECUTION_TIME timeout via commonOptions
                  if (!processId && !is_background) {
                    processId = await findProcessPid(sandboxInstance, command);
                  }

                  // Only show "continues in background" for STREAM_TIMEOUT_SECONDS (60s)
                  // For MAX_COMMAND_EXECUTION_TIME (10min), the process is killed by e2b
                  const isContinuingInBackground =
                    streamTimeout === STREAM_TIMEOUT_SECONDS;

                  if (isContinuingInBackground) {
                    createTerminalWriter(
                      TIMEOUT_MESSAGE(streamTimeout, processId ?? undefined),
                    );
                  } else {
                    // Max execution time reached - process will be killed by e2b
                    createTerminalWriter(
                      `\n\nCommand timed out after ${streamTimeout} seconds and was terminated.`,
                    );
                  }

                  resolved = true;
                  const result = handler
                    ? handler.getResult(processId ?? undefined)
                    : { output: "" };
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
              // E2B specific: run as root with /home/user as working directory
              // This allows network tools (ping, nmap, etc.) to work without sudo
              // We check at runtime because HybridSandboxManager may fallback to E2B
              ...(isE2BSandbox(sandboxInstance) && {
                user: "root" as const,
                cwd: "/home/user",
              }),
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
            const runPromise: Promise<{
              stdout: string;
              stderr: string;
              exitCode: number;
              pid?: number;
            }> = is_background
              ? retryWithBackoff(
                  async () => {
                    const result = await sandboxInstance.commands.run(command, {
                      ...commonOptions,
                      background: true,
                    });
                    // Normalize the result to include exitCode
                    return {
                      stdout: result.stdout,
                      stderr: result.stderr,
                      exitCode: result.exitCode ?? 0,
                      pid: (result as { pid?: number }).pid,
                    };
                  },
                  {
                    maxRetries: 6,
                    baseDelayMs: 500,
                    jitterMs: 50,
                    isPermanentError,
                    // Retry logs are too noisy - they're expected behavior
                    logger: () => {},
                  },
                )
              : retryWithBackoff(
                  () => sandboxInstance.commands.run(command, commonOptions),
                  {
                    maxRetries: 6,
                    baseDelayMs: 500,
                    jitterMs: 50,
                    isPermanentError,
                    // Retry logs are too noisy - they're expected behavior
                    logger: () => {},
                  },
                );

            runPromise
              .then(async (exec) => {
                execution = exec;

                // Capture PID for background processes
                if (is_background && exec?.pid) {
                  processId = exec.pid;
                }

                if (handler) {
                  handler.cleanup();
                }

                if (!resolved) {
                  resolved = true;
                  abortSignal?.removeEventListener("abort", onAbort);
                  const finalResult = handler
                    ? handler.getResult(processId ?? undefined)
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

                  // Add completion message for tail --pid commands
                  if (waitingForPid) {
                    createTerminalWriter(
                      `Process ${waitingForPid} completed\n`,
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
                      ? handler.getResult(processId ?? undefined)
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
        } // end of executeCommand
      } catch (error) {
        return error as CommandExitError;
      }
    },
  });
};
