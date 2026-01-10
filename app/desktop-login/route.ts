import { NextResponse } from "next/server";
import { WorkOS } from "@workos-inc/node";
import { createOAuthState } from "@/lib/desktop-auth";

const workos = new WorkOS(process.env.WORKOS_API_KEY);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const desktopCallbackUrl = `${url.origin}/api/auth/desktop-callback`;

  try {
    if (!process.env.WORKOS_CLIENT_ID) {
      console.error("[Desktop Login] Missing WORKOS_CLIENT_ID environment variable");
      return NextResponse.redirect(new URL("/login?error=config_error", url.origin));
    }

    const state = await createOAuthState();
    if (!state) {
      console.error("[Desktop Login] Failed to create OAuth state");
      return NextResponse.redirect(new URL("/login?error=state_error", url.origin));
    }

    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      provider: "authkit",
      clientId: process.env.WORKOS_CLIENT_ID,
      redirectUri: desktopCallbackUrl,
      state,
    });

    return NextResponse.redirect(authorizationUrl);
  } catch (err) {
    console.error("[Desktop Login] Failed to generate authorization URL:", err);
    return NextResponse.redirect(new URL("/login?error=auth_init_failed", url.origin));
  }
}
