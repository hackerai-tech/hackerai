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

  // exited promise — resolved when pty_exit arrives
  let resolveExited: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveExited = resolve;
  });

  const cleanup = () => {
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

  // Helper to publish a message on the subscription
  const publish = async (payload: PtyOutgoingPayload): Promise<void> => {
    if (!subscription) throw new Error(`${LOG_PREFIX} subscription not ready`);
    await subscription.publish(payload);
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
      await publish(payload);
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
          resolveExited({ exitCode: msg.exitCode });
          cleanup();
          break;

        case "pty_error":
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            reject(new Error(`${LOG_PREFIX} pty_error: ${msg.message}`));
          } else {
            // Post-creation error — resolve exited with null exitCode
            console.error(
              `${LOG_PREFIX} pty_error after ready: ${msg.message}`,
            );
            resolveExited({ exitCode: null });
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
