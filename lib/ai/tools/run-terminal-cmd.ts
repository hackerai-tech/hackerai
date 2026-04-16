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
import {
  waitForSandboxReady,
  getSandboxDiagnostics,
} from "./utils/sandbox-health";
import { isE2BSandbox } from "./utils/sandbox-types";
import {
  buildSandboxCommandOptions,
  augmentCommandPath,
} from "./utils/sandbox-command-options";
import {
  parseGuardrailConfig,
  getEffectiveGuardrails,
  checkCommandGuardrails,
} from "./utils/guardrails";
import { getCaidoConfig, buildCaidoProxyEnvVars } from "./utils/caido-proxy";
import { ensureCaido } from "./utils/proxy-manager";
import { createE2BPtyHandle } from "./utils/e2b-pty-adapter";
import type { PtySession } from "./utils/pty-session-manager";
import { translateInput } from "./utils/pty-keys";

const DEFAULT_STREAM_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

// ─── Interactive PTY constants ──────────────────────────────────────────
// Plan: /Users/fkesheh/.claude/plans/fluffy-splashing-hoare.md ("Limits" section)
export const MAX_INPUT_BYTES_PER_SEND = 8 * 1024;
export const MODEL_OUTPUT_CAP_BYTES = 8 * 1024;
const DEFAULT_WAIT_IDLE_MS = 800;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

// Strip CSI + OSC ANSI escape sequences from model-facing output. Keeping a
// small inline helper avoids pulling in `strip-ansi` which isn't currently a
// dep. UI-side consumers still get the raw bytes via `data-terminal` events.
 
const ANSI_REGEX =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;
const stripAnsi = (text: string): string => text.replace(ANSI_REGEX, "");

interface WaitPolicy {
  pattern?: string;
  idle_ms: number;
  timeout_ms: number;
}

/**
 * Thrown by `waitForOutput` when `policy.pattern` cannot be compiled to a
 * RegExp. Callers translate this into a structured tool error rather than
 * letting the JS SyntaxError bubble out of `execute()`.
 */
export class InvalidWaitPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWaitPatternError";
  }
}

/**
 * Resolve once any of:
 *   - `policy.pattern` matches the ANSI-stripped accumulated delta (if set)
 *   - `policy.idle_ms` of no new onData chunks (if pattern unset)
 *   - `policy.timeout_ms` absolute cap
 *   - `signal` aborts
 *
 * Streams every raw chunk through `onChunk` for the UI writer before
 * consuming the session delta and returning.
 *
 * Throws `InvalidWaitPatternError` synchronously if `policy.pattern` is set
 * but cannot be compiled. We throw BEFORE any timers / listeners are armed
 * so nothing needs to be cleaned up on the error path.
 */
async function waitForOutput(
  session: PtySession,
  policy: WaitPolicy,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => void,
  consume: (s: PtySession) => Uint8Array,
): Promise<Uint8Array> {
  // Compile the regex FIRST so invalid patterns surface as a synchronous
  // throw before any timers or listeners are armed — nothing to clean up.
  let regex: RegExp | null = null;
  if (policy.pattern) {
    try {
      regex = new RegExp(policy.pattern);
    } catch (err) {
      throw new InvalidWaitPatternError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return new Promise<Uint8Array>((resolve) => {
    let settled = false;
    let accumulated = "";
    const decoder = new TextDecoder();

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimer = setTimeout(() => finish(), policy.timeout_ms);

    const armIdle = () => {
      if (regex) return; // pattern mode doesn't use idle timer
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), policy.idle_ms);
    };

    const unsubscribe = session.handle.onData((bytes) => {
      if (settled) return;
      try {
        onChunk(bytes);
      } catch {
        // UI emit is best-effort
      }
      if (regex) {
        accumulated += stripAnsi(decoder.decode(bytes, { stream: true }));
        if (regex.test(accumulated)) {
          finish();
          return;
        }
      } else {
        armIdle();
      }
    });

    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish() {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        unsubscribe();
      } catch {
        // ignore
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(consume(session));
    }

    // Arm the idle timer up front — covers the case where no new bytes arrive
    // at all, which is still a valid "idle resolve" outcome.
    if (!regex) armIdle();
  });
}

/** Truncate model-visible output with a head/tail marker. */
function capOutput(text: string): string {
  if (text.length <= MODEL_OUTPUT_CAP_BYTES) return text;
  const head = Math.floor(MODEL_OUTPUT_CAP_BYTES * 0.7);
  const tail = MODEL_OUTPUT_CAP_BYTES - head - 64;
  return (
    text.slice(0, head) +
    `\n…[truncated ${text.length - head - tail} bytes]…\n` +
    text.slice(-tail)
  );
}

/**
 * Peek at `session.handle.exited` without blocking. Returns the resolved
 * value if already settled, otherwise `null`.
 */
async function peekExited(
  session: PtySession,
): Promise<{ exitCode: number | null } | null> {
  const sentinel: { exitCode: number | null } = { exitCode: -0xdeadbeef };
  const result = await Promise.race([
    session.handle.exited,
    new Promise<typeof sentinel>((r) => {
      // Queue a microtask — if `exited` is already settled it'll win the race.
      Promise.resolve().then(() => r(sentinel));
    }),
  ]);
  if (result === sentinel) return null;
  return result;
}

export const createRunTerminalCmd = (context: ToolContext) => {
  const {
    sandboxManager,
    writer,
    backgroundProcessTracker,
    guardrailsConfig,
    caidoEnabled,
    caidoPort,
    ptySessionManager,
    chatId,
  } = context;

  // Parse user guardrail configuration and get effective guardrails
  const userGuardrailConfig = parseGuardrailConfig(guardrailsConfig);
  const effectiveGuardrails = getEffectiveGuardrails(userGuardrailConfig);

  // Caido proxy env vars — injected into every command on non-E2B sandboxes when enabled.
  // Permanently disabled on first setup failure (e.g. Windows sandbox) to avoid
  // retrying and logging warnings on every subsequent command.
  const caidoConfig = getCaidoConfig(caidoPort);
  let caidoEnvVars = caidoEnabled
    ? buildCaidoProxyEnvVars(caidoConfig)
    : undefined;

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
12. When searching for text in files, prefer using \`rg\` (ripgrep) because it is much faster than alternatives like \`grep\`. When searching for files by name, prefer \`rg --files\` or \`find\`. If the \`rg\` command is not found, fall back to \`grep\` or \`find\`.
   - To read files, prefer the file tool over \`cat\`/\`head\`/\`tail\` when practical.

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
        .enum(["exec", "wait", "send", "kill", "view"])
        .default("exec")
        .describe(
          "exec=run new command (default). wait=wait for output from existing interactive session. send=send keystrokes to existing session (raw input — NOT filtered by command guardrails). kill=terminate session. view=snapshot current buffer without advancing the read cursor.",
        ),
      command: z
        .string()
        .optional()
        .describe("The terminal command to execute. Required for action=exec."),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
      is_background: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Whether the command should be run in the background. Set to FALSE if you need to retrieve output files immediately after with get_terminal_files. Only use TRUE for indefinite processes where you don't need immediate file access. Ignored unless action=exec and interactive=false.",
        ),
      timeout: z
        .number()
        .optional()
        .default(DEFAULT_STREAM_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for command execution. On timeout, command continues running in background. Capped at ${MAX_TIMEOUT_SECONDS} seconds. Defaults to ${DEFAULT_STREAM_TIMEOUT_SECONDS} seconds. Only applies to non-interactive exec.`,
        ),
      session: z
        .string()
        .optional()
        .describe(
          "Session id returned by a prior exec with interactive=true. Required for action in {wait, send, kill, view}.",
        ),
      interactive: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "On action=exec: open a PTY and return a reusable session id instead of blocking until exit. E2B sandboxes only.",
        ),
      input: z
        .string()
        .optional()
        .describe(
          "For action=send: keystrokes. Supports tmux-style names ('Enter', 'Tab', 'C-c', 'Up', 'M-x', 'C-S-A') via pty-keys. Plain text is sent verbatim as UTF-8 — include your own '\\n' if needed.",
        ),
      cols: z.number().int().optional().default(120),
      rows: z.number().int().optional().default(30),
      wait_for: z
        .object({
          pattern: z
            .string()
            .optional()
            .describe(
              "JS regex; resolves as soon as accumulated (ANSI-stripped) output matches. Invalid regex returns a structured error instead of crashing the tool call.",
            ),
          idle_ms: z
            .number()
            .int()
            .min(50)
            .max(60_000)
            .optional()
            .default(DEFAULT_WAIT_IDLE_MS)
            .describe(
              "Resolve after N ms of no new bytes. Range: [50, 60000] (1 min cap).",
            ),
          timeout_ms: z
            .number()
            .int()
            .min(100)
            .max(300_000)
            .optional()
            .default(DEFAULT_WAIT_TIMEOUT_MS)
            .describe(
              "Absolute cap on the wait. Range: [100, 300000] (5 min cap).",
            ),
        })
        .optional()
        .describe(
          "Wait policy applied after exec+interactive / send / wait. Default: {idle_ms: 800, timeout_ms: 15000}. Caps: idle_ms<=60000, timeout_ms<=300000.",
        ),
    }),
    execute: async (
      {
        action,
        command,
        is_background,
        timeout,
        session: sessionId,
        interactive,
        input,
        cols,
        rows,
        wait_for,
      }: {
        action: "exec" | "wait" | "send" | "kill" | "view";
        command?: string;
        is_background: boolean;
        timeout?: number;
        session?: string;
        interactive: boolean;
        input?: string;
        cols: number;
        rows: number;
        wait_for?: {
          pattern?: string;
          idle_ms: number;
          timeout_ms: number;
        };
      },
      { toolCallId, abortSignal },
    ) => {
      // Default wait policy shared across interactive action branches.
      const waitPolicy: WaitPolicy = {
        pattern: wait_for?.pattern,
        idle_ms: wait_for?.idle_ms ?? DEFAULT_WAIT_IDLE_MS,
        timeout_ms: wait_for?.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
      };

      // Helper: emit a raw-byte chunk to the UI terminal stream.
      // The `data-terminal` part shape in `UIMessageStreamWriter` only types
      // the minimal `{terminal, toolCallId}` fields, but the frontend
      // (`TerminalToolHandler`/`ComputerSidebar`) reads the extra `action`
      // and `session` fields at runtime. This cast is intentional — keep
      // the minimal typed surface while carrying the extra metadata.
      const emitTerminal = (bytes: Uint8Array) => {
        const text = new TextDecoder().decode(bytes);
        writer.write({
          type: "data-terminal",
          id: `pty-${toolCallId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          data: {
            terminal: text,
            toolCallId,
            action,
            session: sessionId,
          } as unknown as { terminal: string; toolCallId: string },
        });
      };

      // ─── Non-exec actions (session lookup required) ────────────────────
      if (action === "send") {
        if (!sessionId) {
          return {
            result: { output: "", error: "action=send requires `session`." },
          };
        }
        const session = ptySessionManager.get(chatId, sessionId);
        if (!session) {
          return {
            result: { output: "", error: `Session ${sessionId} not found.` },
          };
        }
        const bytes = translateInput(input ?? "");
        if (bytes.byteLength > MAX_INPUT_BYTES_PER_SEND) {
          return {
            result: {
              output: "",
              error: `Input exceeds MAX_INPUT_BYTES_PER_SEND=${MAX_INPUT_BYTES_PER_SEND} (got ${bytes.byteLength}).`,
            },
          };
        }
        try {
          await session.handle.sendInput(bytes);
        } catch (err) {
          return {
            result: {
              output: "",
              error: `Failed to send input: ${err instanceof Error ? err.message : String(err)}`,
            },
          };
        }
        session.lastActivityAt = Date.now();
        try {
          const delta = await waitForOutput(
            session,
            waitPolicy,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
          );
          return {
            result: {
              // TODO(M2): capOutput truncates for model-facing output only.
              // `saveTruncatedOutput` for interactive PTY deltas is out of
              // scope for M1 per plan — revisit when ring persistence lands.
              output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
              ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
            },
          };
        } catch (err) {
          if (err instanceof InvalidWaitPatternError) {
            return {
              result: {
                output: "",
                error: `Invalid wait_for.pattern: ${err.message}`,
              },
            };
          }
          throw err;
        }
      }

      if (action === "wait") {
        if (!sessionId) {
          return {
            result: { output: "", error: "action=wait requires `session`." },
          };
        }
        const session = ptySessionManager.get(chatId, sessionId);
        if (!session) {
          return {
            result: { output: "", error: `Session ${sessionId} not found.` },
          };
        }
        // If process already exited, surface immediately without waiting.
        const alreadyExited = await peekExited(session);
        try {
          const delta = await waitForOutput(
            session,
            waitPolicy,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
          );
          const out: Record<string, unknown> = {
            // TODO(M2): see note above — `saveTruncatedOutput` for interactive
            // PTY deltas deferred.
            output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
          };
          if (session.bufferTruncated) out.bufferTruncated = true;
          if (alreadyExited) out.exited = { exitCode: alreadyExited.exitCode };
          return { result: out };
        } catch (err) {
          if (err instanceof InvalidWaitPatternError) {
            return {
              result: {
                output: "",
                error: `Invalid wait_for.pattern: ${err.message}`,
              },
            };
          }
          throw err;
        }
      }

      if (action === "view") {
        if (!sessionId) {
          return {
            result: { output: "", error: "action=view requires `session`." },
          };
        }
        const session = ptySessionManager.get(chatId, sessionId);
        if (!session) {
          return {
            result: { output: "", error: `Session ${sessionId} not found.` },
          };
        }
        const snapshot = ptySessionManager.snapshot(session);
        return {
          result: {
            output: capOutput(stripAnsi(new TextDecoder().decode(snapshot))),
            ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
          },
        };
      }

      if (action === "kill") {
        if (!sessionId) {
          return {
            result: { output: "", error: "action=kill requires `session`." },
          };
        }
        const session = ptySessionManager.get(chatId, sessionId);
        if (!session) {
          return {
            result: { output: "", error: `Session ${sessionId} not found.` },
          };
        }
        const exitPromise = session.handle.exited;
        await ptySessionManager.close(chatId, sessionId);
        const exit = await exitPromise.catch(() => ({ exitCode: null }));
        return { result: { exitCode: exit.exitCode } };
      }

      // action === "exec" — validate command is present.
      if (!command || command.length === 0) {
        return {
          result: {
            output: "",
            exitCode: 1,
            error: "action=exec requires `command`.",
          },
        };
      }
      const commandNonEmpty: string = command;
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

      // ─── Interactive PTY exec branch ─────────────────────────────────
      if (interactive) {
        try {
          const { sandbox } = await sandboxManager.getSandbox();
          if (!isE2BSandbox(sandbox)) {
            return {
              result: {
                output: "",
                exitCode: 1,
                error:
                  "Interactive PTY requires E2B sandbox. Use action=exec without interactive for one-shot commands.",
              },
            };
          }
          // Factory is invoked BY `ptySessionManager.create` — this ensures
          // that if the concurrency cap is hit, the factory is never called
          // and no E2B PTY is spawned (see FIX 4).
          const session = await ptySessionManager.create(chatId, {
            cols,
            rows,
            createHandle: () =>
              createE2BPtyHandle(sandbox, {
                cols,
                rows,
                envs: caidoEnvVars,
              }),
          });
          // Fire the command + Enter so the shell actually runs it.
          await session.handle.sendInput(
            new TextEncoder().encode(command + "\n"),
          );
          session.lastActivityAt = Date.now();

          const delta = await waitForOutput(
            session,
            waitPolicy,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
          );
          return {
            result: {
              session: session.sessionId,
              pid: session.pid,
              // TODO(M2): `saveTruncatedOutput` integration for interactive
              // PTY deltas is deferred per plan (fluffy-splashing-hoare.md).
              output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
              ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
            },
          };
        } catch (err) {
          if (err instanceof InvalidWaitPatternError) {
            return {
              result: {
                output: "",
                error: `Invalid wait_for.pattern: ${err.message}`,
              },
            };
          }
          return {
            result: {
              output: "",
              exitCode: 1,
              error:
                err instanceof Error
                  ? err.message
                  : "Failed to create interactive PTY session.",
            },
          };
        }
      }

      try {
        // Narrow the optional schema param: past this point `command` is a
        // guaranteed non-empty string. Shadowing keeps the existing closure
        // body (written when `command` was always required) type-correct
        // without rewriting every reference.
         
        const command: string = commandNonEmpty;
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
        }

        return executeCommand(sandbox);

        async function executeCommand(sandboxInstance: typeof sandbox) {
          // Ensure Caido proxy is running + authenticated before commands route through it.
          // This is a no-op after the first successful call (cached per session).
          // If setup fails, permanently disable proxy env vars for all future commands.
          if (caidoEnvVars) {
            try {
              await ensureCaido(context);
            } catch (e) {
              console.warn(
                "[Terminal Command] Caido setup failed, disabling proxy env vars:",
                e instanceof Error ? e.message : e,
              );
              caidoEnvVars = undefined;
            }
          }

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
              caidoEnvVars,
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

            // Augment PATH for local sandboxes so user-installed tools
            // (e.g. ~/go/bin/waybackurls) are found without full paths.
            // Keep the original `command` for PID discovery (findProcessPid).
            const effectiveCommand = augmentCommandPath(
              command,
              sandboxInstance,
            );

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
                    const result = await sandboxInstance.commands.run(
                      effectiveCommand,
                      {
                        ...commonOptions,
                        background: true,
                      },
                    );
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
                  () =>
                    sandboxInstance.commands.run(
                      effectiveCommand,
                      commonOptions,
                    ),
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
                          exitCode: exec.exitCode ?? 0,
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
