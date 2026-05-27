import { NextRequest, NextResponse } from "next/server";
import { Centrifuge, type Subscription } from "centrifuge";
import { getUserID } from "@/lib/auth/get-user-id";
import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { phLogger } from "@/lib/posthog/server";
import { sandboxConnectionChannel } from "@/lib/centrifugo/types";

interface CentrifugoPresenceResult {
  clients?: Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const wsUrl = process.env.CENTRIFUGO_WS_URL;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  if (!wsUrl) {
    return NextResponse.json(
      { error: "Centrifugo not configured" },
      { status: 500 },
    );
  }

  // Fetch connection metadata from Convex before probing per-connection
  // Centrifugo channels. The previous shared per-user presence channel exposed
  // every connection id to any same-user subscriber.
  if (!convexUrl || !serviceKey) {
    return NextResponse.json({
      connections: [],
      onlineCount: 0,
    });
  }

  const convex = new ConvexHttpClient(convexUrl);
  const connections = await convex.query(
    api.localSandbox.listConnectionsForBackend,
    { serviceKey, userId },
  );

  const onlineConnectionIds = new Set<string>();
  let presenceReliable = false;

  let client: Centrifuge | null = null;
  const subscriptions: Subscription[] = [];
  try {
    const token = await generateCentrifugoToken(userId, 30);
    client = new Centrifuge(wsUrl, { token });

    const probes = connections.map(
      (connection) =>
        new Promise<void>((resolve, reject) => {
          const sub = client!.newSubscription(
            sandboxConnectionChannel(userId, connection.connectionId),
          );
          subscriptions.push(sub);

          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error(
                `Centrifugo presence timeout for connection ${connection.connectionId}`,
              ),
            );
          }, 5000);

          const cleanup = () => {
            clearTimeout(timeout);
            sub.removeAllListeners();
          };

          sub.on("subscribed", async () => {
            try {
              const result = (await sub.presence()) as CentrifugoPresenceResult;
              const clients = result.clients ?? {};
              if (Object.keys(clients).length > 0) {
                onlineConnectionIds.add(connection.connectionId);
              }
              cleanup();
              resolve();
            } catch (e) {
              cleanup();
              reject(e);
            }
          });

          sub.on("error", (ctx) => {
            cleanup();
            reject(new Error(ctx.error?.message));
          });

          sub.subscribe();
        }),
    );

    client.connect();
    await Promise.all(probes);
    presenceReliable = true;
  } catch (err) {
    console.error("Centrifugo presence request failed:", err);
  } finally {
    for (const sub of subscriptions) {
      sub.removeAllListeners();
      sub.unsubscribe();
    }
    if (client) {
      client.disconnect();
    }
  }

  // Mark each connection with live presence status
  const enriched = connections.map((conn) => ({
    ...conn,
    online: onlineConnectionIds.has(conn.connectionId),
  }));

  // Disconnect stale connections in Convex (connected in DB but not in presence).
  // Skip rows whose lastSeen is within the grace window — covers the race where a
  // client has just inserted its row but hasn't finished subscribing to Centrifugo,
  // and brief WebSocket reconnects on healthy clients (last_heartbeat is bumped on
  // every successful Centrifugo token refresh).
  const PRESENCE_GRACE_MS = 30_000;
  if (presenceReliable) {
    const now = Date.now();
    const stale = connections.filter(
      (conn) =>
        !onlineConnectionIds.has(conn.connectionId) &&
        now - conn.lastSeen > PRESENCE_GRACE_MS,
    );
    if (stale.length > 0) {
      const results = await Promise.allSettled(
        stale.map((conn) =>
          convex.mutation(api.localSandbox.disconnectByBackend, {
            serviceKey,
            connectionId: conn.connectionId,
          }),
        ),
      );
      results.forEach((result, i) => {
        const conn = stale[i];
        if (result.status === "rejected") {
          phLogger.error("sandbox_presence_sweep_disconnect_failed", {
            userId,
            connectionId: conn.connectionId,
            isDesktop: conn.isDesktop,
            msSinceLastSeen: now - conn.lastSeen,
            error: result.reason,
          });
        } else {
          phLogger.warn("sandbox_presence_sweep_disconnect", {
            userId,
            connectionId: conn.connectionId,
            isDesktop: conn.isDesktop,
            msSinceLastSeen: now - conn.lastSeen,
          });
        }
      });
    }
  }

  return NextResponse.json({
    connections: enriched,
    onlineCount: onlineConnectionIds.size,
  });
}
