import { NextResponse } from "next/server";
import { createOAuthState } from "@/lib/desktop-auth";
import { workos } from "@/app/api/workos";
import { getAuthRedirectPath } from "@/lib/auth/auth-redirect-intents";

const DESKTOP_AUTH_STATE_REGEX = /^[a-f0-9]{64}$/;

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
    const desktopAuthState = url.searchParams.get("desktop_state");
    const screenHint =
      url.searchParams.get("screen_hint") === "sign-up" ? "sign-up" : "sign-in";
    const returnPath = getAuthRedirectPath(url) ?? undefined;
    const portNum = devCallbackPort ? parseInt(devCallbackPort, 10) : NaN;

    if (
      typeof desktopAuthState !== "string" ||
      !DESKTOP_AUTH_STATE_REGEX.test(desktopAuthState)
    ) {
      console.warn("[Desktop Login] Missing or invalid desktop auth state");
      return NextResponse.redirect(
        new URL("/login?error=state_error", url.origin),
      );
    }

    const metadata = {
      desktopAuthState,
      ...(!isNaN(portNum) && portNum > 0 && portNum <= 65535
        ? { devCallbackPort: portNum }
        : {}),
      ...(returnPath ? { returnPath } : {}),
    };

    const state = await createOAuthState(
      Object.keys(metadata).length > 0 ? metadata : undefined,
    );
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
      screenHint,
    });

    return NextResponse.redirect(authorizationUrl);
  } catch (err) {
    console.error("[Desktop Login] Failed to generate authorization URL:", err);
    return NextResponse.redirect(
      new URL("/login?error=auth_init_failed", url.origin),
    );
  }
}
