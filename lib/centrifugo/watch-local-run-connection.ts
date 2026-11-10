import { Centrifuge, type Subscription } from "centrifuge";
import { generateCentrifugoToken } from "./jwt";
import { sandboxConnectionChannel } from "./types";
import {
  getConnectionIdFromPresenceClient,
  presenceHasConnectionId,
} from "./presence";

// This lease belongs to one run and one connection incarnation. A new Desktop
// session may restore availability, but must never revive the interrupted run.
const PRESENCE_INTERVAL_MS = 5_000;
const PRESENCE_TIMEOUT_MS = 10_000;

export function watchLocalRunConnection({
  userId,
  connectionId,
  onLost,
}: {
  userId: string;
  connectionId: string;
  onLost: () => void;
}): () => void {
  let stopped = false;
  let client: Centrifuge | undefined;
  let subscription: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    subscription?.removeAllListeners();
    client?.removeAllListeners();
    client?.disconnect();
  };
  const lost = () => {
    if (stopped) return;
    stop();
    onLost();
  };
  const check = async () => {
    if (stopped) return;
    clearTimeout(deadline);
    deadline = setTimeout(lost, PRESENCE_TIMEOUT_MS);
    try {
      const presence = await subscription!.presence();
      if (stopped) return;
      clearTimeout(deadline);
      if (!presenceHasConnectionId(presence, connectionId)) {
        lost();
        return;
      }
      timer = setTimeout(() => void check(), PRESENCE_INTERVAL_MS);
    } catch {
      lost();
    }
  };

  // Also bound initial token/subscription setup and a relay that goes silent.
  deadline = setTimeout(lost, PRESENCE_TIMEOUT_MS);
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
        lost();
    });
    subscription.on("subscribing", () => {
      if (subscribed) lost();
    });
    subscription.on("unsubscribed", lost);
    subscription.on("error", lost);
    client.on("disconnected", lost);
    client.on("connecting", () => {
      if (subscribed) lost();
    });
    subscription.subscribe();
    client.connect();
  })().catch(lost);
  return stop;
}
