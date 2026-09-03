/**
 * MIOSA PTY adapter.
 *
 * Creates a PtyHandle backed by MIOSA's sandbox terminal WebSocket, so the
 * interactive exec branch in run-terminal-cmd.ts can treat MIOSA sandboxes the
 * same way it treats E2B and Centrifugo ones.
 *
 * Message flow:
 *   POST /api/v1/sandboxes/:id/terminal   →  { session_id, ws_url, ... }
 *   Client  ──── binary frames ────▶  PTY stdin
 *   Client  ──── {"type":"resize"} ─▶  PTY resize
 *   Server  ◀─── binary frames ─────  PTY stdout/stderr
 *   DELETE /api/v1/sandboxes/:id/terminal/:session_id  →  closes the PTY
 *
 * The upgrade authenticates with `Authorization: Bearer <MIOSA_API_KEY>`, the
 * same credential the SDK client uses. MIOSA also mints a short-lived
 * `stream_auth` for browser clients that cannot set headers; this adapter runs
 * server-side and does not need it.
 */

import WebSocket from "ws";
import type { CreatePtyOptions, PtyHandle } from "./e2b-pty-adapter";
import type { MiosaSandbox } from "./miosa-sandbox";

const LOG_PREFIX = "[miosa-pty-adapter]";

/** How long to wait for the WebSocket upgrade before giving up. */
const CONNECT_TIMEOUT_MS = 15_000;

type TerminalSession = {
  sessionId: string;
  wsUrl: string;
};

/**
 * MIOSA returns snake_case JSON. The SDK passes it through untyped, so read
 * both spellings rather than assuming one — a silent `undefined` here would
 * surface much later as an unexplained WebSocket failure.
 */
function readTerminalSession(raw: Record<string, unknown>): TerminalSession {
  const sessionId = (raw.session_id ?? raw.sessionId) as string | undefined;
  const wsUrl = (raw.ws_url ?? raw.wsUrl) as string | undefined;

  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error(`${LOG_PREFIX} terminal create returned no session_id`);
  }
  if (typeof wsUrl !== "string" || wsUrl === "") {
    throw new Error(`${LOG_PREFIX} terminal create returned no ws_url`);
  }

  return { sessionId, wsUrl };
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new TextEncoder().encode(String(data ?? ""));
}

async function deleteTerminalSession(
  sandbox: MiosaSandbox,
  sessionId: string,
): Promise<void> {
  try {
    await sandbox.sdkSandbox.terminal.delete(sessionId);
  } catch {
    // Best effort: preserve the original connection error for the caller.
  }
}

/**
 * Create a PtyHandle for a MIOSA sandbox.
 *
 * Resolves once the WebSocket is open, so callers can write to the PTY
 * immediately without racing the upgrade.
 */
export async function createMiosaPtyHandle(
  sandbox: MiosaSandbox,
  opts: CreatePtyOptions,
): Promise<PtyHandle> {
  const apiKey = process.env.MIOSA_API_KEY;
  if (!apiKey) {
    throw new Error(`${LOG_PREFIX} MIOSA_API_KEY is not set`);
  }

  const created = (await sandbox.sdkSandbox.terminal.create({
    cols: opts.cols,
    rows: opts.rows,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.envs ? { env: opts.envs } : {}),
  })) as Record<string, unknown>;

  const rawSessionId = created.session_id ?? created.sessionId;
  let terminalSession: TerminalSession;
  try {
    terminalSession = readTerminalSession(created);
  } catch (error) {
    if (typeof rawSessionId === "string" && rawSessionId !== "") {
      await deleteTerminalSession(sandbox, rawSessionId);
    }
    throw error;
  }
  const { sessionId, wsUrl } = terminalSession;
  let deletePromise: Promise<void> | undefined;
  const deleteRemoteSession = (): Promise<void> => {
    deletePromise ??= deleteTerminalSession(sandbox, sessionId);
    return deletePromise;
  };

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    await deleteRemoteSession();
    throw error;
  }

  const listeners = new Set<(bytes: Uint8Array) => void>();
  let exitResolved = false;
  let resolveExited: (value: { exitCode: number | null }) => void = () => {};
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveExited = resolve;
  });

  // The PTY is gone once the socket closes, however that happens. Settling
  // once here means an abnormal close still releases anyone awaiting `exited`
  // instead of hanging until the session manager's max-lifetime timer fires.
  const settleExited = (exitCode: number | null) => {
    if (exitResolved) return;
    exitResolved = true;
    resolveExited({ exitCode });
  };

  ws.on("message", (data) => {
    const bytes = toUint8Array(data);
    for (const cb of listeners) {
      try {
        cb(bytes);
      } catch {
        // A throwing consumer must not tear down the stream for the others.
      }
    }
  });

  ws.on("close", (code) => {
    settleExited(code === 1000 ? 0 : null);
    if (code !== 1000) void deleteRemoteSession();
  });
  ws.on("error", () => {
    settleExited(null);
    void deleteRemoteSession();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // already gone
        }
        reject(
          new Error(
            `${LOG_PREFIX} timed out after ${CONNECT_TIMEOUT_MS}ms connecting to the terminal stream`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(
          err instanceof Error
            ? err
            : new Error(`${LOG_PREFIX} terminal stream failed to open`),
        );
      });
    });
  } catch (error) {
    try {
      ws.terminate();
    } catch {
      // already gone
    }
    await deleteRemoteSession();
    throw error;
  }

  const send = (payload: Uint8Array | string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(payload);
  };

  return {
    // MIOSA addresses the PTY by session id, not by host pid. The session
    // manager only uses `pid` as an opaque handle, so a stable non-zero
    // placeholder keeps its bookkeeping intact.
    get pid() {
      return 1;
    },

    async sendInput(bytes: Uint8Array): Promise<void> {
      send(bytes);
    },

    async resize(cols: number, rows: number): Promise<void> {
      send(JSON.stringify({ type: "resize", cols, rows }));
    },

    async kill(): Promise<void> {
      // Delete the server-side session first: closing only the socket would
      // leave the PTY running in the sandbox until it idled out.
      await deleteRemoteSession();
      try {
        ws.close();
      } catch {
        // already closed
      }
      settleExited(null);
    },

    onData(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    exited,
  };
}
