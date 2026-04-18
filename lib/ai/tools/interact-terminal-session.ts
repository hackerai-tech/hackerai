import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import type { PtySession } from "./utils/pty-session-manager";
import {
  cleanPtyForUI,
  lastNLinesBytes,
  getSessionSnapshot,
} from "./utils/pty-output-formatter";

// ─── Interactive PTY constants ──────────────────────────────────────────
const MAX_INPUT_BYTES_PER_SEND = 8 * 1024;
const MODEL_OUTPUT_CAP_BYTES = 8 * 1024;
const DEFAULT_WAIT_IDLE_MS = 800;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

// Strip CSI + OSC ANSI escape sequences from model-facing output.
const ANSI_REGEX =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;
const stripAnsi = (text: string): string => text.replace(ANSI_REGEX, "");

interface WaitPolicy {
  pattern?: string;
  idle_ms: number;
  timeout_ms: number;
}

/**
 * Thrown when `policy.pattern` cannot be compiled to a RegExp.
 */
class InvalidWaitPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWaitPatternError";
  }
}

/** Upper bound on `wait_for.pattern` length to blunt ReDoS via pathological input. */
const MAX_WAIT_PATTERN_LENGTH = 256;

/**
 * Compile `policy.pattern` into a RegExp, returning `null` when no pattern is
 * configured. Throws `InvalidWaitPatternError` synchronously when the pattern
 * is too long or cannot be compiled.
 */
function compileWaitPattern(policy: WaitPolicy): RegExp | null {
  if (!policy.pattern) return null;
  if (policy.pattern.length > MAX_WAIT_PATTERN_LENGTH) {
    throw new InvalidWaitPatternError(
      `pattern exceeds ${MAX_WAIT_PATTERN_LENGTH} characters`,
    );
  }
  try {
    return new RegExp(policy.pattern);
  } catch (err) {
    throw new InvalidWaitPatternError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resolve once any of:
 *   - `policy.pattern` matches the ANSI-stripped accumulated delta (if set)
 *   - `policy.idle_ms` of no new onData chunks (if pattern unset)
 *   - `policy.timeout_ms` absolute cap
 *   - `signal` aborts
 */
async function waitForOutput(
  session: PtySession,
  policy: WaitPolicy,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => void,
  consume: (s: PtySession) => Uint8Array,
): Promise<Uint8Array> {
  const regex = compileWaitPattern(policy);

  return new Promise<Uint8Array>((resolve) => {
    let settled = false;
    let accumulated = "";
    const decoder = new TextDecoder();

    const preBuffered = consume(session);
    if (preBuffered.byteLength > 0) {
      try {
        onChunk(preBuffered);
      } catch (err) {
        console.error("[interact-terminal-session] emitTerminal failed:", err);
      }
      if (regex) {
        accumulated += stripAnsi(decoder.decode(preBuffered, { stream: true }));
      }
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimer = setTimeout(() => finish(), policy.timeout_ms);

    const armIdle = () => {
      if (regex) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), policy.idle_ms);
    };

    if (regex && regex.test(accumulated)) {
      settled = true;
      clearTimeout(hardTimer);
      const finalDelta = consume(session);
      const combined = new Uint8Array(
        preBuffered.byteLength + finalDelta.byteLength,
      );
      combined.set(preBuffered, 0);
      combined.set(finalDelta, preBuffered.byteLength);
      resolve(combined);
      return;
    }

    armIdle();

    const unsubscribe = session.handle.onData((bytes) => {
      if (settled) return;
      try {
        onChunk(bytes);
      } catch (err) {
        console.error("[interact-terminal-session] emitTerminal failed:", err);
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
      } catch (err) {
        console.error("[interact-terminal-session] unsubscribe failed:", err);
      }
      signal?.removeEventListener("abort", onAbort);
      const finalDelta = consume(session);
      const combined = new Uint8Array(
        preBuffered.byteLength + finalDelta.byteLength,
      );
      combined.set(preBuffered, 0);
      combined.set(finalDelta, preBuffered.byteLength);
      resolve(combined);
    }
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
      Promise.resolve().then(() => r(sentinel));
    }),
  ]);
  if (result === sentinel) return null;
  return result;
}

export const createInteractTerminalSession = (context: ToolContext) => {
  const { writer, chatId, ptySessionManager } = context;

  return tool({
    description: `Interact with an existing PTY session created by run_terminal_cmd with interactive=true.

Use this tool to:
- Send keystrokes to REPLs, SSH sessions, or interactive prompts
- Wait for command output to complete
- View the current terminal state
- Kill finished sessions

IMPORTANT: You must first create a session using run_terminal_cmd with interactive=true, which returns a session ID. Pass that session ID here.`,
    inputSchema: z.object({
      session: z
        .string()
        .describe(
          "Session ID returned by run_terminal_cmd with interactive=true. REQUIRED.",
        ),
      action: z
        .enum(["send", "wait", "view", "kill"])
        .describe(
          "Action to perform:\n" +
            "  - send: Feed input to the session and wait for reply. REQUIRES `input`.\n" +
            "  - wait: Wait for more output (only if you need MORE output after send already returned).\n" +
            "  - view: Snapshot the full session buffer without consuming.\n" +
            "  - kill: Terminate the session.",
        ),
      input: z
        .string()
        .optional()
        .describe(
          "ONLY for action=send. Raw input to send to terminal stdin. " +
            "Use \\n for Enter (auto-converted to \\r), \\t for Tab, " +
            "\\x03 for Ctrl+C (SIGINT), \\x04 for Ctrl+D (EOF), " +
            "\\x1b[A/B/C/D for Up/Down/Right/Left arrows. " +
            "Example: 'echo hello\\n' sends command and presses Enter. " +
            "Send ONE command per call, observe output before the next. " +
            "Raw input BYPASSES command guardrails; never paste untrusted content.",
        ),
      wait_for: z
        .object({
          pattern: z
            .string()
            .optional()
            .describe(
              "JS regex. Resolves as soon as accumulated (ANSI-stripped) output matches — use this when you know the shell prompt or marker you're waiting for (e.g. '>>> $' for python, '# $' for a root shell). Invalid regex returns a structured error rather than crashing the call.",
            ),
          idle_ms: z
            .number()
            .int()
            .min(50)
            .max(60_000)
            .optional()
            .default(DEFAULT_WAIT_IDLE_MS)
            .describe(
              "Resolve after N ms with no new output bytes. Good default for prompts that don't have a predictable marker. Range: [50, 60000].",
            ),
          timeout_ms: z
            .number()
            .int()
            .min(100)
            .max(300_000)
            .optional()
            .default(DEFAULT_WAIT_TIMEOUT_MS)
            .describe(
              "Hard cap on the wait. Fires even if neither pattern nor idle_ms triggered. Range: [100, 300000].",
            ),
        })
        .optional()
        .describe(
          "Wait policy applied after action=send and action=wait. Resolves on the FIRST of: `pattern` match, `idle_ms` of silence, or `timeout_ms` elapsed. Default: {idle_ms: 800, timeout_ms: 10000}.",
        ),
    }),
    execute: async (
      {
        session: sessionId,
        action,
        input,
        wait_for,
      }: {
        session: string;
        action: "send" | "wait" | "view" | "kill";
        input?: string;
        wait_for?: {
          pattern?: string;
          idle_ms: number;
          timeout_ms: number;
        };
      },
      { toolCallId, abortSignal },
    ) => {
      const waitPolicy: WaitPolicy = {
        pattern: wait_for?.pattern,
        idle_ms: wait_for?.idle_ms ?? DEFAULT_WAIT_IDLE_MS,
        timeout_ms: wait_for?.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
      };

      // Validate wait_for.pattern upfront for actions that consume it
      const consumesWaitFor = action === "send" || action === "wait";
      if (consumesWaitFor) {
        try {
          compileWaitPattern(waitPolicy);
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

      // Emit raw-byte chunks to the UI terminal stream
      let emitQueue: Promise<void> = Promise.resolve();
      const emitTerminal = (bytes: Uint8Array): void => {
        emitQueue = emitQueue
          .then(async () => {
            const text = await cleanPtyForUI(new TextDecoder().decode(bytes));
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
          })
          .catch((err) =>
            console.error(
              "[interact-terminal-session] emitTerminal failed:",
              err,
            ),
          );
      };
      const drainEmitQueue = () => emitQueue;

      // ─── Action result type ────────────────────────────────────────────────
      type ActionResult = { result: Record<string, unknown> };

      const errorResult = (error: string): ActionResult => ({
        result: { output: "", error },
      });

      const getSessionOrError = (
        actionName: string,
        sid: string | undefined,
      ): { session: PtySession } | { error: ActionResult } => {
        if (!sid) {
          return {
            error: errorResult(`action=${actionName} requires \`session\`.`),
          };
        }
        const found = ptySessionManager.get(chatId, sid);
        if (!found) {
          return { error: errorResult(`Session ${sid} not found.`) };
        }
        return { session: found };
      };

      const emitPriorContext = async (session: PtySession) => {
        const prior = await lastNLinesBytes(
          ptySessionManager.snapshot(session),
          100,
        );
        if (prior.byteLength > 0) emitTerminal(prior);
      };

      const translateWaitError = (err: unknown): ActionResult | null =>
        err instanceof InvalidWaitPatternError
          ? errorResult(`Invalid wait_for.pattern: ${err.message}`)
          : null;

      // ─── Handler: send ─────────────────────────────────────────────────────
      const handleSend = async (): Promise<ActionResult> => {
        if (input === undefined || input.length === 0) {
          return errorResult("action=send requires non-empty `input`.");
        }
        const lookup = getSessionOrError("send", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        await emitPriorContext(session);

        // Parse escape sequences: model sends raw strings like "echo\n" or "\x03"
        // Convert literal escape sequences to actual bytes
        const parsed = input
          // Handle \xNN hex escapes (e.g., \x03 for Ctrl+C, \x1b for Escape)
          .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16)),
          )
          // Handle common escape sequences
          .replace(/\\n/g, "\r") // \n → CR (Enter for terminal)
          .replace(/\\r/g, "\r") // \r → CR
          .replace(/\\t/g, "\t") // \t → Tab
          .replace(/\\e/g, "\x1b") // \e → Escape
          .replace(/\\\\/g, "\\") // \\ → literal backslash
          // Also normalize actual newlines if present
          .replace(/\r\n/g, "\r")
          .replace(/\n/g, "\r");
        const bytes = new TextEncoder().encode(parsed);
        if (bytes.byteLength > MAX_INPUT_BYTES_PER_SEND) {
          return errorResult(
            `Input exceeds MAX_INPUT_BYTES_PER_SEND=${MAX_INPUT_BYTES_PER_SEND} (got ${bytes.byteLength}).`,
          );
        }
        try {
          await session.handle.sendInput(bytes);
        } catch (err) {
          return errorResult(
            `Failed to send input: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        session.lastActivityAt = Date.now();
        // Brief delay for CLI readline to process input
        await new Promise((r) => setTimeout(r, 50));
        try {
          const delta = await waitForOutput(
            session,
            waitPolicy,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
          );
          await drainEmitQueue();
          return {
            result: {
              output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
              sessionSnapshot: await getSessionSnapshot(
                ptySessionManager,
                session,
              ),
              ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
            },
          };
        } catch (err) {
          const translated = translateWaitError(err);
          if (translated) return translated;
          throw err;
        }
      };

      // ─── Handler: wait ─────────────────────────────────────────────────────
      const handleWait = async (): Promise<ActionResult> => {
        const lookup = getSessionOrError("wait", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        await emitPriorContext(session);

        const alreadyExited = await peekExited(session);
        try {
          const delta = await waitForOutput(
            session,
            waitPolicy,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
          );
          await drainEmitQueue();
          const out: Record<string, unknown> = {
            output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
            sessionSnapshot: await getSessionSnapshot(
              ptySessionManager,
              session,
            ),
          };
          if (session.bufferTruncated) out.bufferTruncated = true;
          if (alreadyExited) out.exited = { exitCode: alreadyExited.exitCode };
          return { result: out };
        } catch (err) {
          const translated = translateWaitError(err);
          if (translated) return translated;
          throw err;
        }
      };

      // ─── Handler: view ─────────────────────────────────────────────────────
      const handleView = async (): Promise<ActionResult> => {
        const lookup = getSessionOrError("view", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        const snapshot = ptySessionManager.snapshot(session);
        if (snapshot.byteLength > 0) emitTerminal(snapshot);
        await drainEmitQueue();
        const internal = session as {
          exitedNaturally?: { exitCode: number | null } | null;
        };
        return {
          result: {
            output: capOutput(stripAnsi(new TextDecoder().decode(snapshot))),
            sessionSnapshot: await cleanPtyForUI(
              new TextDecoder().decode(snapshot),
            ),
            ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
            ...(internal.exitedNaturally
              ? { exited: internal.exitedNaturally }
              : {}),
          },
        };
      };

      // ─── Handler: kill ─────────────────────────────────────────────────────
      const handleKill = async (): Promise<ActionResult> => {
        const lookup = getSessionOrError("kill", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        const killSnapshot = ptySessionManager.snapshot(session);
        if (killSnapshot.byteLength > 0) emitTerminal(killSnapshot);
        await drainEmitQueue();
        const exitPromise = session.handle.exited;
        await ptySessionManager.close(chatId, session.sessionId);
        const exit = await exitPromise.catch(() => ({ exitCode: null }));
        return { result: { exitCode: exit.exitCode } };
      };

      // ─── Dispatch ──────────────────────────────────────────────────────────
      const handlers: Record<string, () => Promise<ActionResult>> = {
        send: handleSend,
        wait: handleWait,
        view: handleView,
        kill: handleKill,
      };

      const handler = handlers[action];
      if (handler) return handler();

      return errorResult(`Unknown action: ${action}`);
    },
  });
};
