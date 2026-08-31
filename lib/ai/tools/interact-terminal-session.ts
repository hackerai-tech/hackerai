import { tool } from "ai";
import type { AnySandbox, ToolContext } from "@/types";
import type { PtySession } from "./utils/pty-session-manager";
import {
  cleanPtyForUI,
  getSessionSnapshots,
  type PtyParserLogContext,
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
  createInteractTerminalSessionToolSchema,
  interactTerminalSessionTool,
} from "./schemas";
import {
  getAgentApprovalSandboxIdentity,
  getSandboxWithFallbackGuard,
  resolveToolErrorMessage,
} from "./utils/sandbox-fallback";
import { isE2BSandbox } from "./utils/sandbox-types";
import {
  captureCloudPortScanAttempt,
  classifyCloudPortScan,
  E2B_PORT_SCAN_BLOCK_MESSAGE,
} from "./utils/cloud-port-scan-guard";

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
const MAX_AUTO_REVIEW_TERMINAL_OUTPUT_CHARS = 6_000;
const MAX_TRACKED_UNSUBMITTED_INPUT_CHARS = 32 * 1024;

type PendingInputAnalysis = {
  classification: ReturnType<typeof classifyCloudPortScan>;
  nextUnsubmittedInput: string;
};

/**
 * Mirrors the shell's current unsubmitted line closely enough to stop a scan
 * command assembled across multiple PTY sends. Control keys that cancel or
 * edit the line update the mirror, while terminal-navigation escape sequences
 * are ignored because their resulting application state cannot be inferred.
 */
function analyzePendingPtyInput(
  previousInput: string,
  bytes: Uint8Array,
): PendingInputAnalysis {
  let pending = previousInput;
  const decoded = new TextDecoder().decode(bytes);

  for (let index = 0; index < decoded.length; index += 1) {
    const char = decoded[index];

    if (char === "\r" || char === "\n") {
      const classification = classifyCloudPortScan(pending);
      if (classification) {
        return { classification, nextUnsubmittedInput: previousInput };
      }
      pending = "";
      continue;
    }

    if (char === "\x03" || char === "\x15") {
      pending = "";
      continue;
    }

    if (char === "\x7f" || char === "\x08") {
      pending = pending.slice(0, -1);
      continue;
    }

    if (char === "\x17") {
      pending = pending.replace(/\s*\S+\s*$/, "");
      continue;
    }

    const codePoint = char.codePointAt(0) ?? 0;
    if (char === "\t" || codePoint >= 0x20) pending += char;

    if (pending.length > MAX_TRACKED_UNSUBMITTED_INPUT_CHARS) {
      pending = pending.slice(-MAX_TRACKED_UNSUBMITTED_INPUT_CHARS);
    }
  }

  return {
    classification: classifyCloudPortScan(pending),
    nextUnsubmittedInput: pending,
  };
}

export const createInteractTerminalSession = (context: ToolContext) => {
  const { writer, chatId, ptySessionManager } = context;
  const ptyScopeId = context.ptyScopeId ?? chatId;
  const measureTerminalWait = <T>(operation: () => Promise<T>): Promise<T> =>
    context.measureAgentActiveTime
      ? context.measureAgentActiveTime("terminal_wait", operation)
      : operation();
  const buildPtyParserLogContext = (
    sessionId: string,
  ): PtyParserLogContext => ({
    service: context.triggerRunId ? "agent-long" : "chat-handler",
    environment:
      process.env.TRIGGER_ENV ??
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV ??
      "unknown",
    request_id: context.triggerRunId ?? process.env.VERCEL_REQUEST_ID ?? null,
    trigger_run_id: context.triggerRunId ?? null,
    chat_id: context.chatId,
    user_id: context.userID,
    session_id: sessionId,
    log_budget: context.ptyParserLogBudget,
  });

  return tool({
    ...interactTerminalSessionTool,
    inputSchema: createInteractTerminalSessionToolSchema({
      modelName: context.getCurrentModelName?.() ?? context.modelName,
    }).inputSchema,
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
        const found = ptySessionManager.get(ptyScopeId, sid);
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

      type TerminalReviewState = {
        session: PtySession;
        lastActivityAt: number;
        snapshotByteLength: number;
        bufferTruncated: boolean;
        exited: { exitCode: number | null } | null;
      };

      const captureTerminalReviewState = (session: PtySession) => {
        const snapshot = ptySessionManager.snapshot(session);
        const cleanedOutput = stripAnsi(new TextDecoder().decode(snapshot));
        const outputComplete =
          !session.bufferTruncated &&
          cleanedOutput.length <= MAX_AUTO_REVIEW_TERMINAL_OUTPUT_CHARS;
        return {
          state: {
            session,
            lastActivityAt: session.lastActivityAt,
            snapshotByteLength: snapshot.byteLength,
            bufferTruncated: session.bufferTruncated,
            exited: peekSessionExit(session),
          } satisfies TerminalReviewState,
          recentOutput: cleanedOutput.slice(
            -MAX_AUTO_REVIEW_TERMINAL_OUTPUT_CHARS,
          ),
          outputComplete,
        };
      };

      const terminalStateChanged = (
        sessionIdToCheck: string,
        expected: TerminalReviewState,
      ): boolean => {
        const current = ptySessionManager.get(chatId, sessionIdToCheck);
        if (!current || current !== expected.session) return true;
        const currentExit = peekSessionExit(current);
        return (
          current.lastActivityAt !== expected.lastActivityAt ||
          ptySessionManager.snapshot(current).byteLength !==
            expected.snapshotByteLength ||
          current.bufferTruncated !== expected.bufferTruncated ||
          currentExit?.exitCode !== expected.exited?.exitCode
        );
      };

      const requestTerminalInteractionApproval = async ({
        target,
        session,
        action,
        inputToSend,
        translatedInput,
        reviewState,
      }: {
        target: string;
        session: PtySession;
        action: "send" | "kill";
        inputToSend?: string;
        translatedInput?: string;
        reviewState: ReturnType<typeof captureTerminalReviewState>;
      }): Promise<{ denied: ActionResult } | { autoReviewed: boolean }> => {
        const approval = await context.requestToolApproval?.({
          toolCallId,
          toolName: "interact_terminal_session",
          operation: "terminal_interact",
          target,
          brief,
          autoReviewContext: {
            type: "terminal_interaction",
            interaction: target,
            action,
            sessionId: session.sessionId,
            ...(inputToSend === undefined ? {} : { input: inputToSend }),
            ...(translatedInput === undefined ? {} : { translatedInput }),
            originalCommand: session.originalCommand,
            ...(session.workingDirectory
              ? { workingDirectory: session.workingDirectory }
              : {}),
            recentOutput: reviewState.recentOutput,
            outputComplete: reviewState.outputComplete,
          },
        });
        if (!approval || approval.approved) {
          return {
            autoReviewed:
              approval?.approved === true &&
              approval.approvalSource === "auto_review",
          };
        }
        return {
          denied: {
            result: {
              output: "",
              error: approval.reason,
              approvalDenied: true,
            },
          },
        };
      };

      const changedDuringAutoReviewError = (
        sid: string,
        attemptedAction: "send" | "kill",
      ): ActionResult =>
        errorResult(
          `Session ${sid} changed while HackerAI was reviewing the action. ${attemptedAction === "send" ? "The input was not sent." : "The session was not killed."} Use action=view to refresh the terminal state, then retry the exact interaction.`,
        );

      const getMatchingSessionSandbox = async (
        session: PtySession,
      ): Promise<{ sandbox: AnySandbox } | { error: ActionResult }> => {
        try {
          const { sandbox } = await getSandboxWithFallbackGuard({
            sandboxManager: context.sandboxManager,
          });
          if (
            getAgentApprovalSandboxIdentity(sandbox) !== session.sandboxIdentity
          ) {
            return {
              error: errorResult(
                "The selected sandbox no longer matches the sandbox that created this terminal session. The action was not run. Return to the original sandbox or start a new terminal session in the current sandbox.",
              ),
            };
          }
          return { sandbox: sandbox as AnySandbox };
        } catch (error) {
          return { error: errorResult(resolveToolErrorMessage(error)) };
        }
      };

      const verifySessionSandboxIdentity = async (
        session: PtySession,
      ): Promise<ActionResult | null> => {
        const result = await getMatchingSessionSandbox(session);
        return "error" in result ? result.error : null;
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

        const sessionSandbox = await getMatchingSessionSandbox(session);
        if ("error" in sessionSandbox) return sessionSandbox.error;

        // Translate and size-check before approval so the exact bounded action
        // reaching the reviewer is the action that can subsequently execute.
        const bytes = translateInput(input);
        if (bytes.byteLength > MAX_INPUT_BYTES_PER_SEND) {
          return errorResult(
            `Input exceeds MAX_INPUT_BYTES_PER_SEND=${MAX_INPUT_BYTES_PER_SEND} (got ${bytes.byteLength}).`,
          );
        }

        const pendingInputAnalysis = analyzePendingPtyInput(
          session.unsubmittedInput,
          bytes,
        );
        const cloudPortScan = pendingInputAnalysis.classification;
        if (cloudPortScan && isE2BSandbox(sessionSandbox.sandbox)) {
          captureCloudPortScanAttempt(context, cloudPortScan);
          return {
            result: {
              output: "",
              error: E2B_PORT_SCAN_BLOCK_MESSAGE,
              commandBlocked: true,
              blockedReason: "unreliable_e2b_port_scan",
            },
          };
        }

        const reviewState = captureTerminalReviewState(session);
        const approvalResult = await requestTerminalInteractionApproval({
          target: `send to ${sessionId}: ${input}`,
          session,
          action: "send",
          inputToSend: input,
          translatedInput: new TextDecoder().decode(bytes),
          reviewState,
        });
        if ("denied" in approvalResult) return approvalResult.denied;

        const postApprovalSandbox = await getMatchingSessionSandbox(session);
        if ("error" in postApprovalSandbox) return postApprovalSandbox.error;

        if (
          approvalResult.autoReviewed &&
          terminalStateChanged(sessionId, reviewState.state)
        ) {
          return changedDuringAutoReviewError(sessionId, "send");
        }

        emitPriorContext(session);

        // Tmux key names (C-c, Up, Enter, ...) were translated before review;
        // raw text has a trailing newline normalized to CR for submission.
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
        session.unsubmittedInput = pendingInputAnalysis.nextUnsubmittedInput;
        session.lastActivityAt = Date.now();
        // Capture the immediate response chunk — prompts that echo a reply
        // ("Hello, X!") show up here. Use action=wait for processes that
        // take longer to respond.
        const delta = await measureTerminalWait(() =>
          waitForOutput(
            session,
            SEND_IMMEDIATE_OUTPUT_WINDOW_MS,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
          ),
        );
        await drainEmitQueue();
        const snapshots = await getSessionSnapshots(
          ptySessionManager,
          session,
          buildPtyParserLogContext(session.sessionId),
        );
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
        const delta = await measureTerminalWait(() =>
          waitForOutput(
            session,
            timeoutMs,
            abortSignal,
            emitTerminal,
            (s) => ptySessionManager.consumeDelta(s),
            { quietMs: WAIT_QUIET_WINDOW_MS },
          ),
        );
        await drainEmitQueue();
        const snapshots = await getSessionSnapshots(
          ptySessionManager,
          session,
          buildPtyParserLogContext(session.sessionId),
        );
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
            sessionSnapshot: await cleanPtyForUI(
              rawText,
              buildPtyParserLogContext(session.sessionId),
            ),
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

        const sandboxMismatch = await verifySessionSandboxIdentity(session);
        if (sandboxMismatch) return sandboxMismatch;

        const reviewState = captureTerminalReviewState(session);
        const approvalResult = await requestTerminalInteractionApproval({
          target: `kill ${sessionId}`,
          session,
          action: "kill",
          reviewState,
        });
        if ("denied" in approvalResult) return approvalResult.denied;

        const postApprovalSandboxMismatch =
          await verifySessionSandboxIdentity(session);
        if (postApprovalSandboxMismatch) return postApprovalSandboxMismatch;
        if (
          approvalResult.autoReviewed &&
          terminalStateChanged(sessionId, reviewState.state)
        ) {
          return changedDuringAutoReviewError(sessionId, "kill");
        }

        // Skip the snapshot dump — the user already saw the final state via
        // prior view/wait/send blocks; a one-line confirmation reads cleaner
        // in both the agent transcript and the sidebar.
        const exitPromise = session.handle.exited;
        try {
          await ptySessionManager.close(ptyScopeId, session.sessionId);
        } catch (err) {
          const retained = ptySessionManager.get(ptyScopeId, session.sessionId);
          return errorResult(
            `Failed to kill session ${sessionId}: ${err instanceof Error ? err.message : String(err)}. ${retained ? "The session was retained so cleanup can be retried." : "The bounded cleanup limit was reached, so local session tracking was removed."}`,
          );
        }
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
