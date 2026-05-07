/**
 * Shared implementation of `interact_terminal_session` actions
 * (send/wait/view/kill). Used by both the AI-SDK tool wrapper in
 * `lib/ai/tools/interact-terminal-session.ts` (chat handler / normal
 * agent) and the workflow durable step in
 * `lib/workflows/steps/terminal-steps.ts:interactTerminalSessionStep`.
 *
 * The workflow caller passes no `emitTerminal` — it only consumes the
 * final `sessionSnapshot` in the tool result (one block per call).
 */

import type { PtySession, PtySessionManager } from "./pty-session-manager";
import { cleanPtyForUI, getSessionSnapshots } from "./pty-output-formatter";
import {
  waitForOutput,
  capOutput,
  stripAnsi,
  peekExited,
} from "./pty-wait-utils";
import { translateInput } from "./pty-keys";

const MAX_INPUT_BYTES_PER_SEND = 8 * 1024;
// Brief window to capture the immediate response to a `send` (e.g. a prompt
// echoing "Hello, X!"). Too short and we miss instant CLI replies; too long
// and we block the agent on long-running processes that need explicit `wait`.
const SEND_IMMEDIATE_OUTPUT_WINDOW_MS = 500;
// For `wait`, treat `WAIT_QUIET_WINDOW_MS` of silence (after the first chunk)
// as "process settled" — typically a redrawn prompt or completed command.
// `timeout` remains the hard ceiling for processes that never settle.
const WAIT_QUIET_WINDOW_MS = 500;

export type InteractTerminalAction = "send" | "wait" | "view" | "kill";

export interface PerformInteractTerminalActionArgs {
  action: InteractTerminalAction;
  sessionId: string;
  chatId: string;
  input?: string;
  /** Already converted to ms by the caller; only used by `wait`. */
  timeoutMs: number;
  ptySessionManager: PtySessionManager;
  abortSignal?: AbortSignal;
  /** Optional raw-byte sink for live UI streaming. Workflow callers omit it. */
  emitTerminal?: (bytes: Uint8Array) => void;
}

export type InteractTerminalActionResult = {
  result: Record<string, unknown>;
};

export async function performInteractTerminalAction(
  args: PerformInteractTerminalActionArgs,
): Promise<InteractTerminalActionResult> {
  const {
    action,
    sessionId,
    chatId,
    input,
    timeoutMs,
    ptySessionManager,
    abortSignal,
    emitTerminal,
  } = args;

  // Chain emit calls through a per-invocation queue so writer FIFO is
  // preserved and onData callbacks stay fire-and-forget. When `emitTerminal`
  // is omitted (workflow caller), emit is a no-op but still satisfies
  // `waitForOutput`'s required `onChunk` parameter.
  let emitQueue: Promise<void> = Promise.resolve();
  const emit = emitTerminal
    ? (bytes: Uint8Array): void => {
        emitQueue = emitQueue
          .then(() => emitTerminal(bytes))
          .catch((err) =>
            console.error("[interact-terminal-impl] emit failed:", err),
          );
      }
    : (_bytes: Uint8Array): void => {
        // no-op
      };
  const drainEmit = () => emitQueue;

  const errorResult = (error: string): InteractTerminalActionResult => ({
    result: { output: "", error },
  });

  const getSessionOrError = (
    actionName: string,
  ): { session: PtySession } | { error: InteractTerminalActionResult } => {
    if (!sessionId) {
      return {
        error: errorResult(`action=${actionName} requires \`session\`.`),
      };
    }
    const found = ptySessionManager.get(chatId, sessionId);
    if (!found) {
      return { error: errorResult(`Session ${sessionId} not found.`) };
    }
    return { session: found };
  };

  const emitPriorContext = (session: PtySession) => {
    if (emitTerminal) {
      const prior = ptySessionManager.snapshot(session);
      if (prior.byteLength > 0) emit(prior);
    }
    // Advance the cursor so the next delta-based read (wait/send) returns
    // only fresh bytes — needed in both UI-streaming and workflow modes.
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
  ): InteractTerminalActionResult => ({
    result: {
      output: "",
      error: `Session ${sid} ${during ? "exited during send" : "has exited"} (exitCode=${exited.exitCode}). Use action=view to read final output, or start a new session via run_terminal_cmd.`,
      exited,
    },
  });

  // ─── Handler: send ─────────────────────────────────────────────────────
  const handleSend = async (): Promise<InteractTerminalActionResult> => {
    if (input === undefined || input.length === 0) {
      return errorResult(
        'action=send requires `input`. To submit just Enter (e.g. to terminate a Python multi-line block or accept a default prompt), pass input="Enter" or input="\\n".',
      );
    }
    const lookup = getSessionOrError("send");
    if ("error" in lookup) return lookup.error;
    const { session } = lookup;

    // Fast-fail if the PTY already exited — otherwise sendInput on E2B
    // rejects with an opaque `[not_found] process with pid N not found`
    // that doesn't tell the model the session is dead.
    const priorExit = peekSessionExit(session);
    if (priorExit) return exitedSendError(sessionId, priorExit, false);

    emitPriorContext(session);

    const bytes = translateInput(input);
    if (bytes.byteLength > MAX_INPUT_BYTES_PER_SEND) {
      return errorResult(
        `Input exceeds MAX_INPUT_BYTES_PER_SEND=${MAX_INPUT_BYTES_PER_SEND} (got ${bytes.byteLength}).`,
      );
    }
    try {
      await session.handle.sendInput(bytes);
    } catch (err) {
      const raceExit = peekSessionExit(session);
      if (raceExit) return exitedSendError(sessionId, raceExit, true);
      return errorResult(
        `Failed to send input: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    session.lastActivityAt = Date.now();
    const delta = await waitForOutput(
      session,
      SEND_IMMEDIATE_OUTPUT_WINDOW_MS,
      abortSignal,
      emit,
      (s) => ptySessionManager.consumeDelta(s),
    );
    await drainEmit();
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
  const handleWait = async (): Promise<InteractTerminalActionResult> => {
    const lookup = getSessionOrError("wait");
    if ("error" in lookup) return lookup.error;
    const { session } = lookup;

    emitPriorContext(session);

    const alreadyExited = await peekExited(session);
    const delta = await waitForOutput(
      session,
      timeoutMs,
      abortSignal,
      emit,
      (s) => ptySessionManager.consumeDelta(s),
      { quietMs: WAIT_QUIET_WINDOW_MS },
    );
    await drainEmit();
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
  const handleView = async (): Promise<InteractTerminalActionResult> => {
    const lookup = getSessionOrError("view");
    if ("error" in lookup) return lookup.error;
    const { session } = lookup;

    const snapshot = ptySessionManager.snapshot(session);
    if (emitTerminal && snapshot.byteLength > 0) emit(snapshot);
    await drainEmit();
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
  const handleKill = async (): Promise<InteractTerminalActionResult> => {
    const lookup = getSessionOrError("kill");
    if ("error" in lookup) return lookup.error;
    const { session } = lookup;

    const exitPromise = session.handle.exited;
    await ptySessionManager.close(chatId, session.sessionId);
    const exit = await exitPromise.catch(() => ({ exitCode: null }));
    return {
      result: {
        output: "Successfully killed interactive shell.",
        exitCode: exit.exitCode,
      },
    };
  };

  switch (action) {
    case "send":
      return handleSend();
    case "wait":
      return handleWait();
    case "view":
      return handleView();
    case "kill":
      return handleKill();
    default:
      return errorResult(`Unknown action: ${action as string}`);
  }
}
