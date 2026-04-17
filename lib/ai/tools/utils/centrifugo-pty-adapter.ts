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

import { Centrifuge, type Subscription } from "centrifuge";

import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import { sandboxChannel } from "@/lib/centrifugo/types";
import type { PtyHandle, CreatePtyOptions } from "./e2b-pty-adapter";
import type { CentrifugoSandbox } from "./centrifugo-sandbox";
import { createResolvableExited } from "./pty-exited-promise";

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
  targetConnectionId?: string;
}

interface PtyInputPayload {
  type: "pty_input";
  sessionId: string;
  data: string;
  targetConnectionId?: string;
}

interface PtyResizePayload {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
  targetConnectionId?: string;
}

interface PtyKillPayload {
  type: "pty_kill";
  sessionId: string;
  targetConnectionId?: string;
}

type PtyOutgoingPayload =
  | PtyCreatePayload
  | PtyInputPayload
  | PtyResizePayload
  | PtyKillPayload;

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

const PTY_INCOMING_TYPES = new Set([
  "pty_ready",
  "pty_data",
  "pty_exit",
  "pty_error",
]);

function parsePtyMessage(data: unknown): PtyIncomingMsg | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== "string" || !PTY_INCOMING_TYPES.has(msg.type)) {
    return null;
  }
  if (typeof msg.sessionId !== "string") return null;
  return data as PtyIncomingMsg;
}

// ── Public factory ─────────────────────────────────────────────────────

/**
 * Create a PtyHandle that tunnels through Centrifugo to a local runner.
 *
 * Uses the same `sandbox:user#{userId}` channel as one-shot commands.
 * Filters incoming publications by `sessionId`.
 */
export async function createCentrifugoPtyHandle(
  sandbox: CentrifugoSandbox,
  opts: CentrifugoPtyOptions,
): Promise<PtyHandle> {
  const sessionId = crypto.randomUUID();
  const userId = sandbox.getUserId();
  const connectionId = sandbox.getConnectionId();
  const channel = sandboxChannel(userId);

  // Long-lived token: PTY sessions can last minutes.
  const tokenExpSeconds = 600;
  const token = await generateCentrifugoToken(userId, tokenExpSeconds);

  const centrifugoConfig = sandbox.getConfig();
  const client = new Centrifuge(centrifugoConfig.wsUrl, { token });

  const listeners = new Set<(bytes: Uint8Array) => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let pid = 0;
  let subscription: Subscription | undefined;
  let settled = false;
  let cleanedUp = false;

  const { exited, resolveOnce: resolveExitedOnce } = createResolvableExited();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
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
    try {
      await subscription.publish(payload);
    } catch (err) {
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
      resolveExitedOnce({ exitCode: null });
      cleanup();
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
        cleanup();
        reject(
          new Error(`${LOG_PREFIX} pty_create timed out after ${TIMEOUT_MS}ms`),
        );
      }
    }, TIMEOUT_MS);

    subscription = client.newSubscription(channel);

    subscription.on("publication", (ctx) => {
      const msg = parsePtyMessage(ctx.data);
      if (!msg || msg.sessionId !== sessionId) return;

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
          resolveExitedOnce({ exitCode: msg.exitCode });
          cleanup();
          break;

        case "pty_error":
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            reject(new Error(`${LOG_PREFIX} pty_error: ${msg.message}`));
          } else {
            console.error(
              `${LOG_PREFIX} pty_error after ready: ${msg.message}`,
            );
            resolveExitedOnce({ exitCode: null });
            cleanup();
          }
          break;
      }
    });

    subscription.on("error", (ctx) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(
          new Error(
            `${LOG_PREFIX} subscription error: ${ctx.error?.message ?? "unknown"}`,
          ),
        );
      }
    });

    subscription.on("subscribed", () => {
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

      subscription!.publish(createPayload).catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          cleanup();
          reject(
            new Error(
              `${LOG_PREFIX} failed to publish pty_create: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });
    });

    subscription.subscribe();
    client.connect();

    client.on("error", (ctx) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(
          new Error(
            `${LOG_PREFIX} client error: ${ctx.error?.message ?? "unknown"}`,
          ),
        );
      }
    });
  });
}
