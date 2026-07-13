import { tool } from "ai";
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
import {
  INTERACT_TERMINAL_DEFAULT_WAIT_TIMEOUT_SECONDS,
  INTERACT_TERMINAL_MAX_WAIT_TIMEOUT_SECONDS,
  interactTerminalSessionTool,
} from "./schemas";

// ─── Interactive PTY constants ──────────────────────────────────────────
const MAX_INPUT_BYTES_PER_SEND = 8 * 1024;
const DEFAULT_WAIT_TIMEOUT_SECONDS =
  INTERACT_TERMINAL_DEFAULT_WAIT_TIMEOUT_SECONDS;
const MAX_WAIT_TIMEOUT_SECONDS = INTERACT_TERMINAL_MAX_WAIT_TIMEOUT_SECONDS;
// Brief window to capture the immediate response to a `send` (e.g. a prompt
// echoing "Hello, X!"). Too short and we miss instant CLI replies; too long
// and we block the agent on long-running processes that need explicit `wait`.
const SEND_IMMEDIATE_OUTPUT_WINDOW_MS = 500;
// For `wait`, treat `WAIT_QUIET_WINDOW_MS` of silence (after the first chunk)
// as "process settled" — typically a redrawn prompt or completed command.
// `timeout` remains the hard ceiling for processes that never settle.
const WAIT_QUIET_WINDOW_MS = 500;

export const createInteractTerminalSession = (context: ToolContext) => {
  const { writer, chatId, ptySessionManager } = context;

  return tool({
    ...interactTerminalSessionTool,
    execute: async (
      {
        session: sessionId,
        action,
        brief,
        input,
        timeout,
      }: {
        session: string;
        action: "send" | "wait" | "view" | "kill";
        brief?: string;
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
          return {
            error: errorResult(
              `Session ${sid} not found. Only use the exact session ID returned by run_terminal_cmd; a PID is not a session ID and must never be converted into one.`,
            ),
          };
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

      const requestTerminalInteractionApproval = async (
        target: string,
      ): Promise<ActionResult | null> => {
        const approval = await context.requestToolApproval?.({
          toolCallId,
          toolName: "interact_terminal_session",
          operation: "terminal_interact",
          target,
          brief,
        });
        if (!approval || approval.approved) return null;
        return {
          result: {
            output: "",
            error: approval.reason,
            approvalDenied: true,
          },
        };
      };

      // ─── Handler: send ─────────────────────────────────────────────────────
      const handleSend = async (): Promise<ActionResult> => {
        if (input === undefined || input.length === 0) {
          return errorResult(
            'action=send requires `input`. To submit just Enter (e.g. to terminate a Python multi-line block or accept a default prompt), pass input="Enter" or input="\\n".',
          );
        }
        const lookup = getSessionOrError("send", sessionId);
        if ("error" in lookup) return lookup.error;
        const { session } = lookup;
        if (session.kind === "command") {
          return errorResult(
            `Session ${sessionId} belongs to a non-interactive command and does not accept input. Use action=wait, view, or kill.`,
          );
        }

        // Fast-fail if the PTY already exited — otherwise sendInput on E2B
        // rejects with an opaque `[not_found] process with pid N not found`
        // that doesn't tell the model the session is dead.
        const priorExit = peekSessionExit(session);
        if (priorExit) return exitedSendError(sessionId, priorExit, false);

        const approvalDenied = await requestTerminalInteractionApproval(
          `send to ${sessionId}: ${input}`,
        );
        if (approvalDenied) return approvalDenied;

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
          { quietMs: WAIT_QUIET_WINDOW_MS },
        );
        await drainEmitQueue();
        const snapshots = await getSessionSnapshots(ptySessionManager, session);
        const exited = alreadyExited ?? (await peekExited(session));
        const out: Record<string, unknown> = {
          output: capOutput(stripAnsi(new TextDecoder().decode(delta))),
          sessionSnapshot: snapshots.cleaned,
          rawSnapshot: snapshots.raw,
        };
        if (session.bufferTruncated) out.bufferTruncated = true;
        if (exited) out.exited = { exitCode: exited.exitCode };
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

        const approvalDenied = await requestTerminalInteractionApproval(
          `kill ${sessionId}`,
        );
        if (approvalDenied) return approvalDenied;

        // Skip the snapshot dump — the user already saw the final state via
        // prior view/wait/send blocks; a one-line confirmation reads cleaner
        // in both the agent transcript and the sidebar.
        const exitPromise = session.handle.exited;
        await ptySessionManager.close(chatId, session.sessionId);
        const exit = await exitPromise.catch(() => ({ exitCode: null }));
        return {
          result: {
            output:
              session.kind === "pty"
                ? "Successfully killed interactive shell."
                : "Successfully killed non-interactive command session.",
            exitCode: exit.exitCode,
          },
        };
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
    // Strip rawSnapshot from the model's view: the agent only needs the
    // cleaned `output` plus structural fields. rawSnapshot stays in the
    // persisted tool result so the sidebar's xterm renderer can replay it.
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
