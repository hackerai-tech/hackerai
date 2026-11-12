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

/** Optional diagnostic clock; a fault must never become or block a stop. */
function monotonicNow(): number | undefined {
  try {
    const now = performance.now();
    return Number.isFinite(now) ? now : undefined;
  } catch {
    return undefined;
  }
}

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
  /** Set at the run's first subscription; a setup close is not the run's. */
  armed: boolean;
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
  let hadPositivePresence = false;
  let lastPositivePresenceAt: number | undefined;
  let clientStateAtStop: LocalStopClientState | undefined;
  // Only the current socket attempt's own close listener, and its pair if the
  // native close preceded the first stop. Never the reason, URL or frames.
  let socketWatch: SocketWatch | undefined;
  let socketClose: ReturnType<typeof readSocketClose>;
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
    subscription?.removeAllListeners();
    client?.removeAllListeners();
    // Before our own disconnect, which would always report "disconnected".
    clientStateAtStop = readClientState(client);
    client?.disconnect();
  };
  // The first cause wins; stop() makes every later trigger a no-op.
  const lost = (reason: LocalStopReason, callback?: { context: unknown }) => {
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
        // Only the observer state callbacks; never their reason or channel.
        ...(callback && {
          callbackCode: readCallbackCode(callback.context),
          clientState: clientStateAtStop,
          ...socketClose,
        }),
      }),
    );
  };
  const check = async () => {
    if (stopped) return;
    clearTimeout(deadline);
    deadline = setTimeout(() => lost("presence_timeout"), PRESENCE_TIMEOUT_MS);
    try {
      const presence = await subscription!.presence();
      if (stopped) return;
      clearTimeout(deadline);
      if (!presenceHasConnectionId(presence, connectionId)) {
        lost("selected_presence_absent");
        return;
      }
      hadPositivePresence = true;
      // Unavailable now: omit the age rather than report a stale timestamp.
      lastPositivePresenceAt = monotonicNow();
      timer = setTimeout(() => void check(), PRESENCE_INTERVAL_MS);
    } catch {
      lost("presence_error");
    }
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
      { joinLeave: true },
    );
    let subscribed = false;
    subscription.on("subscribed", () => {
      if (subscribed) return;
      subscribed = true;
      if (socketWatch) socketWatch.armed = true;
      void check();
    });
    subscription.on("leave", (event) => {
      if (getConnectionIdFromPresenceClient(event.info) === connectionId)
        lost("selected_host_left");
    });
    subscription.on("subscribing", (context) => {
      if (subscribed) lost("subscription_reconnecting", { context });
    });
    subscription.on("unsubscribed", (context) =>
      lost("subscription_unsubscribed", { context }),
    );
    subscription.on("error", () => lost("subscription_error"));
    client.on("disconnected", (context) =>
      lost("observer_disconnected", { context }),
    );
    client.on("connecting", (context) => {
      if (subscribed) lost("observer_reconnecting", { context });
    });
    subscription.subscribe();
    client.connect();
  })().catch(() => lost("setup_error"));
  return stop;
}
