import { NextResponse } from "next/server";
import { workos } from "@/app/api/workos";

/**
 * Handles the OAuth callback for desktop clients.
 *
 * After WorkOS authentication, this endpoint exchanges the authorization code
 * for tokens and redirects to the hackerai:// deep link with the tokens.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Handle OAuth errors
  if (error) {
    console.error("OAuth error:", error, errorDescription);
    const params = new URLSearchParams({
      reason: error,
      description: errorDescription || "",
    });
    return NextResponse.redirect(`hackerai://auth/error?${params.toString()}`);
  }

  if (!code) {
    return NextResponse.redirect("hackerai://auth/error?reason=missing_code");
  }

  if (!state) {
    return NextResponse.redirect("hackerai://auth/error?reason=missing_state");
  }

  try {
    const authResult = await workos.userManagement.authenticateWithCode({
      clientId: process.env.WORKOS_CLIENT_ID!,
      code,
    });

    // Build deep link with tokens
    const params = new URLSearchParams({
      access_token: authResult.accessToken,
      refresh_token: authResult.refreshToken,
      state,
    });

    return NextResponse.redirect(
      `hackerai://auth/callback?${params.toString()}`
    );
  } catch (error) {
    console.error("Desktop auth callback error:", error);

    let reason = "auth_failed";
    if (error instanceof Error) {
      if (error.message.includes("invalid_grant")) {
        reason = "invalid_grant";
      } else if (error.message.includes("expired")) {
        reason = "code_expired";
      }
    }

    return NextResponse.redirect(`hackerai://auth/error?reason=${reason}`);
  }
}
