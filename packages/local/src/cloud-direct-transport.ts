import type WebSocket from "ws";

const MAX_DIRECT_MESSAGE_BYTES = 4 * 1024 * 1024;
const WS_OPEN = 1;
const WS_CLOSED = 3;

type DirectMessage = Record<string, unknown>;

export interface DirectTransportDisconnect {
  commandIds: string[];
  sessionIds: string[];
}

export interface DirectTransportHandlers {
  onMessage: (message: unknown) => void;
  onDisconnect: (pending: DirectTransportDisconnect) => void;
}

function correlationKey(message: DirectMessage): string | null {
  if (typeof message.commandId === "string") {
    return `command:${message.commandId}`;
  }
  if (typeof message.sessionId === "string") {
    return `pty:${message.sessionId}`;
  }
  return null;
}

function isTerminalResponse(message: DirectMessage): boolean {
  if (message.type === "command_cancel_result") {
    return message.canceled === true;
  }
  return (
    message.type === "exit" ||
    message.type === "error" ||
    message.type === "pty_exit" ||
    message.type === "pty_error"
  );
}

/**
 * Routes AWS endpoint WebSocket frames between Trigger.dev and the in-process
 * command runner. AWS authenticates the upgrade before the socket reaches this
 * server; correlation ownership keeps concurrent Trigger runs isolated inside
 * a user-scoped MicroVM.
 */
export class CloudDirectTransport {
  private readonly clients = new Set<WebSocket>();
  private readonly owners = new Map<string, WebSocket>();
  private handlers: DirectTransportHandlers | null = null;

  get active(): boolean {
    return this.handlers !== null;
  }

  start(handlers: DirectTransportHandlers): void {
    this.handlers = handlers;
  }

  accept(socket: WebSocket): void {
    if (!this.handlers) {
      socket.close(1013, "sandbox_not_ready");
      return;
    }

    this.clients.add(socket);
    socket.on("message", (data, isBinary) => {
      if (isBinary || !this.handlers) return;
      const text = data.toString();
      if (Buffer.byteLength(text, "utf8") > MAX_DIRECT_MESSAGE_BYTES) {
        socket.close(1009, "message_too_large");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        socket.close(1007, "invalid_json");
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const message = parsed as DirectMessage;

      if (message.type === "transport_ping") {
        socket.send(
          JSON.stringify({
            type: "transport_pong",
            nonce: typeof message.nonce === "string" ? message.nonce : null,
          }),
        );
        return;
      }

      const key = correlationKey(message);
      if (key) {
        const owner = this.owners.get(key);
        if (owner && owner !== socket) return;
        this.owners.set(key, socket);
      }
      this.handlers.onMessage(parsed);
    });

    const remove = () => this.removeClient(socket);
    socket.once("close", remove);
    socket.once("error", remove);
    socket.send(JSON.stringify({ type: "transport_ready" }));
  }

  async publish(message: DirectMessage): Promise<void> {
    const key = correlationKey(message);
    const owner = key ? this.owners.get(key) : undefined;
    if (!owner || owner.readyState !== WS_OPEN) {
      throw new Error("Direct sandbox response has no active owner");
    }
    await new Promise<void>((resolve, reject) => {
      owner.send(JSON.stringify(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (key && isTerminalResponse(message)) this.owners.delete(key);
  }

  async stop(): Promise<void> {
    this.handlers = null;
    this.owners.clear();
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.all(
      clients.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WS_CLOSED) {
              resolve();
              return;
            }
            const timeout = setTimeout(() => {
              socket.terminate();
              resolve();
            }, 1_000);
            socket.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
            socket.close(1001, "sandbox_lifecycle_transition");
          }),
      ),
    );
  }

  private removeClient(socket: WebSocket): void {
    if (!this.clients.delete(socket)) return;
    const commandIds: string[] = [];
    const sessionIds: string[] = [];
    for (const [key, owner] of this.owners) {
      if (owner !== socket) continue;
      this.owners.delete(key);
      if (key.startsWith("command:")) commandIds.push(key.slice(8));
      else if (key.startsWith("pty:")) sessionIds.push(key.slice(4));
    }
    if (commandIds.length > 0 || sessionIds.length > 0) {
      this.handlers?.onDisconnect({ commandIds, sessionIds });
    }
  }
}
