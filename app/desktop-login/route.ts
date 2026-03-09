import { NextResponse } from "next/server";
import { createOAuthState } from "@/lib/desktop-auth";
import { workos } from "@/app/api/workos";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const desktopCallbackUrl = `${url.origin}/api/auth/desktop-callback`;

  try {
    if (!process.env.WORKOS_CLIENT_ID) {
      console.error(
        "[Desktop Login] Missing WORKOS_CLIENT_ID environment variable",
      );
      return NextResponse.redirect(
        new URL("/login?error=config_error", url.origin),
      );
    }

    // Pass dev callback port through OAuth state for dev mode auth
    const devCallbackPort = url.searchParams.get("dev_callback_port");
    const portNum = devCallbackPort ? parseInt(devCallbackPort, 10) : NaN;
    const metadata =
      !isNaN(portNum) && portNum > 0 && portNum <= 65535
        ? { devCallbackPort: portNum }
        : undefined;

    const state = await createOAuthState(metadata);
    if (!state) {
      console.error("[Desktop Login] Failed to create OAuth state");
      return NextResponse.redirect(
        new URL("/login?error=state_error", url.origin),
      );
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
    return NextResponse.redirect(
      new URL("/login?error=auth_init_failed", url.origin),
    );
  }
}
