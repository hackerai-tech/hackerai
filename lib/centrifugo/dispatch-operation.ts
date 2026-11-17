import type { Centrifuge, Subscription, PublicationContext } from "centrifuge";
import { presenceHasConnectionId } from "./presence";
import { sandboxConnectionChannel } from "./types";
import { fragmentCentrifugoMessage } from "@/packages/local/src/centrifugo-transport";
import { LocalCommandRelayUnsubscribedError } from "@/lib/ai/tools/utils/local-sandbox-errors";
import { authorizeDesktopOperation } from "@/lib/desktop/authorized-operation";
import {
  awaitDispatchReadiness,
  type DesktopDispatchGate,
} from "./desktop-session";

/** Publication completed, but the client's readiness reply was not observed. */
export class RelayOperationReadinessTimeout extends Error {
  constructor() {
    super("Relay operation readiness timed out");
    this.name = "RelayOperationReadinessTimeout";
  }
}

export type IsolatedOperationPhase =
  | "control_ready"
  | "presence"
  | "publish"
  | "operation_ready"
  | "ready_received";

/** Use the connection channel only while dispatching, then stop receiving its fanout. */
export async function dispatchIsolatedOperation(
  client: Centrifuge,
  userId: string,
  connectionId: string,
  request: Record<string, unknown>,
  isActive: () => boolean,
  reply: Subscription,
  onBeforePublish?: () => void,
  onPhase?: (phase: IsolatedOperationPhase) => void,
  desktop = false,
  /** The run's live host readiness; a wait it imposes ends on this signal. */
  readiness?: { gate?: DesktopDispatchGate; signal?: AbortSignal },
): Promise<void> {
  const observe = (phase: IsolatedOperationPhase) => {
    try {
      onPhase?.(phase);
    } catch {
      // Diagnostics must never change command publication or cleanup.
    }
  };
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
    observe("control_ready");
    await awaitDispatchReadiness(readiness?.gate, readiness?.signal);
    await control.ready(5000);
    observe("presence");
    const presence = await control.presence();
    if (!presenceHasConnectionId(presence, connectionId))
      throw new LocalCommandRelayUnsubscribedError(connectionId);
    observe("publish");
    const authorizationId = desktop
      ? await authorizeDesktopOperation(userId, connectionId, request)
      : undefined;
    const fragments = fragmentCentrifugoMessage({
      ...request,
      ...(authorizationId ? { authorizationId } : {}),
      operationChannel: true,
    });
    // Readiness may have lapsed during authorization. Admit again, with no
    // await between this final read and the first fragment's publication.
    const gate = readiness?.gate;
    while (gate && !gate.isReady())
      await gate.waitUntilReady(readiness?.signal);
    readiness?.signal?.throwIfAborted();
    for (const fragment of fragments) {
      if (!isActive())
        throw new Error("Relay operation ended before dispatch completed");
      onBeforePublish?.();
      await control.publish(fragment);
    }
    observe("operation_ready");
    timeout = setTimeout(
      () => rejectReady(new RelayOperationReadinessTimeout()),
      5000,
    );
    await ready;
    observe("ready_received");
  } finally {
    clearTimeout(timeout);
    reply.removeListener("publication", onReady!);
    control.unsubscribe();
    control.removeAllListeners();
    client.removeSubscription(control);
  }
}
