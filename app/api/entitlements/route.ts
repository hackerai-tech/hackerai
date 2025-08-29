import { NextRequest, NextResponse } from "next/server";
import { WorkOS } from "@workos-inc/node";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export async function GET(req: NextRequest) {
  try {
    // Get the session cookie
    const sessionCookie = req.cookies.get("wos-session")?.value;

    if (!sessionCookie) {
      return NextResponse.json(
        { error: "No session cookie found" },
        { status: 401 },
      );
    }

    // Load the original session
    const session = workos.userManagement.loadSealedSession({
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
      sessionData: sessionCookie,
    });

    const refreshResult = await session.refresh();
    const { sealedSession, entitlements } = refreshResult as any;

    const hasProPlan = (entitlements || []).includes("pro-monthly-plan");

    // Create response with entitlements
    const response = NextResponse.json({
      entitlements: entitlements || [],
      hasProPlan,
    });

    // Set the updated refresh session data in a cookie
    if (sealedSession) {
      response.cookies.set("wos-session", sealedSession, {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      });
    }

    return response;
  } catch (error) {
    console.error("💥 [Entitlements API] Error refreshing session:", error);
    return NextResponse.json(
      { error: "Failed to refresh session" },
      { status: 500 },
    );
  }
}
