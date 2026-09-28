import { randomUUID } from "node:crypto";
import type { PublicationContext, Subscription } from "centrifuge";
import { estimateRelayPayloadBytes, relayTrafficSampleRate } from "./traffic";

/** Count publications for the entire wire subscription, including time spent
 * waiting for other connections' presence replies. Never retain payloads. */
export function trackPresenceTraffic(
  sub: Subscription,
  context: {
    source: "presence-route" | "sandbox-manager";
    userId: string;
    connectionId: string;
    chatId?: string;
  },
): (presenceReliable: boolean) => void {
  const probeId = randomUUID();
  const started = Date.now();
  let publications = 0;
  let bytes = 0;
  let subscriptionEvents = 0;
  let finished = false;

  const onPublication = (ctx: PublicationContext) => {
    publications++;
    bytes += estimateRelayPayloadBytes(ctx.data);
  };
  const onSubscribed = () => {
    subscriptionEvents++;
  };
  sub.on("publication", onPublication);
  sub.on("subscribed", onSubscribed);

  return (presenceReliable) => {
    if (finished) return;
    finished = true;
    sub.removeListener("publication", onPublication);
    sub.removeListener("subscribed", onSubscribed);
    const sampleRate = relayTrafficSampleRate(probeId, bytes);
    if (sampleRate === null) return;

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "local_relay_presence_traffic",
        source: context.source,
        user_id: context.userId,
        connection_id: context.connectionId,
        chat_id: context.chatId ?? null,
        probe_id: probeId,
        sample_rate: sampleRate,
        presence_reliable: presenceReliable,
        received_publications: publications,
        received_payload_bytes_estimate: bytes,
        subscription_events: subscriptionEvents,
        duration_ms: Date.now() - started,
      }),
    );
  };
}
