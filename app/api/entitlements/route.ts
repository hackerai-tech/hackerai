import { NextRequest, NextResponse } from "next/server";
import { WorkOS } from "@workos-inc/node";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export async function GET(req: NextRequest) {
  console.log("🔍 [Entitlements API] Starting entitlements check");
  console.log(
    "🔍 [Entitlements API] Environment:",
    process.env.VERCEL_ENV || process.env.NODE_ENV,
  );

  try {
    // Get the session cookie
    const sessionCookie = req.cookies.get("wos-session")?.value;
    console.log(
      "🔍 [Entitlements API] Session cookie exists:",
      !!sessionCookie,
    );
    console.log(
      "🔍 [Entitlements API] Session cookie length:",
      sessionCookie?.length || 0,
    );

    if (!sessionCookie) {
      console.log("❌ [Entitlements API] No session cookie found");
      return NextResponse.json(
        { error: "No session cookie found" },
        { status: 401 },
      );
    }

    console.log(
      "🔍 [Entitlements API] Cookie password configured:",
      !!process.env.WORKOS_COOKIE_PASSWORD,
    );

    // Load the original session
    const session = workos.userManagement.loadSealedSession({
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
      sessionData: sessionCookie,
    });

    console.log("🔍 [Entitlements API] Session loaded successfully");

    // Get current organization ID from AuthKit session
    let organizationId: string | undefined;
    try {
      const { authkit } = await import("@workos-inc/authkit-nextjs");
      const { session: authkitSession } = await authkit(req);
      organizationId = authkitSession?.organizationId;
      console.log(
        "🔍 [Entitlements API] Current organization ID:",
        organizationId,
      );
    } catch (error) {
      console.log(
        "🔍 [Entitlements API] Failed to get organization ID from AuthKit:",
        error,
      );
    }

    console.log("🔍 [Entitlements API] Refreshing session...");

    // Refresh with organization ID to ensure we get entitlements for the correct org
    const refreshResult = organizationId
      ? await session.refresh({ organizationId })
      : await session.refresh();

    const { sealedSession, entitlements } = refreshResult as any;

    console.log(
      "🔍 [Entitlements API] Refresh called with org ID:",
      organizationId,
    );

    console.log("🔍 [Entitlements API] Refresh result:", {
      hasEntitlements: !!entitlements,
      entitlementsCount: entitlements?.length || 0,
      entitlementsList: entitlements || [],
      hasSealedSession: !!sealedSession,
      sealedSessionLength: sealedSession?.length || 0,
    });

    const hasProPlan = (entitlements || []).includes("pro-monthly-plan");
    console.log("🔍 [Entitlements API] Pro plan status:", hasProPlan);

    // Create response with entitlements
    const response = NextResponse.json({
      entitlements: entitlements || [],
      hasProPlan,
    });

    // Set the updated refresh session data in a cookie
    if (sealedSession) {
      console.log("🔍 [Entitlements API] Setting updated session cookie");
      response.cookies.set("wos-session", sealedSession, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      });
    } else {
      console.log("⚠️ [Entitlements API] No sealed session to set");
    }

    console.log(
      "✅ [Entitlements API] Successfully completed entitlements check",
    );
    return response;
  } catch (error) {
    console.error("💥 [Entitlements API] Error refreshing session:", error);
    console.error("💥 [Entitlements API] Error details:", {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { error: "Failed to refresh session" },
      { status: 500 },
    );
  }
}
