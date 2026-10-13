import { CentrifugoPublishQueue } from "./centrifugo-transport";

type Message = Record<string, unknown>;
type Operation = { kind: "command" | "file" | "pty"; id: string };

export function sandboxOperationChannel(
  userId: string,
  connectionId: string,
  kind: Operation["kind"],
  id: string,
): string {
  // Never accept a caller-supplied destination or Centrifugo channel syntax.
  for (const part of [userId, connectionId, id]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(part))
      throw new Error("Invalid relay operation identity");
  }
  const channel = `sandbox:operation:${connectionId}:${kind}:${id}#${userId}`;
  if (channel.length > 255)
    throw new Error("Relay operation channel is too long");
  return channel;
}

function operation(message: Message): Operation | undefined {
  if (
    [message.commandId, message.requestId, message.sessionId].filter(
      (value) => typeof value === "string",
    ).length !== 1
  )
    return;
  if (typeof message.commandId === "string")
    return { kind: "command", id: message.commandId };
  if (typeof message.requestId === "string")
    return { kind: "file", id: message.requestId };
  if (typeof message.sessionId === "string")
    return { kind: "pty", id: message.sessionId };
}

const START_TYPES = new Set([
  "command",
  "file_stat",
  "file_read",
  "file_write",
  "file_append",
  "file_remove",
  "file_list",
  "pty_create",
]);
const CONTROL_TYPES = new Set([
  "command_cancel",
  "pty_input",
  "pty_resize",
  "pty_kill",
]);
const END_TYPES = new Set([
  "exit",
  "error",
  "file_ok",
  "file_error",
  "file_stat_result",
  "file_read_result",
  "file_list_result",
  "pty_exit",
  "pty_error",
]);

interface ChannelSubscription {
  subscribe(): unknown;
  unsubscribe(): unknown;
  removeAllListeners(): unknown;
  ready(timeout: number): Promise<void>;
  publish(data: unknown): Promise<unknown>;
  on(event: "publication", handler: (ctx: { data: unknown }) => void): unknown;
  on(event: "error", handler: () => void): unknown;
}

type Route<S extends ChannelSubscription> = {
  subscription: S;
  queue: CentrifugoPublishQueue;
  timer: ReturnType<typeof setTimeout>;
};

/** Owns client subscriptions for opted-in operations. Legacy requests stay on the connection channel. */
export class OperationChannelRouter<S extends ChannelSubscription> {
  private routes = new Map<string, Route<S>>();
  private closed = new Set<string>();
  private legacy = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private client: {
      newSubscription(channel: string): S;
      removeSubscription(subscription: S): unknown;
    },
    private userId: string,
    private connectionId: string,
  ) {}

  private key(op: Operation): string {
    return `${op.kind}:${op.id}`;
  }

  private deadline(message: Message, op: Operation): number {
    // Allow the server's full one-hour PTY lifetime and a cleanup grace period.
    return op.kind === "pty"
      ? 65 * 60_000
      : (typeof message.timeout === "number" && Number.isFinite(message.timeout)
          ? Math.max(30_000, Math.min(message.timeout, 24 * 60 * 60_000))
          : 120_000) + 60_000;
  }

  /** Subscribe before executing. Repeated start publications never replay an operation. */
  async dispatch(
    value: unknown,
    handle: (message: Message) => void,
  ): Promise<void> {
    if (!value || typeof value !== "object") return;
    const message = value as Message;
    if (this.stopped || message.targetConnectionId !== this.connectionId)
      return;
    const op = operation(message);
    if (
      op &&
      START_TYPES.has(String(message.type)) &&
      (this.routes.has(this.key(op)) ||
        this.closed.has(this.key(op)) ||
        this.legacy.has(this.key(op)))
    )
      return;
    if (message.operationChannel !== true) {
      if (
        op &&
        (START_TYPES.has(String(message.type)) ||
          CONTROL_TYPES.has(String(message.type)))
      ) {
        const key = this.key(op);
        if (
          !this.legacy.has(key) &&
          !this.routes.has(key) &&
          !this.closed.has(key)
        ) {
          this.legacy.set(
            key,
            setTimeout(() => this.closeLegacy(key), this.deadline(message, op)),
          );
        }
      }
      handle(message);
      return;
    }
    if (!op || !START_TYPES.has(String(message.type))) return;
    if (
      op.kind !==
      (message.type === "command"
        ? "command"
        : message.type === "pty_create"
          ? "pty"
          : "file")
    )
      return;
    const key = this.key(op);
    if (this.routes.size >= 100)
      throw new Error("Too many active relay operations");
    const subscription = this.client.newSubscription(
      sandboxOperationChannel(this.userId, this.connectionId, op.kind, op.id),
    );
    const route: Route<S> = {
      subscription,
      queue: new CentrifugoPublishQueue(async (fragment) => {
        if (this.stopped || this.routes.get(key) !== route)
          throw new Error("Relay operation is closed");
        await subscription.publish(fragment);
      }),
      timer: setTimeout(() => this.close(key), this.deadline(message, op)),
    };
    this.routes.set(key, route);
    let started = false;
    const pendingControls: Message[] = [];
    subscription.on("publication", ({ data }) => {
      // Ongoing controls are small direct messages. Do not reassemble our own
      // large response fragments echoed to the publishing subscriber.
      const control =
        data && typeof data === "object" ? (data as Message) : null;
      if (
        !control ||
        control.targetConnectionId !== this.connectionId ||
        !CONTROL_TYPES.has(String(control.type))
      )
        return;
      const target = operation(control);
      if (
        target &&
        this.key(target) === key &&
        this.routes.get(key) === route &&
        (op.kind === "command"
          ? control.type === "command_cancel"
          : op.kind === "pty" && String(control.type).startsWith("pty_"))
      ) {
        if (started) handle(control);
        else if (pendingControls.length < 32) pendingControls.push(control);
      }
    });
    subscription.on("error", () => {
      /* readiness/publish failures propagate to the operation */
    });
    subscription.subscribe();
    try {
      await subscription.ready(5000);
      if (this.stopped || this.routes.get(key) !== route) return;
      await route.queue.publish({
        type: "operation_ready",
        [`${op.kind === "file" ? "request" : op.kind === "pty" ? "session" : "command"}Id`]:
          op.id,
      });
      if (!this.stopped && this.routes.get(key) === route) {
        handle(message);
        started = true;
        for (const control of pendingControls) {
          if (this.routes.get(key) !== route) break;
          handle(control);
        }
        pendingControls.length = 0;
      }
    } catch (error) {
      this.close(key);
      throw error;
    }
  }

  /** Publish only for requests accepted by this connection; late/unknown output is discarded. */
  async publish(
    message: Message,
    publishLegacy: (message: Message) => Promise<unknown> = async () => {},
  ): Promise<void> {
    if (this.stopped) return;
    const op = operation(message);
    if (!op) return;
    const key = this.key(op);
    const route = this.routes.get(key);
    if (route) {
      await route.queue.publish(message);
      if (END_TYPES.has(String(message.type))) this.close(key);
    } else if (this.legacy.has(key)) {
      await publishLegacy(message);
      if (END_TYPES.has(String(message.type))) this.closeLegacy(key);
    }
  }

  private closeLegacy(key: string): void {
    clearTimeout(this.legacy.get(key));
    this.legacy.delete(key);
    this.rememberClosed(key);
  }

  private rememberClosed(key: string): void {
    this.closed.add(key);
    // Bound duplicate-start history. Unknown responses still cannot fall back.
    if (this.closed.size > 4096)
      this.closed.delete(this.closed.values().next().value!);
  }

  private close(key: string): void {
    const route = this.routes.get(key);
    if (!route) return;
    this.routes.delete(key);
    this.rememberClosed(key);
    clearTimeout(route.timer);
    route.subscription.unsubscribe();
    route.subscription.removeAllListeners();
    this.client.removeSubscription(route.subscription);
  }

  stop(): void {
    this.stopped = true;
    for (const key of this.routes.keys()) this.close(key);
    for (const key of this.legacy.keys()) this.closeLegacy(key);
    this.closed.clear();
  }
}
