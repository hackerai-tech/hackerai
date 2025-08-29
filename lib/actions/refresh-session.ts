"use server";

import { refreshSession } from "@workos-inc/authkit-nextjs";

export async function refreshAuthkitSession() {
  console.log("🔍 [RefreshAuthkitSession] Starting session refresh");
  console.log(
    "🔍 [RefreshAuthkitSession] Environment:",
    process.env.VERCEL_ENV || process.env.NODE_ENV,
  );
  console.log(
    "🔍 [RefreshAuthkitSession] Cookie password configured:",
    !!process.env.WORKOS_COOKIE_PASSWORD,
  );

  try {
    console.log(
      "🔍 [RefreshAuthkitSession] Calling refreshSession with ensureSignedIn: true",
    );
    const session = await refreshSession({ ensureSignedIn: true });

    console.log("🔍 [RefreshAuthkitSession] Session refresh completed");
    console.log("🔍 [RefreshAuthkitSession] Session structure:", {
      hasSession: !!session,
      sessionKeys: session ? Object.keys(session) : [],
      hasUser: !!(session as any)?.user,
      userKeys: (session as any)?.user
        ? Object.keys((session as any).user)
        : [],
      hasEntitlements: !!(
        (session as any)?.entitlements || (session as any)?.user?.entitlements
      ),
      entitlements:
        (session as any)?.entitlements ||
        (session as any)?.user?.entitlements ||
        [],
      hasProPlan: (
        (session as any)?.entitlements ||
        (session as any)?.user?.entitlements ||
        []
      ).includes("pro-monthly-plan"),
    });

    const sessionString = JSON.stringify(session);
    console.log(
      "🔍 [RefreshAuthkitSession] Session JSON length:",
      sessionString.length,
    );
    console.log("✅ [RefreshAuthkitSession] Successfully refreshed session");

    return sessionString;
  } catch (error) {
    console.error(
      "💥 [RefreshAuthkitSession] Error refreshing session:",
      error,
    );
    console.error("💥 [RefreshAuthkitSession] Error details:", {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
