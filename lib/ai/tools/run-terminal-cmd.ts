import { tool, type Tool } from "ai";
import { CommandExitError } from "@e2b/code-interpreter";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { TIMEOUT_MESSAGE } from "@/lib/token-utils";
import { saveTruncatedOutput } from "./utils/terminal-output-saver";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { terminateProcessReliably } from "./utils/process-termination";
import { retryWithBackoff } from "./utils/retry-with-backoff";
import {
  waitForSandboxReady,
  getSandboxDiagnostics,
} from "./utils/sandbox-health";
import { isE2BSandbox, isCentrifugoSandbox } from "./utils/sandbox-types";
import {
  buildSandboxCommandOptions,
  augmentCommandPath,
} from "./utils/sandbox-command-options";
import { createE2BPtyHandle } from "./utils/e2b-pty-adapter";
import {
  createCommandSessionHandle,
  type CommandSessionHandle,
} from "./utils/command-session-handle";
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  type PtySession,
} from "./utils/pty-session-manager";
import { getSessionSnapshots } from "./utils/pty-output-formatter";
import {
  getSandboxWithFallbackGuard,
  resolveToolErrorMessage,
} from "./utils/sandbox-fallback";
import {
  waitForOutput,
  capOutput,
  stripAnsi,
  peekExited,
} from "./utils/pty-wait-utils";
import { captureAgentBrowserUsage } from "./utils/agent-browser-usage";
import {
  RUN_TERMINAL_DEFAULT_STREAM_TIMEOUT_SECONDS,
  RUN_TERMINAL_MAX_TIMEOUT_SECONDS,
  createRunTerminalCmdToolSchema,
} from "./schemas";

const DEFAULT_STREAM_TIMEOUT_SECONDS =
  RUN_TERMINAL_DEFAULT_STREAM_TIMEOUT_SECONDS;
const MAX_TIMEOUT_SECONDS = RUN_TERMINAL_MAX_TIMEOUT_SECONDS;
const NOISY_TIMEOUT_MIN_BUFFERED_CHARS = 256 * 1024;
// Once an interactive PTY emits its first bytes, treat `quietMs` of silence
// as "settled" (prompt drew, REPL banner finished, etc.). Lets `bash`/`python3`
// return in ~half a second instead of blocking the user-supplied timeout
// ceiling. The agent can follow up with action=wait/send.
const INTERACTIVE_QUIET_WINDOW_MS = 500;

type RunTerminalCmdInput = {
  command: string;
  brief?: string;
  justification?: string;
  prefix_rule?: string[];
  is_background: boolean;
  timeout?: number;
  interactive: boolean;
};

type E2BCommandHandle = {
  readonly pid: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  wait(): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  kill(): Promise<boolean>;
};

const TERMINATED_TIMEOUT_MESSAGE = (seconds: number, pid?: number) =>
  pid
    ? `\n\nCommand output paused after ${seconds} seconds and the noisy foreground process was terminated (PID: ${pid}).`
    : `\n\nCommand output paused after ${seconds} seconds and the noisy foreground process was terminated.`;

export const createRunTerminalCmd = (context: ToolContext) => {
  const {
    sandboxManager,
    writer,
    backgroundProcessTracker,
    ptySessionManager,
    chatId,
  } = context;
  const measureTerminalWait = <T>(operation: () => Promise<T>): Promise<T> =>
    context.measureAgentActiveTime
      ? context.measureAgentActiveTime("terminal_wait", operation)
      : operation();
  const measureSandboxRecovery = <T>(
    operation: () => Promise<T>,
  ): Promise<T> =>
    context.measureAgentActiveTime
      ? context.measureAgentActiveTime("sandbox_recovery", operation)
      : operation();
  const runTerminalCmdTool = createRunTerminalCmdToolSchema({
    approvalGated: !!context.requestToolApproval,
    // The conditional schema adds approval-only fields, but both branches
    // normalize to the same execution input handled below.
  }) as unknown as Tool<RunTerminalCmdInput, unknown>;

  return tool({
    ...runTerminalCmdTool,
    execute: async (
      {
        command,
        brief,
        justification,
        prefix_rule,
        is_background,
        timeout,
        interactive,
      }: RunTerminalCmdInput,
      { toolCallId, abortSignal },
    ) => {
      // PTY geometry is fixed server-side (DEFAULT_PTY_COLS / DEFAULT_PTY_ROWS).
      // The model intentionally has no knob for this — a terminal size should
      // match a real display, not a model-chosen value. UIs that render the
      // PTY can call `PtyHandle.resize()` directly.
      const cols = DEFAULT_PTY_COLS;
      const rows = DEFAULT_PTY_ROWS;

      // Helper: emit a raw-byte chunk to the UI terminal stream.
      // The `data-terminal` part shape in `UIMessageStreamWriter` only types
      // the minimal `{terminal, toolCallId}` fields, but the frontend
      // (`TerminalToolHandler`/`ComputerSidebar`) reads the extra `action`
      // and `session` fields at runtime. This cast is intentional — keep
      // the minimal typed surface while carrying the extra metadata.
      //
      // To keep emitTerminal fire-and-forget from sync onData callbacks while
      // preserving FIFO order of writer.write, we chain the write calls
      // through a per-invocation promise queue. Raw bytes are sent during
      // streaming; sessionSnapshot in the result is cleaned via xterm headless.
      //
      // `activePtySessionId` tracks the session id that should be attached
      // to data-terminal events. For interactive exec the id is only known
      // AFTER create, so the exec branch updates it before emitting anything.
      // Send raw bytes during streaming - sessionSnapshot in result is cleaned
      let activePtySessionId: string | undefined;
      let emitQueue: Promise<void> = Promise.resolve();
      const emitTerminal = (bytes: Uint8Array): void => {
        const emitSessionId = activePtySessionId;
        emitQueue = emitQueue
          .then(() => {
            const text = new TextDecoder().decode(bytes);
            writer.write({
              type: "data-terminal",
              id: `pty-${toolCallId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              data: {
                terminal: text,
                toolCallId,
                action: "exec",
                session: emitSessionId,
              } as unknown as { terminal: string; toolCallId: string },
            });
          })
          .catch((err) =>
            console.error("[run-terminal-cmd] emitTerminal failed:", err),
          );
      };
      const drainEmitQueue = () => emitQueue;
      // Calculate effective stream timeout (capped at MAX_TIMEOUT_SECONDS)
      // This controls how long we wait for output, not how long the command runs
      const effectiveStreamTimeout = Math.min(
        timeout ?? DEFAULT_STREAM_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
      );

      const approval = await context.requestToolApproval?.({
        toolCallId,
        toolName: "run_terminal_cmd",
        operation: "terminal_execute",
        target: command,
        brief,
        justification,
        prefixRule: prefix_rule,
      });
      if (approval && !approval.approved) {
        return {
          result: {
            output: "",
            exitCode: 1,
            error: approval.reason,
            approvalDenied: true,
          },
        };
      }

      // ─── Interactive PTY exec branch ─────────────────────────────────
      if (interactive) {
        try {
          const { sandbox } = await getSandboxWithFallbackGuard({
            sandboxManager,
          });
          const isCentrifugo = isCentrifugoSandbox(sandbox);
          const isE2B = isE2BSandbox(sandbox);

          if (!isE2B && !isCentrifugo) {
            return {
              result: {
                output: "",
                exitCode: 1,
                error:
                  "Interactive PTY requires E2B or local (Centrifugo) sandbox.",
              },
            };
          }

          const supportsCentrifugoPty =
            !isCentrifugo ||
            typeof sandbox.supportsPty !== "function" ||
            sandbox.supportsPty();

          if (!supportsCentrifugoPty) {
            return {
              result: {
                output: "",
                exitCode: 1,
                error:
                  "Interactive terminal sessions are unavailable on this local connection. Use non-interactive terminal commands instead.",
              },
            };
          }

          captureAgentBrowserUsage({
            context,
            command,
            sandbox,
            interactive: true,
            isBackground: false,
          });

          // Factory is invoked BY `ptySessionManager.create` — this ensures
          // that if the concurrency cap is hit, the factory is never called
          // and no PTY is spawned (see FIX 4).
          const session = await ptySessionManager.create(chatId, {
            cols,
            rows,
            createHandle: async () => {
              if (isCentrifugo) {
                const { createCentrifugoPtyHandle } =
                  await import("./utils/centrifugo-pty-adapter");
                return createCentrifugoPtyHandle(sandbox, {
                  command,
                  cols,
                  rows,
                });
              }
              return createE2BPtyHandle(sandbox, {
                cols,
                rows,
              });
            },
          });

          // Now that the session exists, tag subsequent data-terminal events
          // with its sessionId (was undefined at emitTerminal definition time).
          activePtySessionId = session.sessionId;

          // For E2B, the PTY starts a bare shell — fire the command + Enter
          // so the shell actually runs it. For Centrifugo, the command is
          // passed in pty_create and the local runner spawns it directly.
          if (!isCentrifugo) {
            await session.handle.sendInput(
              new TextEncoder().encode(command + "\n"),
            );
          }
          session.lastActivityAt = Date.now();

          // Stream output chunks as they arrive. Resolve early on a brief
          // quiet window so launching a REPL/shell returns when its prompt
          // finishes drawing rather than blocking the full timeout ceiling.
          const delta = await measureTerminalWait(() =>
            waitForOutput(
              session,
              effectiveStreamTimeout * 1000,
              abortSignal,
              emitTerminal,
              (s) => ptySessionManager.consumeDelta(s),
              { quietMs: INTERACTIVE_QUIET_WINDOW_MS },
            ),
          );
          await drainEmitQueue();
          const snapshots = await getSessionSnapshots(
            ptySessionManager,
            session,
          );
          // If the command finished during the quiet window (e.g. a one-shot
          // `echo … && whoami`), surface that so the agent doesn't try to
          // `interact_terminal_session send` against a dead session.
          const exited = await peekExited(session);
          return {
            result: {
              session: session.sessionId,
              pid: session.pid,
              output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
              sessionSnapshot: snapshots.cleaned,
              rawSnapshot: snapshots.raw,
              ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
              ...(exited ? { exited: { exitCode: exited.exitCode } } : {}),
            },
          };
        } catch (err) {
          return {
            result: {
              output: "",
              exitCode: 1,
              error: resolveToolErrorMessage(err),
            },
          };
        }
      }

      try {
        // Get fresh sandbox and verify it's ready
        const { sandbox } = await getSandboxWithFallbackGuard({
          sandboxManager,
        });

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

        // Only health-check E2B sandboxes — local sandboxes don't need it
        // (they relay commands through Convex and have their own connectivity)
        if (isE2BSandbox(sandbox)) {
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

            const recovery = await measureSandboxRecovery(async () => {
              // Sandbox health check failed - log diagnostics and wait briefly before recreating
              const diagnostics = await getSandboxDiagnostics(sandbox).catch(
                () => "diagnostics unavailable",
              );
              console.warn(
                `[Terminal Command] Sandbox health check failed (${diagnostics}), waiting before recreating sandbox`,
              );
              await new Promise((resolve) => setTimeout(resolve, 2000));

              // Reset cached instance to force ensureSandboxConnection to create a fresh one
              sandboxManager.setSandbox(null as any);
              const { sandbox: freshSandbox } =
                await getSandboxWithFallbackGuard({ sandboxManager });

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
                  ok: false as const,
                  response: {
                    result: {
                      output: "",
                      exitCode: 1,
                      error:
                        "Sandbox recreation failed. The sandbox environment is not responding. Another attempt may be made but the sandbox will be marked unavailable after repeated failures.",
                    },
                  },
                };
              }

              return { ok: true as const, sandbox: freshSandbox };
            });

            if (!recovery.ok) return recovery.response;
            return executeCommand(recovery.sandbox);
          }
        }

        return executeCommand(sandbox);

        async function executeCommand(sandboxInstance: typeof sandbox) {
          captureAgentBrowserUsage({
            context,
            command,
            sandbox: sandboxInstance,
            interactive: false,
            isBackground: is_background,
          });

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
            let commandSession: PtySession | null = null;
            let commandHandle: CommandSessionHandle | null = null;
            let commandSessionExposed = false;
            const commandAbortController = new AbortController();
            let cancelCentrifugoCommand: (() => Promise<boolean>) | null = null;
            let runPromise: Promise<{
              stdout: string;
              stderr: string;
              exitCode: number;
              pid?: number;
            }> | null = null;

            const forgetUnexposedCommandSession = () => {
              if (!commandSession || commandSessionExposed) return;
              ptySessionManager.forget(chatId, commandSession.sessionId);
            };

            const terminateManagedCommand = async (): Promise<boolean> => {
              if (isCentrifugoSandbox(sandboxInstance)) {
                if (cancelCentrifugoCommand) {
                  return cancelCentrifugoCommand();
                }
                if (!commandAbortController.signal.aborted) {
                  commandAbortController.abort();
                }
                if (!runPromise) return false;
                try {
                  const result = await runPromise;
                  return result.exitCode === 130;
                } catch {
                  return false;
                }
              }

              if (!processId && execution?.pid) {
                processId = execution.pid;
              }
              if (!processId && !execution?.kill) return false;
              if (processId) commandHandle?.setPid(processId);
              return terminateProcessReliably(
                sandboxInstance,
                execution,
                processId,
              );
            };

            const shouldTerminateNoisyTimedOutCommand = () => {
              if (is_background || !handler) return false;
              return (
                handler.wasTruncated() ||
                handler.wasFullOutputCapped() ||
                handler.getBufferedCharCount() >=
                  NOISY_TIMEOUT_MIN_BUFFERED_CHARS
              );
            };

            const logNoisyTimeout = (fields: {
              terminationAttempted: boolean;
              terminationSucceeded: boolean;
              processId: number | null;
              terminationError?: unknown;
            }) => {
              console.warn(
                JSON.stringify({
                  level: "warn",
                  event: "agent_terminal_noisy_timeout",
                  service: "chat-handler",
                  timestamp: new Date().toISOString(),
                  chat_id: chatId,
                  user_id: context.userID,
                  mode: context.mode,
                  subscription: context.subscription,
                  tool_call_id: toolCallId,
                  timeout_seconds: effectiveStreamTimeout,
                  output_chars_buffered: handler?.getBufferedCharCount() ?? 0,
                  output_truncated: handler?.wasTruncated() ?? false,
                  output_full_output_capped:
                    handler?.wasFullOutputCapped() ?? false,
                  sandbox_type:
                    sandboxManager.getSandboxType("run_terminal_cmd"),
                  pid: fields.processId ?? undefined,
                  termination_attempted: fields.terminationAttempted,
                  termination_succeeded: fields.terminationSucceeded,
                  termination_error:
                    fields.terminationError instanceof Error
                      ? fields.terminationError.message
                      : undefined,
                }),
              );
            };

            // Handle abort signal
            const onAbort = async () => {
              if (resolved) {
                return;
              }

              // Set resolved IMMEDIATELY to prevent race with retry logic
              // This must happen before we kill the process, otherwise the error
              // from the killed process might trigger retries
              resolved = true;
              // Keep the session addressable until termination is confirmed.
              // runPromise may settle before this async handler resumes.
              commandSessionExposed = true;

              let terminated = false;

              if (commandHandle) {
                try {
                  terminated = await terminateManagedCommand();
                  if (!terminated) {
                    console.warn(
                      "[Terminal Command] Managed command could not be terminated during abort",
                    );
                  }
                } catch (error) {
                  console.error(
                    "[Terminal Command] Error during managed command abort:",
                    error,
                  );
                }
              } else if (isCentrifugoSandbox(sandboxInstance) && runPromise) {
                try {
                  const executionResult = await runPromise;
                  terminated = executionResult.exitCode === 130;
                } catch {
                  terminated = false;
                }
              } else {
                // Try to get PID from execution object first (cheap, no shell call)
                if (!processId && execution && (execution as any)?.pid) {
                  processId = (execution as any).pid;
                }

                // Terminate the current process
                try {
                  if ((execution && execution.kill) || processId) {
                    terminated = await terminateProcessReliably(
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
              }

              // Clean up and resolve
              const result = handler
                ? handler.getResult(processId ?? undefined)
                : { output: "" };
              if (handler) {
                handler.cleanup();
              }

              if (terminated) {
                commandSessionExposed = false;
                forgetUnexposedCommandSession();
              }

              resolve({
                result: {
                  output: result.output,
                  exitCode: terminated ? 130 : null,
                  error: terminated
                    ? "Command execution aborted by user"
                    : "Command cancellation could not be confirmed. The local session was retained so termination can be retried.",
                  ...(!terminated && commandSession
                    ? { session: commandSession.sessionId }
                    : {}),
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
                  // Claim completion before any async PID/termination work so
                  // a command exiting at the timeout boundary cannot win the
                  // race and unregister the session we are about to return.
                  resolved = true;
                  if (commandSession) commandSessionExposed = true;

                  // Try to get PID from execution object first (if available)
                  if (!processId && execution && (execution as any)?.pid) {
                    processId = (execution as any).pid;
                  }

                  const terminateNoisyCommand =
                    shouldTerminateNoisyTimedOutCommand();

                  if (processId) commandHandle?.setPid(processId);

                  let terminationAttempted = false;
                  let terminationSucceeded = false;
                  let terminationError: unknown;
                  if (terminateNoisyCommand) {
                    terminationAttempted = Boolean(
                      commandHandle ||
                      (execution && execution.kill) ||
                      processId,
                    );
                    try {
                      if (terminationAttempted) {
                        terminationSucceeded = commandHandle
                          ? await terminateManagedCommand()
                          : await terminateProcessReliably(
                              sandboxInstance,
                              execution,
                              processId,
                            );
                      }
                    } catch (error) {
                      terminationError = error;
                    }
                    logNoisyTimeout({
                      terminationAttempted,
                      terminationSucceeded,
                      processId,
                      terminationError,
                    });
                  }

                  const commandTerminated =
                    terminateNoisyCommand && terminationSucceeded;
                  if (commandTerminated) {
                    commandSessionExposed = false;
                  }
                  const resumableSession = commandTerminated
                    ? undefined
                    : commandSession?.sessionId;
                  if (resumableSession) commandSessionExposed = true;
                  const timeoutMessage = commandTerminated
                    ? TERMINATED_TIMEOUT_MESSAGE(
                        effectiveStreamTimeout,
                        processId ?? undefined,
                      )
                    : TIMEOUT_MESSAGE(
                        effectiveStreamTimeout,
                        processId ?? undefined,
                        resumableSession,
                      );

                  await createTerminalWriter(timeoutMessage);

                  abortSignal?.removeEventListener("abort", onAbort);
                  const result = handler
                    ? handler.getResult(processId ?? undefined, {
                        timeoutMessage,
                      })
                    : { output: "" };
                  if (handler) {
                    handler.cleanup();
                  }
                  resolve({
                    result: {
                      output: result.output,
                      exitCode: commandTerminated ? 124 : null,
                      timedOut: true,
                      ...(resumableSession && {
                        session: resumableSession,
                        ...(processId ? { pid: processId } : {}),
                      }),
                      ...(commandTerminated && {
                        terminatedOnTimeout: true,
                      }),
                    },
                  });
                },
              },
            );

            // Register abort listener
            abortSignal?.addEventListener("abort", onAbort, { once: true });

            const commandSessionReady: Promise<void> = is_background
              ? Promise.resolve()
              : (() => {
                  commandHandle = createCommandSessionHandle({
                    kill: terminateManagedCommand,
                  });
                  return ptySessionManager
                    .create(chatId, {
                      cols,
                      rows,
                      kind: "command",
                      createHandle: async () => commandHandle!,
                    })
                    .then((session) => {
                      commandSession = session;
                    });
                })();

            const forwardCommandOutput = (output: string) => {
              void handler?.stdout(output);
              commandHandle?.emitText(output);
            };

            const commonOptions = buildSandboxCommandOptions(
              sandboxInstance,
              is_background
                ? undefined
                : {
                    onStdout: forwardCommandOutput,
                    onStderr: forwardCommandOutput,
                  },
            );
            const runOptions = isCentrifugoSandbox(sandboxInstance)
              ? {
                  ...commonOptions,
                  signal: is_background
                    ? abortSignal
                    : commandAbortController.signal,
                  onCancelReady: (cancel: () => Promise<boolean>) => {
                    cancelCentrifugoCommand = cancel;
                  },
                }
              : isE2BSandbox(sandboxInstance)
                ? { ...commonOptions, signal: abortSignal }
                : commonOptions;

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

            // Augment PATH for local sandboxes so user-installed tools
            // (e.g. ~/go/bin/waybackurls) are found without full paths.
            const effectiveCommand = augmentCommandPath(
              command,
              sandboxInstance,
            );

            const retryOptions = {
              maxRetries: 6,
              baseDelayMs: 500,
              jitterMs: 50,
              signal: abortSignal,
              isPermanentError: (error: unknown) =>
                resolved || isPermanentError(error),
              // Retry logs are too noisy - they're expected behavior
              logger: () => {},
            };

            // Execute command with retry logic for transient failures
            // Sandbox readiness already checked, so these retries handle race conditions
            // Retries: 6 attempts with exponential backoff (500ms, 1s, 2s, 4s, 8s, 16s) + jitter (±50ms)
            runPromise = commandSessionReady.then(async () => {
              if (resolved || abortSignal?.aborted) {
                return { stdout: "", stderr: "", exitCode: 130 };
              }

              if (is_background) {
                return retryWithBackoff(async () => {
                  const result = await sandboxInstance.commands.run(
                    effectiveCommand,
                    {
                      ...runOptions,
                      background: true,
                    },
                  );
                  return {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode ?? 0,
                    pid: (result as { pid?: number }).pid,
                  };
                }, retryOptions);
              }

              if (isE2BSandbox(sandboxInstance)) {
                // E2B's foreground `run()` only returns after exit, so it
                // cannot provide identity while a command is still running.
                // Start it through the SDK's background handle, retain that
                // exact handle/PID for lifecycle operations, then wait here
                // to preserve foreground behavior for the caller.
                const started = (await retryWithBackoff(
                  () =>
                    sandboxInstance.commands.run(effectiveCommand, {
                      ...runOptions,
                      background: true,
                    }),
                  retryOptions,
                )) as unknown as E2BCommandHandle;
                execution = started;
                processId = started.pid;
                commandHandle?.setPid(started.pid);
                const result = await measureTerminalWait(() => started.wait());
                return { ...result, pid: started.pid };
              }

              return measureTerminalWait(() =>
                retryWithBackoff(
                  () =>
                    sandboxInstance.commands.run(effectiveCommand, runOptions),
                  retryOptions,
                ),
              );
            });

            runPromise
              .then(async (exec) => {
                execution = exec;

                if (exec?.pid) {
                  processId = exec.pid;
                  commandHandle?.setPid(exec.pid);
                }
                commandHandle?.resolveExit(exec.exitCode ?? 0);

                if (handler) {
                  handler.cleanup();
                }

                if (!resolved) {
                  forgetUnexposedCommandSession();
                  resolved = true;
                  abortSignal?.removeEventListener("abort", onAbort);
                  const finalResult = handler
                    ? handler.getResult(processId ?? undefined)
                    : { output: "" };
                  const sandboxOutput = [exec.stdout, exec.stderr]
                    .filter(Boolean)
                    .join("\n");

                  // Track background processes with their output files
                  if (is_background && processId) {
                    const backgroundOutput = `Detached background process started with PID: ${processId}. No reusable terminal session was created; do not pass this PID to interact_terminal_session.\n`;
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
                  let outputWithSaveInfo =
                    finalResult.output || sandboxOutput || "";
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
                          resumable: false,
                          output: `Detached background process started with PID: ${processId ?? "unknown"}. No reusable terminal session was created; do not pass this PID to interact_terminal_session.\n`,
                        }
                      : {
                          exitCode: exec.exitCode ?? 0,
                          output: outputWithSaveInfo,
                          error:
                            exec.exitCode === -1 && exec.stderr
                              ? exec.stderr
                              : undefined,
                        },
                  });
                } else {
                  // Abort/noisy-timeout paths do not expose a resumable
                  // session, so discard their bookkeeping once execution
                  // eventually settles. Exposed timeout sessions stay
                  // available for wait/view until stream cleanup.
                  forgetUnexposedCommandSession();
                }
              })
              .catch(async (error) => {
                commandHandle?.resolveExit(
                  error instanceof CommandExitError ? error.exitCode : null,
                );
                if (handler) {
                  handler.cleanup();
                }
                if (!resolved) {
                  forgetUnexposedCommandSession();
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
                } else {
                  forgetUnexposedCommandSession();
                }
              });
          });
        } // end of executeCommand
      } catch (error) {
        return {
          result: {
            exitCode: error instanceof CommandExitError ? error.exitCode : 1,
            output: "",
            error: resolveToolErrorMessage(error),
          },
        };
      }
    },
    // For interactive PTY results, strip rawSnapshot from what the model
    // sees — the agent only needs the cleaned `output` plus structural
    // fields. rawSnapshot stays in the persisted tool result so the
    // sidebar's xterm renderer can replay it. No-op for non-interactive
    // results, which never include rawSnapshot.
    toModelOutput({ output }) {
      if (typeof output !== "object" || output === null) {
        return { type: "text", value: String(output ?? "") };
      }
      const result = (output as { result?: unknown }).result;
      if (typeof result !== "object" || result === null) {
        return { type: "text", value: JSON.stringify(output) };
      }
      const { rawSnapshot: _rawSnapshot, ...rest } = result as Record<
        string,
        unknown
      >;
      return { type: "text", value: JSON.stringify({ result: rest }) };
    },
  });
};
