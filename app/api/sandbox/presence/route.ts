import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

interface CentrifugoPresenceClient {
  client: string;
  user: string;
  conn_info: Record<string, unknown>;
}

interface CentrifugoPresenceResponse {
  result: {
    presence: Record<string, CentrifugoPresenceClient>;
  };
}

export async function GET(request: NextRequest) {
  const userId = await getUserID(request);
  const channel = `sandbox:user#${userId}`;

  const apiUrl = process.env.CENTRIFUGO_API_URL;
  const apiKey = process.env.CENTRIFUGO_API_KEY;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  if (!apiUrl || !apiKey) {
    return NextResponse.json(
      { error: "Centrifugo not configured" },
      { status: 500 },
    );
  }

  // Fetch Centrifugo presence (who's actually online)
  const presenceResponse = await fetch(`${apiUrl}/api/presence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `apikey ${apiKey}`,
    },
    body: JSON.stringify({ channel }),
  });

  const onlineUserIds = new Set<string>();
  let presenceReliable = false;
  if (presenceResponse.ok) {
    const data: CentrifugoPresenceResponse = await presenceResponse.json();
    const presence = data?.result?.presence ?? {};
    for (const client of Object.values(presence)) {
      onlineUserIds.add(client.user);
    }
    presenceReliable = true;
  } else {
    console.error(
      `Centrifugo presence API failed: ${presenceResponse.status} ${presenceResponse.statusText}`,
    );
  }

  // Fetch connection metadata from Convex
  if (!convexUrl || !serviceKey) {
    return NextResponse.json({
      connections: [],
      onlineCount: onlineUserIds.size,
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
    online: onlineUserIds.has(userId),
  }));

  // Disconnect stale connections in Convex (connected in DB but not in presence)
  if (
    presenceReliable &&
    !onlineUserIds.has(userId) &&
    connections.length > 0
  ) {
    for (const conn of connections) {
      convex
        .mutation(api.localSandbox.disconnectByBackend, {
          serviceKey,
          connectionId: conn.connectionId,
        })
        .catch((err: unknown) => {
          console.error(
            `Failed to disconnect stale connection ${conn.connectionId}:`,
            err,
          );
        });
    }
  }

  return NextResponse.json({
    connections: enriched,
    onlineCount: onlineUserIds.size,
  });
}
