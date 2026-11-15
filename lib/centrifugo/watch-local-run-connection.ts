import { Centrifuge, type Subscription } from "centrifuge";
import { generateCentrifugoToken } from "./jwt";
import { sandboxConnectionChannel } from "./types";
import {
  getConnectionIdFromPresenceClient,
  presenceHasConnectionId,
} from "./presence";
import {
  LocalConnectionLostError,
  readCallbackCode,
  readClientState,
  readSocketClose,
  type LocalStopClientState,
  type LocalStopReason,
} from "@/lib/chat/local-connection-stop";

// This lease belongs to one run and one connection incarnation. A new Desktop
// session may restore availability, but must never revive the interrupted run.
const PRESENCE_INTERVAL_MS = 5_000;
const PRESENCE_TIMEOUT_MS = 10_000;
// Once the selected host is verified, an outage of this observer alone may
// recover. The window is fixed at its first interruption: neither SDK retries
// nor failed lookups extend it, and only a new positive lookup ends it.
const OBSERVER_RECOVERY_MS = 15_000;
// The SDK owns every reconnect and resubscribe; cap its jittered backoff so
// several attempts fit in the window.
const MAX_RETRY_DELAY_MS = 3_000;

function readClock(read: () => number): number | undefined {
  try {
    const now = read();
    return Number.isFinite(now) ? now : undefined;
  } catch {
    return undefined;
  }
}

/** Optional diagnostic clock; a fault must never become or block a stop. */
const monotonicNow = () => readClock(() => performance.now());
/** Also advances while suspended, when the monotonic clock may not. */
const wallNow = () => readClock(() => Date.now());

/** The runtime's WebSocket; when unreadable the SDK keeps its default path. */
function nativeWebSocket(): typeof WebSocket | undefined {
  try {
    const native = globalThis.WebSocket;
    return typeof native === "function" ? native : undefined;
  } catch {
    return undefined;
  }
}

type SocketWatch = {
  socket: WebSocket;
  listener: (event: Event) => void;
  /** Set once it carries the subscription; a setup close is not the run's. */
  armed: boolean;
};

type SocketClose = ReturnType<typeof readSocketClose>;

type Recovery = {
  timer: ReturnType<typeof setTimeout>;
  wallDeadline?: number;
  monotonicDeadline?: number;
  /** The interrupting close, kept past the SDK's own new sockets. */
  close: SocketClose;
};

export function watchLocalRunConnection({
  userId,
  connectionId,
  onLost,
}: {
  userId: string;
  connectionId: string;
  onLost: (error: LocalConnectionLostError) => void;
}): () => void {
  let stopped = false;
  let client: Centrifuge | undefined;
  let subscription: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let recovery: Recovery | undefined;
  // Bumped by every subscription change and lookup: only the current lookup
  // of the current subscription may report, and its timers die with it.
  let generation = 0;
  let subscribed = false;
  let everSubscribed = false;
  let hadPositivePresence = false;
  let lastPositivePresenceAt: number | undefined;
  let clientStateAtStop: LocalStopClientState | undefined;
  // Only the current socket attempt's own close listener, and its pair if the
  // native close preceded the first stop. Never the reason, URL or frames.
  let socketWatch: SocketWatch | undefined;
  let socketClose: SocketClose;
  const unwatchSocket = () => {
    const owned = socketWatch;
    socketWatch = undefined;
    try {
      owned?.socket.removeEventListener("close", owned.listener);
    } catch {
      // A listener left attached is no longer current, so it records nothing.
    }
  };
  const watchSocket = (socket: WebSocket) => {
    if (stopped) return;
    const owned: SocketWatch = {
      socket,
      armed: false,
      listener: (event) => {
        if (stopped || socketWatch !== owned || !owned.armed) return;
        const close = readSocketClose(event);
        if (!stopped && socketWatch === owned) socketClose = close;
      },
    };
    try {
      socket.addEventListener("close", owned.listener, { once: true });
      socketWatch = owned;
    } catch {
      // Without its EventTarget API the socket is simply not observed.
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unwatchSocket();
    clearTimeout(timer);
    clearTimeout(deadline);
    clearTimeout(recovery?.timer);
    subscription?.removeAllListeners();
    client?.removeAllListeners();
    // Before our own disconnect, which would always report "disconnected".
    clientStateAtStop = readClientState(client);
    client?.disconnect();
  };
  // The first cause wins; stop() makes every later trigger a no-op.
  const lost = (
    reason: LocalStopReason,
    observed?: { context?: unknown; close: SocketClose },
  ) => {
    if (stopped) return;
    stop();
    const now = monotonicNow();
    onLost(
      new LocalConnectionLostError(reason, {
        connectionId,
        hadPositivePresence,
        lastPositivePresenceAgeMs:
          now === undefined || lastPositivePresenceAt === undefined
            ? undefined
            : now - lastPositivePresenceAt,
        // Only the observer's own state; never a callback reason or channel.
        ...(observed && {
          callbackCode: readCallbackCode(observed.context),
          clientState: clientStateAtStop,
          ...observed.close,
        }),
      }),
    );
  };
  const callbackLost = (reason: LocalStopReason, context: unknown) =>
    lost(reason, { context, close: socketClose });
  const expire = () => {
    if (recovery) lost("observer_recovery_expired", { close: recovery.close });
  };
  // Either clock passing the deadline ends it, even if its timer is late.
  const recoveryExpired = ({ wallDeadline, monotonicDeadline }: Recovery) => {
    const wall = wallNow();
    const monotonic = monotonicNow();
    return (
      (wallDeadline !== undefined &&
        wall !== undefined &&
        wall >= wallDeadline) ||
      (monotonicDeadline !== undefined &&
        monotonic !== undefined &&
        monotonic >= monotonicDeadline)
    );
  };
  // Invalidates the current lookup and its timers. Only the first
  // interruption of an outage starts its window.
  const interrupt = () => {
    generation++;
    clearTimeout(timer);
    clearTimeout(deadline);
    if (!recovery) {
      const wall = wallNow();
      const monotonic = monotonicNow();
      recovery = {
        timer: setTimeout(expire, OBSERVER_RECOVERY_MS),
        wallDeadline:
          wall === undefined ? undefined : wall + OBSERVER_RECOVERY_MS,
        monotonicDeadline:
          monotonic === undefined
            ? undefined
            : monotonic + OBSERVER_RECOVERY_MS,
        close: socketClose,
      };
    }
    // A subscription that is still current is looked up at the normal cadence.
    if (subscribed)
      timer = setTimeout(() => void check(), PRESENCE_INTERVAL_MS);
  };
  // Before verification any observer failure still stops the run.
  const unconfirmed = (reason: LocalStopReason) => {
    if (hadPositivePresence) interrupt();
    else lost(reason);
  };
  const check = async () => {
    if (stopped || !subscribed) return;
    const current = ++generation;
    clearTimeout(timer);
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (current === generation) unconfirmed("presence_timeout");
    }, PRESENCE_TIMEOUT_MS);
    let presence: Awaited<ReturnType<Subscription["presence"]>>;
    try {
      presence = await subscription!.presence();
    } catch {
      if (!stopped && current === generation) unconfirmed("presence_error");
      return;
    }
    if (stopped || current !== generation) return;
    clearTimeout(deadline);
    if (!presenceHasConnectionId(presence, connectionId)) {
      lost("selected_presence_absent");
      return;
    }
    if (recovery) {
      if (recoveryExpired(recovery)) {
        expire();
        return;
      }
      clearTimeout(recovery.timer);
      recovery = undefined;
    }
    hadPositivePresence = true;
    // Unavailable now: omit the age rather than report a stale timestamp.
    lastPositivePresenceAt = monotonicNow();
    timer = setTimeout(() => void check(), PRESENCE_INTERVAL_MS);
  };
  // The SDK's own reconnect or resubscribe: during setup its retries are
  // bounded by the setup deadline, and before verification they still stop.
  const reconnecting = (reason: LocalStopReason, context: unknown) => {
    subscribed = false;
    if (hadPositivePresence) interrupt();
    else if (everSubscribed) callbackLost(reason, context);
  };

  // Also bound initial token/subscription setup and a relay that goes silent.
  deadline = setTimeout(() => lost("setup_timeout"), PRESENCE_TIMEOUT_MS);
  void (async () => {
    const token = await generateCentrifugoToken(userId, 3600);
    if (stopped) return;
    const wsUrl = process.env.CENTRIFUGO_WS_URL;
    if (!wsUrl) throw new Error("Missing relay configuration");
    const NativeWebSocket = nativeWebSocket();
    client = new Centrifuge(wsUrl, {
      token,
      getToken: () => generateCentrifugoToken(userId, 3600),
      maxReconnectDelay: MAX_RETRY_DELAY_MS,
      // The SDK's public constructor option: the same native socket, built
      // with the SDK's exact arguments, plus one listener of our own. A
      // construction failure reaches the SDK unchanged.
      ...(NativeWebSocket && {
        websocket: function (...args: ConstructorParameters<typeof WebSocket>) {
          unwatchSocket();
          socketClose = undefined;
          const socket = new NativeWebSocket(...args);
          watchSocket(socket);
          return socket;
        },
      }),
    });
    subscription = client.newSubscription(
      sandboxConnectionChannel(userId, connectionId),
      { joinLeave: true, maxResubscribeDelay: MAX_RETRY_DELAY_MS },
    );
    subscription.on("subscribed", () => {
      if (stopped) return;
      subscribed = true;
      everSubscribed = true;
      if (socketWatch) socketWatch.armed = true;
      void check();
    });
    subscription.on("leave", (event) => {
      if (getConnectionIdFromPresenceClient(event.info) === connectionId)
        lost("selected_host_left");
    });
    subscription.on("subscribing", (context) =>
      reconnecting("subscription_reconnecting", context),
    );
    subscription.on("unsubscribed", (context) =>
      callbackLost("subscription_unsubscribed", context),
    );
    // A failed resubscribe the SDK retries; a permanent one unsubscribes.
    subscription.on("error", () => unconfirmed("subscription_error"));
    client.on("disconnected", (context) =>
      callbackLost("observer_disconnected", context),
    );
    client.on("connecting", (context) =>
      reconnecting("observer_reconnecting", context),
    );
    subscription.subscribe();
    client.connect();
  })().catch(() => lost("setup_error"));
  return stop;
}
