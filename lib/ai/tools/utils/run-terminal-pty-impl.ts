/**
 * Shared implementation of the interactive branch of `run_terminal_cmd`
 * (i.e. `interactive=true`). Used by both the AI-SDK tool wrapper in
 * `lib/ai/tools/run-terminal-cmd.ts` and the workflow durable step in
 * `lib/workflows/steps/terminal-steps.ts:runTerminalCmdStep`.
 *
 * The workflow caller passes no `emitTerminal` and no `caidoEnvVars` —
 * Caido is wired only by the chat handler today, and workflow PTY shows
 * up in the sidebar via the final `sessionSnapshot` rather than streamed
 * `data-terminal` events.
 */

import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox, isE2BSandbox } from "./sandbox-types";
import { createE2BPtyHandle } from "./e2b-pty-adapter";
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  type PtySessionManager,
} from "./pty-session-manager";
import { getSessionSnapshots } from "./pty-output-formatter";
import {
  waitForOutput,
  capOutput,
  stripAnsi,
  peekExited,
} from "./pty-wait-utils";

// Once an interactive PTY emits its first bytes, treat `quietMs` of silence
// as "settled" (prompt drew, REPL banner finished, etc.). Lets `bash`/`python3`
// return in ~half a second instead of blocking the user-supplied timeout
// ceiling. The agent can follow up with action=wait/send.
const INTERACTIVE_QUIET_WINDOW_MS = 500;

export interface RunInteractivePtyArgs {
  /** Resolved sandbox object (E2B or Centrifugo). */
  sandbox: AnySandbox;
  command: string;
  chatId: string;
  effectiveStreamTimeoutMs: number;
  ptySessionManager: PtySessionManager;
  /** Optional Caido proxy env vars (chat-handler only; workflow omits). */
  caidoEnvVars?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** Optional raw-byte sink for live UI streaming. Workflow callers omit it. */
  emitTerminal?: (bytes: Uint8Array) => void;
  /**
   * Called once the PTY session is created. Lets the caller stamp the new
   * sessionId onto its own `data-terminal` emitters (which were constructed
   * before the id existed). Workflow callers can ignore.
   */
  onSessionCreated?: (sessionId: string) => void;
}

export type RunInteractivePtyResult = { result: Record<string, unknown> };

export async function runInteractivePty(
  args: RunInteractivePtyArgs,
): Promise<RunInteractivePtyResult> {
  const {
    sandbox,
    command,
    chatId,
    effectiveStreamTimeoutMs,
    ptySessionManager,
    caidoEnvVars,
    abortSignal,
    emitTerminal,
    onSessionCreated,
  } = args;

  const isCentrifugo = isCentrifugoSandbox(sandbox);
  const isE2B = isE2BSandbox(sandbox);

  if (!isE2B && !isCentrifugo) {
    return {
      result: {
        output: "",
        exitCode: 1,
        error: "Interactive PTY requires E2B or local (Centrifugo) sandbox.",
      },
    };
  }

  const cols = DEFAULT_PTY_COLS;
  const rows = DEFAULT_PTY_ROWS;

  const emit = emitTerminal
    ? emitTerminal
    : (_bytes: Uint8Array): void => {
        // no-op when no UI writer is wired (workflow caller)
      };

  try {
    const session = await ptySessionManager.create(chatId, {
      cols,
      rows,
      createHandle: async () => {
        if (isCentrifugo) {
          const { createCentrifugoPtyHandle } =
            await import("./centrifugo-pty-adapter");
          return createCentrifugoPtyHandle(sandbox, {
            command,
            cols,
            rows,
            envs: caidoEnvVars,
          });
        }
        return createE2BPtyHandle(sandbox, {
          cols,
          rows,
          envs: caidoEnvVars,
        });
      },
    });

    onSessionCreated?.(session.sessionId);

    // For E2B, the PTY starts a bare shell — fire the command + Enter so
    // the shell actually runs it. Centrifugo passes the command in
    // pty_create and the local runner spawns it directly.
    if (!isCentrifugo) {
      await session.handle.sendInput(new TextEncoder().encode(command + "\n"));
    }
    session.lastActivityAt = Date.now();

    const delta = await waitForOutput(
      session,
      effectiveStreamTimeoutMs,
      abortSignal,
      emit,
      (s) => ptySessionManager.consumeDelta(s),
      { quietMs: INTERACTIVE_QUIET_WINDOW_MS },
    );
    const snapshots = await getSessionSnapshots(ptySessionManager, session);
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
        error:
          err instanceof Error
            ? err.message
            : "Failed to create interactive PTY session.",
      },
    };
  }
}
