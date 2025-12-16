import { NextResponse } from "next/server";
import { workos } from "@/app/api/workos";

/**
 * Initiates the OAuth flow for desktop clients.
 *
 * The desktop app calls this endpoint with a state parameter, and we redirect
 * to WorkOS for authentication. After auth, WorkOS redirects to our callback
 * endpoint which then redirects to the hackerai:// deep link.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");

  if (!state || state.length < 32) {
    return NextResponse.json(
      { error: "Invalid or missing state parameter" },
      { status: 400 }
    );
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://hackerai.co";
  const redirectUri = `${baseUrl}/api/desktop-auth/callback`;

  try {
    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      provider: "authkit",
      clientId: process.env.WORKOS_CLIENT_ID!,
      redirectUri,
      state,
    });

    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    console.error("Failed to generate authorization URL:", error);
    return NextResponse.json(
      { error: "Failed to initiate authentication" },
      { status: 500 }
    );
  }
}
