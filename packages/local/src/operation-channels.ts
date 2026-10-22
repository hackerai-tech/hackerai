import {
  CentrifugoPublishQueue,
  isCentrifugoPublishTimeout,
  RelayOutputOverflowError,
} from "./centrifugo-transport";

type Message = Record<string, unknown>;
export type Operation = { kind: "command" | "file" | "pty"; id: string };

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
  "command_output_ack",
  "command_output_resume",
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
  presence(): Promise<{
    clients: Record<string, { user: string; connInfo?: unknown }>;
  }>;
  on(event: "publication", handler: (ctx: { data: unknown }) => void): unknown;
  on(event: "error", handler: () => void): unknown;
}

type Route<S extends ChannelSubscription> = {
  subscription: S;
  queue: CentrifugoPublishQueue;
  timer: ReturnType<typeof setTimeout>;
  retainCommandOutput?: boolean;
  failed?: boolean;
};

type LegacyRoute = {
  timer: ReturnType<typeof setTimeout>;
  queue?: CentrifugoPublishQueue;
  publish?: (message: Message) => Promise<unknown>;
  failed?: boolean;
};

/** Owns client subscriptions for opted-in operations. Legacy requests stay on the connection channel. */
export class OperationChannelRouter<S extends ChannelSubscription> {
  private routes = new Map<string, Route<S>>();
  private closed = new Set<string>();
  private legacy = new Map<string, LegacyRoute>();
  private stopped = false;

  constructor(
    private client: {
      newSubscription(channel: string): S;
      removeSubscription(subscription: S): unknown;
    },
    private userId: string,
    private connectionId: string,
    private readonly stopOutput?: (operation: Operation) => void,
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
          if (this.routes.size + this.legacy.size >= 100)
            throw new Error("Too many active relay operations");
          this.legacy.set(key, {
            timer: setTimeout(
              () => this.closeLegacy(key),
              this.deadline(message, op),
            ),
          });
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
    if (this.routes.size + this.legacy.size >= 100)
      throw new Error("Too many active relay operations");
    const subscription = this.client.newSubscription(
      sandboxOperationChannel(this.userId, this.connectionId, op.kind, op.id),
    );
    const route: Route<S> = {
      subscription,
      queue: new CentrifugoPublishQueue(async (fragment) => {
        // An exit can close this route while a cancellation ACK is queued
        // behind it. Treat queued late replies like publish() treats replies
        // arriving after close: discard them, never fall back to a shared
        // channel. Actual subscription.publish failures still propagate.
        if (this.stopped || this.routes.get(key) !== route) return;
        try {
          await subscription.publish(fragment);
        } catch (error) {
          const type = (fragment as Message).type;
          // These responses are idempotent by commandId. Never replay output
          // chunks, fragments, or execution requests after uncertain delivery.
          if (
            !isCentrifugoPublishTimeout(error) ||
            (type !== "exit" && type !== "command_cancel_result")
          )
            throw error;
          if (this.stopped || this.routes.get(key) !== route) return;
          await subscription.publish(fragment);
        }
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
          ? [
              "command_cancel",
              "command_output_ack",
              "command_output_resume",
            ].includes(String(control.type))
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

  /** Desktop opts in only after recognizing the requested output protocol. */
  retainCommandOutput(commandId: string): boolean {
    const route = this.routes.get(this.key({ kind: "command", id: commandId }));
    if (!route || this.stopped) return false;
    route.retainCommandOutput = true;
    return true;
  }

  closeCommand(commandId: string): void {
    this.close(this.key({ kind: "command", id: commandId }));
  }

  /** Broker acceptance alone cannot deliver buffered output to an absent receiver. */
  async hasCommandReceiver(commandId: string): Promise<boolean> {
    const key = this.key({ kind: "command", id: commandId });
    const route = this.routes.get(key);
    // Legacy channels are shared by multiple operations, so their presence
    // cannot establish whether this command's receiver is subscribed.
    if (!route) return this.legacy.has(key);
    const presence = await route.subscription.presence();
    if (this.stopped || this.routes.get(key) !== route) return false;
    return Object.values(presence.clients).some((client) => {
      const info = client.connInfo;
      const connectionId =
        info && typeof info === "object" && "connectionId" in info
          ? info.connectionId
          : undefined;
      return client.user === this.userId && connectionId !== this.connectionId;
    });
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
    const legacy = this.legacy.get(key);
    if (route?.failed || legacy?.failed) return;
    try {
      if (route) {
        await route.queue.publish(message);
        if (END_TYPES.has(String(message.type)) && !route.retainCommandOutput)
          this.close(key);
      } else if (legacy) {
        // Legacy operations share a channel, not a backlog: one noisy producer
        // must not consume another operation's output or cancellation budget.
        legacy.publish = publishLegacy;
        legacy.queue ??= new CentrifugoPublishQueue(async (fragment) => {
          if (this.stopped || this.legacy.get(key) !== legacy || legacy.failed)
            return;
          await publishLegacy(fragment as Message);
        });
        await legacy.queue.publish(message);
        if (END_TYPES.has(String(message.type))) this.closeLegacy(key);
      }
    } catch (error) {
      if (error instanceof RelayOutputOverflowError) {
        this.failOutput(message, publishLegacy);
      }
      throw error;
    }
  }

  /** Discard incomplete output and send one terminal failure outside the full queue. */
  failOutput(
    message: Message,
    publishLegacy: (message: Message) => Promise<unknown> = async () => {},
  ): void {
    const op = operation(message);
    if (!op || this.stopped) return;
    const key = this.key(op);
    const route = this.routes.get(key);
    const legacy = this.legacy.get(key);
    const target = route ?? legacy;
    if (!target || target.failed) return;
    target.failed = true;
    const error = new RelayOutputOverflowError();
    target.queue?.close(error);
    // Stop producers independently of broker acknowledgement. The callback
    // never waits for the output queue, and subsequent success exits are ignored.
    try {
      this.stopOutput?.(op);
    } catch {
      // Cleanup failure must not prevent reporting incomplete output.
      console.error("Relay output overflow cleanup failed");
    }
    const failure = {
      type:
        op.kind === "pty"
          ? "pty_error"
          : op.kind === "file"
            ? "file_error"
            : "error",
      [op.kind === "pty"
        ? "sessionId"
        : op.kind === "file"
          ? "requestId"
          : "commandId"]: op.id,
      message: error.message,
    };
    const publish = route
      ? (value: Message) => route.subscription.publish(value)
      : (legacy?.publish ?? publishLegacy);
    // An unavailable relay can also lose the failure notice; the receiver's
    // existing disconnect/deadline handling remains authoritative in that case.
    void Promise.resolve()
      .then(() => publish(failure))
      .catch(() => {})
      .finally(() => {
        if (route) this.close(key);
        else this.closeLegacy(key);
      });
  }

  private closeLegacy(key: string): void {
    const route = this.legacy.get(key);
    clearTimeout(route?.timer);
    route?.queue?.close();
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
    route.queue.close();
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
