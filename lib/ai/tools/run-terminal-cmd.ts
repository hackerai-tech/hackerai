import { tool } from "ai";
import { z } from "zod";
import { CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { TIMEOUT_MESSAGE } from "@/lib/token-utils";
import { saveTruncatedOutput } from "./utils/terminal-output-saver";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { terminateProcessReliably } from "./utils/process-termination";
import { findProcessPid } from "./utils/pid-discovery";
import { retryWithBackoff } from "./utils/retry-with-backoff";
import { waitForSandboxReady } from "./utils/sandbox-health";
import { buildSandboxCommandOptions } from "./utils/sandbox-command-options";
import {
  parseGuardrailConfig,
  getEffectiveGuardrails,
  checkCommandGuardrails,
} from "./utils/guardrails";

const DEFAULT_STREAM_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

export const createRunTerminalCmd = (context: ToolContext) => {
  const { sandboxManager, writer, backgroundProcessTracker, guardrailsConfig } =
    context;

  // Parse user guardrail configuration and get effective guardrails
  const userGuardrailConfig = parseGuardrailConfig(guardrailsConfig);
  const effectiveGuardrails = getEffectiveGuardrails(userGuardrailConfig);

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
      timeout: z
        .number()
        .optional()
        .default(DEFAULT_STREAM_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for command execution. On timeout, command continues running in background. Capped at ${MAX_TIMEOUT_SECONDS} seconds. Defaults to ${DEFAULT_STREAM_TIMEOUT_SECONDS} seconds.`,
        ),
    }),
    execute: async (
      {
        command,
        is_background,
        timeout,
      }: {
        command: string;
        is_background: boolean;
        timeout?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      // Calculate effective stream timeout (capped at MAX_TIMEOUT_SECONDS)
      // This controls how long we wait for output, not how long the command runs
      const effectiveStreamTimeout = Math.min(
        timeout ?? DEFAULT_STREAM_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
      );
      // Check guardrails before executing the command
      const guardrailResult = checkCommandGuardrails(
        command,
        effectiveGuardrails,
      );
      if (!guardrailResult.allowed) {
        return {
          result: {
            output: "",
            exitCode: 1,
            error: `Command blocked by security guardrail "${guardrailResult.policyName}": ${guardrailResult.message}. This command pattern has been blocked for safety. If you believe this is a false positive, the user can adjust guardrail settings.`,
          },
        };
      }

      try {
        // Get fresh sandbox and verify it's ready
        const { sandbox } = await sandboxManager.getSandbox();

        // Check for sandbox fallback and notify frontend
        const fallbackInfo = sandboxManager.consumeFallbackInfo?.();
        if (fallbackInfo?.occurred) {
          writer.write({
            type: "data-sandbox-fallback",
            id: `sandbox-fallback-${toolCallId}`,
            data: fallbackInfo,
          });
        }

        // Bail early if sandbox was already marked unavailable by any tool
        if (sandboxManager.isSandboxUnavailable()) {
          return {
            result: {
              output: "",
              exitCode: 1,
              error:
                "Sandbox is unavailable after repeated health check failures. Do NOT retry any terminal or sandbox commands. Inform the user that the sandbox could not be reached and suggest they wait a moment and try again, or delete the sandbox in Settings > Data Controls. If the issue persists, contact HackerAI support.",
            },
          };
        }

        try {
          await waitForSandboxReady(sandbox, 5, abortSignal);
          sandboxManager.resetHealthFailures();
        } catch (healthError) {
          // If aborted, don't retry - propagate the abort
          if (
            healthError instanceof DOMException &&
            healthError.name === "AbortError"
          ) {
            throw healthError;
          }

          const exceeded = sandboxManager.recordHealthFailure();
          if (exceeded) {
            console.error(
              "[Terminal Command] Sandbox health check failed too many times, marking unavailable",
            );
            return {
              result: {
                output: "",
                exitCode: 1,
                error:
                  "Sandbox is unavailable after repeated health check failures. Do NOT retry any terminal or sandbox commands. Inform the user that the sandbox could not be reached and suggest they wait a moment and try again, or delete the sandbox in Settings > Data Controls. If the issue persists, contact HackerAI support.",
              },
            };
          }

          // Sandbox health check failed - force recreation by resetting the cached instance
          console.warn(
            "[Terminal Command] Sandbox health check failed, recreating sandbox",
          );

          // Reset cached instance to force ensureSandboxConnection to create a fresh one
          sandboxManager.setSandbox(null as any);
          const { sandbox: freshSandbox } = await sandboxManager.getSandbox();

          // Verify the fresh sandbox is ready
          try {
            await waitForSandboxReady(freshSandbox, 5, abortSignal);
            sandboxManager.resetHealthFailures();
          } catch (freshHealthError) {
            if (
              freshHealthError instanceof DOMException &&
              freshHealthError.name === "AbortError"
            ) {
              throw freshHealthError;
            }
            sandboxManager.recordHealthFailure();
            return {
              result: {
                output: "",
                exitCode: 1,
                error:
                  "Sandbox recreation failed. The sandbox environment is not responding. Another attempt may be made but the sandbox will be marked unavailable after repeated failures.",
              },
            };
          }

          return executeCommand(freshSandbox);
        }

        return executeCommand(sandbox);

        async function executeCommand(sandboxInstance: typeof sandbox) {
          const terminalSessionId = `terminal-${randomUUID()}`;
          let outputCounter = 0;

          const createTerminalWriter = async (output: string) => {
            const part = {
              type: "data-terminal" as const,
              id: `${terminalSessionId}-${++outputCounter}`,
              data: { terminal: output, toolCallId },
            };
            // Only use writer: it already appends to the metadata stream. Calling appendMetadataStream
            // as well was causing every line to be sent twice and duplicated in the UI.
            writer.write(part);
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

              // Try to get PID from execution object first (cheap, no shell call)
              if (!processId && execution && (execution as any)?.pid) {
                processId = (execution as any).pid;
              }

              // Fall back to PID discovery via pgrep/ps for any command type
              if (!processId) {
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

            handler = createTerminalHandler(
              (output: string) => createTerminalWriter(output),
              {
                timeoutSeconds: effectiveStreamTimeout,
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

                  await createTerminalWriter(
                    TIMEOUT_MESSAGE(
                      effectiveStreamTimeout,
                      processId ?? undefined,
                    ),
                  );

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

            const commonOptions = buildSandboxCommandOptions(
              sandboxInstance,
              is_background
                ? undefined
                : {
                    onStdout: handler!.stdout,
                    onStderr: handler!.stderr,
                  },
            );

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
                    await createTerminalWriter(backgroundOutput);

                    const outputFiles =
                      BackgroundProcessTracker.extractOutputFiles(command);
                    backgroundProcessTracker.addProcess(
                      processId,
                      command,
                      outputFiles,
                    );
                  }

                  // Save full output to file when truncated (show path at top so AI sees it first)
                  let outputWithSaveInfo = finalResult.output || "";
                  if (!is_background && handler) {
                    const saveMsg = await saveTruncatedOutput({
                      handler,
                      sandbox: sandboxInstance,
                      terminalWriter: createTerminalWriter,
                    });
                    if (saveMsg) {
                      outputWithSaveInfo = saveMsg + "\n" + outputWithSaveInfo;
                    }
                  }

                  resolve({
                    result: is_background
                      ? {
                          pid: processId,
                          output: `Background process started with PID: ${processId ?? "unknown"}\n`,
                        }
                      : {
                          exitCode: 0,
                          output: outputWithSaveInfo,
                        },
                  });
                }
              })
              .catch(async (error) => {
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

                    // Save full output to file when truncated (show path at top so AI sees it first)
                    let outputWithSaveInfo = finalResult.output || "";
                    if (handler) {
                      const saveMsg = await saveTruncatedOutput({
                        handler,
                        sandbox: sandboxInstance,
                        terminalWriter: createTerminalWriter,
                      });
                      if (saveMsg) {
                        outputWithSaveInfo =
                          saveMsg + "\n" + outputWithSaveInfo;
                      }
                    }

                    resolve({
                      result: {
                        exitCode: error.exitCode,
                        output: outputWithSaveInfo,
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
