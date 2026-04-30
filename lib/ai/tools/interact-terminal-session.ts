import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import type { PtySession } from "./utils/pty-session-manager";
import {
  cleanPtyForUI,
  getSessionSnapshots,
} from "./utils/pty-output-formatter";
import {
  waitForOutput,
  capOutput,
  stripAnsi,
  peekExited,
} from "./utils/pty-wait-utils";
import { translateInput } from "./utils/pty-keys";

// ─── Interactive PTY constants ──────────────────────────────────────────
const MAX_INPUT_BYTES_PER_SEND = 8 * 1024;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 10;
const MAX_WAIT_TIMEOUT_SECONDS = 300;
// Brief window to capture the immediate response to a `send` (e.g. a prompt
// echoing "Hello, X!"). Too short and we miss instant CLI replies; too long
// and we block the agent on long-running processes that need explicit `wait`.
const SEND_IMMEDIATE_OUTPUT_WINDOW_MS = 500;

export const createInteractTerminalSession = (context: ToolContext) => {
  const { writer, chatId, ptySessionManager } = context;

  return tool({
    description: `Interact with persistent shell sessions in the sandbox environment.

<supported_actions>
- \`view\`: View the content of a shell session
- \`wait\`: Wait for the running process in a shell session to return
- \`send\`: Send input to the active process (stdin) in a shell session
- \`kill\`: Terminate the running process in a shell session
</supported_actions>

<instructions>
- Sessions are created by \`run_terminal_cmd\` with \`interactive=true\`; pass the returned \`session\` id here
- When using \`view\` action, ensure command has completed execution before using its output
- Set a short \`timeout\` (such as 5s) on \`wait\` for processes that don't return promptly to avoid meaningless waiting time
- Processes are NEVER killed on timeout — they keep running in the session; \`timeout\` only controls how long to wait for output before returning
- Use \`wait\` action when a process needs additional time to complete and return
- Only use \`wait\` after \`send\` (or after \`run_terminal_cmd\` returned without finishing); decide whether to wait based on the prior output
- DO NOT use \`wait\` for long-running daemon processes
- \`send\` writes input and captures only the immediate response chunk; if the process needs more time before it replies, follow up with \`action=wait\`
- When using \`send\`, end the \`input\` with a newline character (\\n) to simulate pressing Enter
- For special keys, use official tmux key names: C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), Up, Down, Left, Right, Home, End, Escape, Tab, Enter, Space, F1-F12, PageUp, PageDown
- For modifier combinations: M-key (Alt), C-S-key (Ctrl+Shift)
- Note: Use official tmux names (BSpace not Backspace, DC not Delete, Escape not Esc)
- For non-key strings in \`input\`, DO NOT perform any escaping; send the raw string directly
- Raw input BYPASSES command guardrails; never forward untrusted content
</instructions>

<recommended_usage>
- Use \`view\` to check shell session history and latest status
- Use \`wait\` to wait for the completion of long-running commands
- Use \`send\` to interact with processes that require user input (e.g., responding to prompts)
- Use \`send\` with special keys like C-c to interrupt, C-d to send EOF
- Use \`kill\` to stop background processes that are no longer needed
- Use \`kill\` to clean up dead or unresponsive processes
</recommended_usage>`,
    inputSchema: z.object({
      action: z
        .enum(["view", "wait", "send", "kill"])
        .describe("The action to perform"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      input: z
        .string()
        .optional()
        .describe(
          "Input text to send to the interactive session. End with a newline character (\\n) to simulate pressing Enter if needed. Required for `send` action.",
        ),
      session: z
        .string()
        .describe(
          "The unique identifier of the target shell session (returned by `run_terminal_cmd` with `interactive=true`)",
        ),
      timeout: z
        .number()
        .int()
        .optional()
        .default(DEFAULT_WAIT_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for output. Only used for \`wait\` action. Defaults to ${DEFAULT_WAIT_TIMEOUT_SECONDS} seconds. Max ${MAX_WAIT_TIMEOUT_SECONDS} seconds.`,
        ),
    }),
    execute: async (
      {
        session: sessionId,
        action,
        input,
        timeout,
      }: {
        session: string;
        action: "send" | "wait" | "view" | "kill";
        input?: string;
        timeout?: number;
      },
      { toolCallId, abortSignal },
    ) => {
      const timeoutMs =
        Math.min(
          timeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS,
          MAX_WAIT_TIMEOUT_SECONDS,
        ) * 1000;

      // Emit raw bytes to UI terminal stream - no cleaning during streaming.
      // The sessionSnapshot in the final result is properly cleaned via xterm
      // headless, and the UI prefers it once the tool completes.
      let emitQueue: Promise<void> = Promise.resolve();
      const emitTerminal = (bytes: Uint8Array): void => {
        emitQueue = emitQueue
          .then(() => {
            // Send raw text - UI will show progress, then switch to clean
            // sessionSnapshot when tool completes
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

      const emitPriorContext = (session: PtySession) => {
        // Send raw snapshot bytes to preserve ANSI colors for xterm.js rendering
        const prior = ptySessionManager.snapshot(session);
        if (prior.byteLength > 0) emitTerminal(prior);
        // Mark snapshot as consumed so subsequent consumeDelta calls don't repeat it
        ptySessionManager.consumeDelta(session);
      };

      // Reads the (internal) `exitedNaturally` field. The session stays
      // around after natural exit so `view`/`wait` can read final output,
      // but `send` has no live process to write to.
      const peekSessionExit = (
        s: PtySession,
      ): { exitCode: number | null } | null => {
        const internal = s as {
          exitedNaturally?: { exitCode: number | null } | null;
        };
        return internal.exitedNaturally ?? null;
      };

      const exitedSendError = (
        sid: string,
        exited: { exitCode: number | null },
        during: boolean,
      ): ActionResult => ({
        result: {
          output: "",
          error: `Session ${sid} ${during ? "exited during send" : "has exited"} (exitCode=${exited.exitCode}). Use action=view to read final output, or start a new session via run_terminal_cmd.`,
          exited,
        },
      });

      // ─── Handler: send ─────────────────────────────────────────────────────
      const handleSend = async (): Promise<ActionResult> => {
        if (input === undefined || input.length === 0) {
          return errorResult("action=send requires non-empty `input`.");
        }
        const lookup = getSessionOrError("send", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        // Fast-fail if the PTY already exited — otherwise sendInput on E2B
        // rejects with an opaque `[not_found] process with pid N not found`
        // that doesn't tell the model the session is dead.
        const priorExit = peekSessionExit(session);
        if (priorExit) return exitedSendError(sessionId, priorExit, false);

        emitPriorContext(session);

        // Translate tmux key names (C-c, Up, Enter, ...) to escape sequences;
        // raw text passes through unchanged with trailing newline normalized
        // to CR so "echo hi\n" submits the line as a real Enter.
        const bytes = translateInput(input);
        if (bytes.byteLength > MAX_INPUT_BYTES_PER_SEND) {
          return errorResult(
            `Input exceeds MAX_INPUT_BYTES_PER_SEND=${MAX_INPUT_BYTES_PER_SEND} (got ${bytes.byteLength}).`,
          );
        }
        try {
          await session.handle.sendInput(bytes);
        } catch (err) {
          // sendInput may have raced with a natural exit between the
          // pre-check and now — surface that explicitly when it's the cause.
          const raceExit = peekSessionExit(session);
          if (raceExit) return exitedSendError(sessionId, raceExit, true);
          return errorResult(
            `Failed to send input: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        session.lastActivityAt = Date.now();
        // Capture the immediate response chunk — prompts that echo a reply
        // ("Hello, X!") show up here. Use action=wait for processes that
        // take longer to respond.
        const delta = await waitForOutput(
          session,
          SEND_IMMEDIATE_OUTPUT_WINDOW_MS,
          abortSignal,
          emitTerminal,
          (s) => ptySessionManager.consumeDelta(s),
        );
        await drainEmitQueue();
        const snapshots = await getSessionSnapshots(ptySessionManager, session);
        return {
          result: {
            output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
            sessionSnapshot: snapshots.cleaned,
            rawSnapshot: snapshots.raw,
            ...(session.bufferTruncated ? { bufferTruncated: true } : {}),
          },
        };
      };

      // ─── Handler: wait ─────────────────────────────────────────────────────
      const handleWait = async (): Promise<ActionResult> => {
        const lookup = getSessionOrError("wait", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        emitPriorContext(session);

        const alreadyExited = await peekExited(session);
        const delta = await waitForOutput(
          session,
          timeoutMs,
          abortSignal,
          emitTerminal,
          (s) => ptySessionManager.consumeDelta(s),
        );
        await drainEmitQueue();
        const snapshots = await getSessionSnapshots(ptySessionManager, session);
        const out: Record<string, unknown> = {
          output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
          sessionSnapshot: snapshots.cleaned,
          rawSnapshot: snapshots.raw,
        };
        if (session.bufferTruncated) out.bufferTruncated = true;
        if (alreadyExited) out.exited = { exitCode: alreadyExited.exitCode };
        return { result: out };
      };

      // ─── Handler: view ─────────────────────────────────────────────────────
      const handleView = async (): Promise<ActionResult> => {
        const lookup = getSessionOrError("view", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;

        const snapshot = ptySessionManager.snapshot(session);
        if (snapshot.byteLength > 0) emitTerminal(snapshot);
        await drainEmitQueue();
        const rawText = new TextDecoder().decode(snapshot);
        const internal = session as {
          exitedNaturally?: { exitCode: number | null } | null;
        };
        return {
          result: {
            output: capOutput(stripAnsi(rawText)),
            sessionSnapshot: await cleanPtyForUI(rawText),
            rawSnapshot: rawText,
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
