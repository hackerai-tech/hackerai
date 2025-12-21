import { NextResponse } from "next/server";
import { workos } from "@/app/api/workos";

interface RefreshRequest {
  refresh_token: string;
}

/**
 * Refreshes the access token for desktop clients.
 *
 * The desktop app calls this endpoint when its access token is expired,
 * passing the refresh token to get a new access token.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as RefreshRequest;

    if (!body.refresh_token) {
      return NextResponse.json(
        { error: "Missing refresh_token" },
        { status: 400 }
      );
    }

    const result = await workos.userManagement.authenticateWithRefreshToken({
      clientId: process.env.WORKOS_CLIENT_ID!,
      refreshToken: body.refresh_token,
    });

    return NextResponse.json({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
    });
  } catch (error) {
    console.error("Token refresh error:", error);

    let message = "Token refresh failed";
    let status = 401;

    if (error instanceof Error) {
      if (error.message.includes("invalid_grant")) {
        message = "Invalid or expired refresh token";
      } else if (error.message.includes("network")) {
        message = "Network error";
        status = 503;
      }
    }

    return NextResponse.json({ error: message }, { status });
  }
}
