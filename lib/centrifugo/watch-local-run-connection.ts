import { Centrifuge, type Subscription } from "centrifuge";
import { generateCentrifugoToken } from "./jwt";
import { sandboxConnectionChannel } from "./types";
import {
  getConnectionIdFromPresenceClient,
  presenceHasConnectionId,
} from "./presence";
import {
  LocalConnectionLostError,
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
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    subscription?.removeAllListeners();
    client?.removeAllListeners();
    client?.disconnect();
  };
  // The first cause wins; stop() makes every later trigger a no-op.
  const lost = (reason: LocalStopReason) => {
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
    client = new Centrifuge(wsUrl, {
      token,
      getToken: () => generateCentrifugoToken(userId, 3600),
    });
    subscription = client.newSubscription(
      sandboxConnectionChannel(userId, connectionId),
      { joinLeave: true },
    );
    let subscribed = false;
    subscription.on("subscribed", () => {
      if (subscribed) return;
      subscribed = true;
      void check();
    });
    subscription.on("leave", (event) => {
      if (getConnectionIdFromPresenceClient(event.info) === connectionId)
        lost("selected_host_left");
    });
    subscription.on("subscribing", () => {
      if (subscribed) lost("subscription_reconnecting");
    });
    subscription.on("unsubscribed", () => lost("subscription_unsubscribed"));
    subscription.on("error", () => lost("subscription_error"));
    client.on("disconnected", () => lost("observer_disconnected"));
    client.on("connecting", () => {
      if (subscribed) lost("observer_reconnecting");
    });
    subscription.subscribe();
    client.connect();
  })().catch(() => lost("setup_error"));
  return stop;
}
