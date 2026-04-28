import { NextRequest, NextResponse } from "next/server";
import { Centrifuge } from "centrifuge";
import { getUserID } from "@/lib/auth/get-user-id";
import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

interface CentrifugoPresenceClient {
  client: string;
  user: string;
  connInfo: { connectionId?: string } | null;
}

interface CentrifugoPresenceResult {
  clients: Record<string, CentrifugoPresenceClient>;
}

export async function GET(request: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const channel = `sandbox:user#${userId}`;

  const wsUrl = process.env.CENTRIFUGO_WS_URL;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  if (!wsUrl) {
    return NextResponse.json(
      { error: "Centrifugo not configured" },
      { status: 500 },
    );
  }

  const onlineConnectionIds = new Set<string>();
  let presenceReliable = false;

  let client: Centrifuge | null = null;
  try {
    const token = await generateCentrifugoToken(userId, 30);
    client = new Centrifuge(wsUrl, { token });
    const sub = client.newSubscription(channel);

    const presenceData: CentrifugoPresenceResult = await new Promise(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Centrifugo presence timeout"));
        }, 5000);

        sub.on("subscribed", async () => {
          clearTimeout(timeout);
          try {
            const result = await sub.presence();
            resolve(result as CentrifugoPresenceResult);
          } catch (e) {
            reject(e);
          }
        });

        sub.on("error", (ctx) => {
          clearTimeout(timeout);
          reject(new Error(ctx.error?.message));
        });

        sub.subscribe();
        client!.connect();
      },
    );

    const clients = presenceData?.clients ?? {};
    for (const entry of Object.values(clients)) {
      if (entry.connInfo?.connectionId) {
        onlineConnectionIds.add(entry.connInfo.connectionId);
      }
    }
    presenceReliable = true;
  } catch (err) {
    console.error("Centrifugo presence request failed:", err);
  } finally {
    if (client) {
      client.disconnect();
    }
  }

  // Fetch connection metadata from Convex
  if (!convexUrl || !serviceKey) {
    return NextResponse.json({
      connections: [],
      onlineCount: onlineConnectionIds.size,
    });
  }

  const convex = new ConvexHttpClient(convexUrl);
  const connections = await convex.query(
    api.localSandbox.listConnectionsForBackend,
    { serviceKey, userId },
  );

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
        if (result.status === "rejected") {
          console.error(
            `Failed to disconnect stale connection ${stale[i].connectionId}:`,
            result.reason,
          );
        }
      });
    }
  }

  return NextResponse.json({
    connections: enriched,
    onlineCount: onlineConnectionIds.size,
  });
}
