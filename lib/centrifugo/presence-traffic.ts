import type { PublicationContext, Subscription } from "centrifuge";
import { estimateRelayPayloadBytes, recordRelayReceivedBytes } from "./traffic";

/** Count incidental publications until the shared presence client is torn down. */
export function trackPresenceTraffic(
  sub: Subscription,
  source: "presence-route" | "sandbox-manager",
): () => void {
  let bytes = 0;
  let finished = false;
  const onPublication = (ctx: PublicationContext) => {
    bytes += estimateRelayPayloadBytes(ctx.data);
  };
  sub.on("publication", onPublication);
  return () => {
    if (finished) return;
    finished = true;
    sub.removeListener("publication", onPublication);
    // Presence subscriptions receive no operation responses of their own.
    recordRelayReceivedBytes("presence", source, bytes, bytes);
  };
}
