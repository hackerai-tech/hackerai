import type { Centrifuge, Subscription, PublicationContext } from "centrifuge";
import { presenceHasConnectionId } from "./presence";
import { sandboxConnectionChannel } from "./types";
import { fragmentCentrifugoMessage } from "@/packages/local/src/centrifugo-transport";
import { LocalCommandRelayUnsubscribedError } from "@/lib/ai/tools/utils/local-sandbox-errors";

/** Use the connection channel only while dispatching, then stop receiving its fanout. */
export async function dispatchIsolatedOperation(
  client: Centrifuge,
  userId: string,
  connectionId: string,
  request: Record<string, unknown>,
  isActive: () => boolean,
  reply: Subscription,
): Promise<void> {
  let onReady: (ctx: PublicationContext) => void;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    onReady = ({ data }) => {
      if (data?.type !== "operation_ready") return;
      const key = request.commandId
        ? "commandId"
        : request.requestId
          ? "requestId"
          : "sessionId";
      if (data[key] === request[key]) resolve();
    };
    reply.on("publication", onReady);
  });
  // A control-channel failure can happen before we begin awaiting readiness.
  void ready.catch(() => {});
  const control = client.newSubscription(
    sandboxConnectionChannel(userId, connectionId),
  );
  control.on("error", () => {
    /* ready/publish reject with transport errors */
  });
  control.subscribe();
  try {
    await control.ready(5000);
    const presence = await control.presence();
    if (!presenceHasConnectionId(presence, connectionId))
      throw new LocalCommandRelayUnsubscribedError(connectionId);
    for (const fragment of fragmentCentrifugoMessage({
      ...request,
      operationChannel: true,
    })) {
      if (!isActive())
        throw new Error("Relay operation ended before dispatch completed");
      await control.publish(fragment);
    }
    timeout = setTimeout(
      () => rejectReady(new Error("Relay operation readiness timed out")),
      5000,
    );
    await ready;
  } finally {
    clearTimeout(timeout);
    reply.removeListener("publication", onReady!);
    control.unsubscribe();
    control.removeAllListeners();
    client.removeSubscription(control);
  }
}
