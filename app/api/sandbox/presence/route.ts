import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";

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
  const channel = `sandbox:${userId}`;

  const apiUrl = process.env.CENTRIFUGO_API_URL;
  const apiKey = process.env.CENTRIFUGO_API_KEY;

  if (!apiUrl || !apiKey) {
    return NextResponse.json(
      { error: "Centrifugo not configured" },
      { status: 500 },
    );
  }

  const response = await fetch(`${apiUrl}/api/presence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `apikey ${apiKey}`,
    },
    body: JSON.stringify({ channel }),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to query presence" },
      { status: 502 },
    );
  }

  const data: CentrifugoPresenceResponse = await response.json();

  const presence = data?.result?.presence ?? {};
  const connectedClients = Object.keys(presence);

  return NextResponse.json({
    channel,
    clients: connectedClients,
    count: connectedClients.length,
  });
}
