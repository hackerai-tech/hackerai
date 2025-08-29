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

    // First authenticate to get user ID
    console.log("🔍 [Entitlements API] Authenticating to get user ID...");
    const authResult = await session.authenticate();
    
    let organizationId: string | undefined;
    if (authResult.authenticated) {
      const userId = (authResult as any).user?.id;
      console.log("🔍 [Entitlements API] User ID from session:", userId);
      
      if (userId) {
        // Get organization membership for this user
        console.log("🔍 [Entitlements API] Fetching organization memberships...");
        try {
          const memberships = await workos.userManagement.listOrganizationMemberships({
            userId: userId,
            statuses: ['active']
          });
          
          console.log("🔍 [Entitlements API] Found memberships:", {
            count: memberships.data?.length || 0,
            memberships: memberships.data?.map(m => ({ id: m.id, orgId: m.organizationId, status: m.status })) || []
          });
          
          // Use the first active membership's organization ID
          if (memberships.data && memberships.data.length > 0) {
            organizationId = memberships.data[0].organizationId;
            console.log("🔍 [Entitlements API] Using organization ID from membership:", organizationId);
          } else {
            console.log("🔍 [Entitlements API] No active organization memberships found");
          }
        } catch (membershipError) {
          console.error("🔍 [Entitlements API] Failed to fetch organization memberships:", membershipError);
        }
      } else {
        console.log("🔍 [Entitlements API] No user ID found in session");
      }
    } else {
      console.log("🔍 [Entitlements API] Session not authenticated:", (authResult as any).reason);
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
