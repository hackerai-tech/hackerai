/**
 * Centrifugo PTY adapter.
 *
 * Creates a PtyHandle that communicates with the local runner via Centrifugo
 * pub/sub. Mirrors the interface of e2b-pty-adapter.ts so the interactive
 * exec branch in run_terminal_cmd.ts can treat both sandbox types identically.
 *
 * Message flow:
 *   Server  →  pty_create   →  Local runner
 *   Local   →  pty_ready    →  Server  (resolves create promise)
 *   Local   →  pty_data     →  Server  (fans out to onData listeners)
 *   Local   →  pty_exit     →  Server  (resolves exited promise)
 *   Local   →  pty_error    →  Server  (rejects / emits error)
 *   Server  →  pty_input    →  Local runner
 *   Server  →  pty_resize   →  Local runner
 *   Server  →  pty_kill     →  Local runner
 */

import { sandboxOperationChannel } from "@/packages/local/src/operation-channels";
import { dispatchIsolatedOperation } from "@/lib/centrifugo/dispatch-operation";
import { authorizeDesktopOperation } from "@/lib/desktop/authorized-operation";
import { awaitDispatchReadiness } from "@/lib/centrifugo/desktop-session";
import { Centrifuge, type Subscription } from "centrifuge";

import { sandboxConnectionChannel } from "@/lib/centrifugo/types";
import {
  estimateRelayPayloadBytes,
  recordRelayReceivedBytes,
} from "@/lib/centrifugo/traffic";
import {
  CentrifugoMessageReassembler,
  fragmentMatchesCorrelation,
} from "@/packages/local/src/centrifugo-transport";
import type { PtyHandle, CreatePtyOptions } from "./e2b-pty-adapter";
import type {
  CentrifugoSandbox,
  PublishedOperationRegistration,
} from "./centrifugo-sandbox";
import type { LocalUnreconciledCause } from "@/lib/chat/local-connection-stop";
import {
  createResolvableExited,
  TerminalInputRefusedError,
} from "./pty-exited-promise";

// ── Options ────────────────────────────────────────────────────────────

export interface CentrifugoPtyOptions extends CreatePtyOptions {
  /** Shell command to execute. Sent inside pty_create — NOT via sendInput. */
  command: string;
}

// ── Internal message types (outgoing to local runner) ──────────────────

interface PtyCreatePayload {
  type: "pty_create";
  sessionId: string;
  command: string;
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  targetConnectionId: string;
}

interface PtyInputPayload {
  type: "pty_input";
  sessionId: string;
  data: string;
  targetConnectionId: string;
}

interface PtyResizePayload {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
  targetConnectionId: string;
}

interface PtyKillPayload {
  type: "pty_kill";
  sessionId: string;
  targetConnectionId: string;
}

type PtyOutgoingPayload =
  PtyCreatePayload | PtyInputPayload | PtyResizePayload | PtyKillPayload;

// ── Incoming message shapes from the local runner ──────────────────────

interface PtyReadyMsg {
  type: "pty_ready";
  sessionId: string;
  pid: number;
}

interface PtyDataMsg {
  type: "pty_data";
  sessionId: string;
  data: string;
}

interface PtyExitMsg {
  type: "pty_exit";
  sessionId: string;
  exitCode: number;
}

interface PtyErrorMsg {
  type: "pty_error";
  sessionId: string;
  message: string;
}

type PtyIncomingMsg = PtyReadyMsg | PtyDataMsg | PtyExitMsg | PtyErrorMsg;

// ── Helpers ────────────────────────────────────────────────────────────

const LOG_PREFIX = "[centrifugo-pty]";

function parsePtyMessage(data: unknown): PtyIncomingMsg | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== "string") return null;
  if (typeof msg.sessionId !== "string") return null;

  switch (msg.type) {
    case "pty_ready":
      if (typeof msg.pid !== "number") return null;
      return {
        type: "pty_ready",
        sessionId: msg.sessionId,
        pid: msg.pid,
      };
    case "pty_data":
      if (typeof msg.data !== "string") return null;
      return {
        type: "pty_data",
        sessionId: msg.sessionId,
        data: msg.data,
      };
    case "pty_exit":
      if (typeof msg.exitCode !== "number") return null;
      return {
        type: "pty_exit",
        sessionId: msg.sessionId,
        exitCode: msg.exitCode,
      };
    case "pty_error":
      if (typeof msg.message !== "string") return null;
      return {
        type: "pty_error",
        sessionId: msg.sessionId,
        message: msg.message,
      };
    default:
      return null;
  }
}

// ── Public factory ─────────────────────────────────────────────────────

/**
 * Create a PtyHandle that tunnels through Centrifugo to a local runner.
 *
 * Uses the same per-connection channel as one-shot commands.
 * Filters incoming publications by `sessionId`.
 */
export async function createCentrifugoPtyHandle(
  sandbox: CentrifugoSandbox,
  opts: CentrifugoPtyOptions,
): Promise<PtyHandle> {
  const direct = sandbox as CentrifugoSandbox & {
    createPtyHandle?: (options: CentrifugoPtyOptions) => Promise<PtyHandle>;
  };
  if (typeof direct.createPtyHandle === "function") {
    return direct.createPtyHandle(opts);
  }

  const sessionId = crypto.randomUUID();
  const userId = sandbox.getUserId();
  const connectionId = sandbox.getConnectionId();
  const isolated = sandbox.supportsOperationChannels();
  const desktop = sandbox.getConnectionInfo().isDesktop === true;
  const channel = isolated
    ? sandboxOperationChannel(userId, connectionId, "pty", sessionId)
    : sandboxConnectionChannel(userId, connectionId);

  // PTY sessions can outlive one token. The SDK renews the connection token
  // before it expires (same lifetime each time) so the live session keeps its
  // connection; a renewal failure is a transport failure like any client error.
  const tokenExpSeconds = 600;
  const token = await sandbox.issueToken(tokenExpSeconds);

  const listeners = new Set<(bytes: Uint8Array) => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let pid = 0;
  let subscription: Subscription | undefined;
  let settled = false;
  let cleanedUp = false;
  let createDispatchStarted = false;
  let receivedPayloadBytesEstimate = 0;
  let unmatchedPayloadBytesEstimate = 0;
  let nextTrafficCheckpointBytes = 1024 * 1024;
  let recordedPayloadBytesEstimate = 0;
  let recordedUnmatchedPayloadBytesEstimate = 0;
  const reassembler = new CentrifugoMessageReassembler();
  // The owning run's live host readiness; absent outside a watched run.
  const gate = sandbox.getDispatchGate();
  // A watched Desktop run continues past a terminal whose outcome is unknown,
  // so its tools must say so. Ask, CLI and other hosts keep their results.
  const continuesPastUnknown =
    typeof gate?.reportUncertainExecution === "function";
  // Ends readiness waits on kill or teardown; never a published operation.
  const dispatchAbort = new AbortController();
  let registration: PublishedOperationRegistration | undefined;
  // PTY output is unsequenced and has no replay, so an active session can
  // never be reconciled after its host leaves: the returning session settles
  // it as an unknown outcome. The client stays connected so a later kill
  // still reaches the host.
  const markPublished = () => {
    registration ??= sandbox.registerPublishedOperation({
      commandId: sessionId,
      kind: "pty",
      outputComplete: () => false,
      resumeOutput: () => {},
      abandon: () => loseOutcome("host_returned_unretained", true),
    });
  };

  const client = new Centrifuge(sandbox.getWsUrl(), {
    token,
    getToken: async () => {
      // Never mint a credential for a session that has been torn down.
      if (cleanedUp) throw new Error(`${LOG_PREFIX} session closed`);
      return sandbox.issueToken(tokenExpSeconds);
    },
  });

  const { exited, resolveOnce: resolveExitedOnce } = createResolvableExited();

  const recordTraffic = () => {
    recordRelayReceivedBytes(
      "pty",
      sandbox.getRelayTrafficSource(),
      receivedPayloadBytesEstimate - recordedPayloadBytesEstimate,
      unmatchedPayloadBytesEstimate - recordedUnmatchedPayloadBytesEstimate,
      isolated ? "operation" : "connection",
    );
    recordedPayloadBytesEstimate = receivedPayloadBytesEstimate;
    recordedUnmatchedPayloadBytesEstimate = unmatchedPayloadBytesEstimate;
  };

  // Only an observed exit proves the session ended. A creation error can
  // follow native execution (e.g. no returned PID), even before pty_ready.
  let outcomeKnown = false;
  // Once this worker cannot account for the session's input or output, it is
  // a dead terminal: it may still run on the host, so it refuses input and
  // stays recorded as unknown. Nothing about it is ever published again.
  let outcomeUnknown = false;
  const loseOutcome = (cause: LocalUnreconciledCause, reconciled = false) => {
    if (outcomeKnown || outcomeUnknown) return;
    outcomeUnknown = true;
    registration?.markUnknown(cause, reconciled);
    resolveExitedOnce({
      exitCode: null,
      observationFailed: true,
      ...(continuesPastUnknown && { outcomeUnknown: true as const }),
    });
  };
  // A creation that was published but never confirmed may have started.
  const creationFailure = (message: string) => {
    const error = new Error(`${LOG_PREFIX} ${message}`);
    return registration && continuesPastUnknown
      ? Object.assign(error, { executionOutcome: "unknown" as const })
      : error;
  };
  const cleanup = (uncertain: LocalUnreconciledCause) => {
    if (cleanedUp) return;
    cleanedUp = true;
    dispatchAbort.abort();
    // The shell may still run, or (with an exit seen while the host is
    // unverified) unsequenced output may be missing: keep it recorded as
    // unknown before releasing the session. A verified host's exit stays a
    // normal end.
    if (!outcomeKnown) loseOutcome(uncertain);
    else if (gate && !gate.isReady())
      registration?.markUnknown("exit_unverified");
    else registration?.release();
    recordTraffic();
    if (subscription) {
      try {
        subscription.unsubscribe();
        subscription.removeAllListeners();
      } catch {
        // ignore
      }
    }
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  };

  // Helper to publish a message on the subscription. Wraps Centrifuge
  // errors (which may be plain objects) as Error instances so callers
  // don't see "[object Object]" from String(err).
  const publish = async (payload: PtyOutgoingPayload): Promise<void> => {
    if (!subscription) throw new Error(`${LOG_PREFIX} subscription not ready`);
    // Creation and input run commands; kill and resize stay available while
    // the host is unverified. Nothing here is ever published twice.
    const gated = payload.type === "pty_create" || payload.type === "pty_input";
    const input = payload.type === "pty_input";
    let publishing = false;
    try {
      if (input && outcomeUnknown) throw new TerminalInputRefusedError();
      if (gated) await awaitDispatchReadiness(gate, dispatchAbort.signal);
      const authorizationId = desktop
        ? await authorizeDesktopOperation(
            userId,
            connectionId,
            payload as unknown as Record<string, unknown>,
          )
        : undefined;
      if (gated) {
        // Readiness may have lapsed during authorization: read it again in
        // the tick that publishes.
        while (gate && !gate.isReady())
          await gate.waitUntilReady(dispatchAbort.signal);
        dispatchAbort.signal.throwIfAborted();
        if (payload.type === "pty_create") markPublished();
      }
      // Settled as unknown while this input waited: it is never sent.
      if (input && outcomeUnknown) throw new TerminalInputRefusedError();
      publishing = true;
      await subscription.publish({
        ...payload,
        ...(authorizationId ? { authorizationId } : {}),
      });
    } catch (err) {
      // Input that may have reached the shell, unconfirmed, is an unknown
      // execution. A failure before publication never is.
      if (input && publishing && continuesPastUnknown)
        loseOutcome("input_unconfirmed");
      if (err instanceof Error) throw err;
      const msg =
        typeof err === "string"
          ? err
          : (err as { message?: string })?.message ||
            JSON.stringify(err) ||
            "publish failed";
      throw new Error(`${LOG_PREFIX} ${payload.type} publish failed: ${msg}`);
    }
  };

  // Build the handle that will be returned once pty_ready arrives
  const handle: PtyHandle = {
    get pid() {
      return pid;
    },

    async sendInput(bytes: Uint8Array): Promise<void> {
      const payload: PtyInputPayload = {
        type: "pty_input",
        sessionId,
        data: decoder.decode(bytes),
        targetConnectionId: connectionId,
      };
      await publish(payload);
    },

    async resize(cols: number, rows: number): Promise<void> {
      const payload: PtyResizePayload = {
        type: "pty_resize",
        sessionId,
        cols,
        rows,
        targetConnectionId: connectionId,
      };
      await publish(payload);
    },

    async kill(): Promise<void> {
      const payload: PtyKillPayload = {
        type: "pty_kill",
        sessionId,
        targetConnectionId: connectionId,
      };
      // Stop any input still waiting for readiness; kill itself is ungated.
      dispatchAbort.abort();
      try {
        await publish(payload);
      } catch (err) {
        // Publish can fail if the PTY is already gone; don't mask the rest
        // of kill(), but do log so silent IPC errors stay visible.
        console.warn(`${LOG_PREFIX} pty_kill publish failed:`, err);
      }
      // Give the local runner a short window to emit pty_exit so callers
      // awaiting `exited` see the real exit code. Fall back to null if it
      // doesn't arrive — cleanup would otherwise tear down the subscription
      // and the reply would be dropped.
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      // No exit observed: the terminal may still run on the host.
      loseOutcome("kill_unconfirmed");
      cleanup("kill_unconfirmed");
    },

    onData(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    get exited() {
      return exited;
    },
  };

  // Wait for subscription + pty_ready before returning
  return new Promise<PtyHandle>((resolve, reject) => {
    const TIMEOUT_MS = 15_000;
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup("create_unconfirmed");
        reject(creationFailure(`pty_create timed out after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);

    // Transport failure handler: pre-ready we reject the create promise;
    // post-ready we resolve `exited` as a failed observation so awaiters of
    // handle.exited don't hang forever on a dropped subscription.
    const failTransport = (message: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        cleanup("create_unconfirmed");
        reject(creationFailure(message));
      } else {
        console.error(`${LOG_PREFIX} transport failed after ready: ${message}`);
        cleanup("transport_failed");
      }
    };

    subscription = client.newSubscription(channel);

    subscription.on("publication", (ctx) => {
      if (ctx.data?.type === "operation_ready") return;
      const payloadBytes = estimateRelayPayloadBytes(ctx.data);
      receivedPayloadBytesEstimate += payloadBytes;
      try {
        if (!fragmentMatchesCorrelation(ctx.data, "sessionId", sessionId)) {
          unmatchedPayloadBytesEstimate += payloadBytes;
          return;
        }
        const reassembled = reassembler.accept(ctx.data);
        if (!reassembled) return;
        const msg = parsePtyMessage(reassembled);
        if (!msg || msg.sessionId !== sessionId) {
          unmatchedPayloadBytesEstimate += payloadBytes;
          return;
        }

        switch (msg.type) {
          case "pty_ready":
            pid = msg.pid;
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              resolve(handle);
            }
            break;

          case "pty_data": {
            const bytes = encoder.encode(msg.data);
            const snapshot = Array.from(listeners);
            for (const listener of snapshot) {
              try {
                listener(bytes);
              } catch (err) {
                console.error(`${LOG_PREFIX} listener threw:`, err);
              }
            }
            break;
          }

          case "pty_exit":
            // A terminal already settled as unknown stays recorded as such.
            if (!outcomeUnknown) outcomeKnown = true;
            resolveExitedOnce({ exitCode: msg.exitCode });
            cleanup("exit_unverified");
            break;

          case "pty_error":
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              cleanup("create_unconfirmed");
              reject(creationFailure(`pty_error: ${msg.message}`));
            } else {
              console.error(
                `${LOG_PREFIX} pty_error after ready: ${msg.message}`,
              );
              cleanup("transport_failed");
            }
            break;
        }
      } finally {
        if (
          !cleanedUp &&
          receivedPayloadBytesEstimate >= nextTrafficCheckpointBytes
        ) {
          recordTraffic();
          while (receivedPayloadBytesEstimate >= nextTrafficCheckpointBytes) {
            nextTrafficCheckpointBytes *= 2;
          }
        }
      }
    });

    subscription.on("error", (ctx) => {
      failTransport(`subscription error: ${ctx.error?.message ?? "unknown"}`);
    });

    subscription.on("subscribed", () => {
      if (createDispatchStarted || cleanedUp) return;
      createDispatchStarted = true;
      // Now that we are subscribed, publish pty_create
      const createPayload: PtyCreatePayload = {
        type: "pty_create",
        sessionId,
        command: opts.command,
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.envs,
        targetConnectionId: connectionId,
      };

      const dispatch = isolated
        ? dispatchIsolatedOperation(
            client,
            userId,
            connectionId,
            createPayload as unknown as Record<string, unknown>,
            () => !cleanedUp,
            subscription!,
            markPublished,
            undefined,
            desktop,
            { gate, signal: dispatchAbort.signal },
          )
        : publish(createPayload);
      dispatch.catch((err: unknown) => {
        failTransport(
          `failed to publish pty_create: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    subscription.subscribe();
    client.connect();

    client.on("error", (ctx) => {
      failTransport(`client error: ${ctx.error?.message ?? "unknown"}`);
    });

    client.on("disconnected", (ctx) => {
      if (!cleanedUp) failTransport(`client disconnected (code ${ctx.code})`);
    });
  });
}
