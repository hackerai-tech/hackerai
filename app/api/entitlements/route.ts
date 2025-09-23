import { NextRequest } from "next/server";
import { WorkOS } from "@workos-inc/node";
import { json, extractErrorMessage } from "@/lib/api/response";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export async function GET(req: NextRequest) {
  try {
    // Get the session cookie
    const sessionCookie = req.cookies.get("wos-session")?.value;

    if (!sessionCookie) {
      return json({ error: "No session cookie found" }, { status: 401 });
    }

    // Load the original session
    const session = workos.userManagement.loadSealedSession({
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
      sessionData: sessionCookie,
    });

    // First authenticate to get user and organization info
    const authResult = await session.authenticate();

    let organizationId: string | undefined;
    if (authResult.authenticated) {
      // Check if organizationId is already available in the session
      organizationId = (authResult as any).organizationId;

      // If organizationId is not in session, fetch it using userId
      if (!organizationId) {
        const userId = (authResult as any).user?.id;

        if (userId) {
          // Get organization membership for this user
          try {
            const memberships =
              await workos.userManagement.listOrganizationMemberships({
                userId: userId,
                statuses: ["active"],
              });

            // Use the first active membership's organization ID
            if (memberships.data && memberships.data.length > 0) {
              organizationId = memberships.data[0].organizationId;
            }
          } catch (membershipError) {
            console.error(
              "Failed to fetch organization memberships:",
              membershipError,
            );
          }
        }
      }
    }

    // Refresh with organization ID to ensure we get entitlements for the correct org
    const refreshResult = organizationId
      ? await session.refresh({ organizationId })
      : await session.refresh();

    const { sealedSession, entitlements } = refreshResult as any;

    const allEntitlements: string[] = Array.isArray(entitlements)
      ? entitlements
      : [];

    // Compute a single subscription tier
    // Prefer normalized entitlements (e.g. "ultra-plan", "pro-plan") if present,
    // but maintain backward compatibility by also checking monthly/yearly variants.
    const hasUltra =
      allEntitlements.includes("ultra-plan") ||
      allEntitlements.includes("ultra-monthly-plan") ||
      allEntitlements.includes("ultra-yearly-plan");
    const hasPro =
      allEntitlements.includes("pro-plan") ||
      allEntitlements.includes("pro-monthly-plan") ||
      allEntitlements.includes("pro-yearly-plan");

    const subscription: "free" | "pro" | "ultra" = hasUltra
      ? "ultra"
      : hasPro
        ? "pro"
        : "free";

    // Create response with entitlements and normalized subscription tier
    const response = json({
      entitlements: allEntitlements,
      subscription,
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
    console.error("Error refreshing session:", error);
    const normalized = extractErrorMessage(error).toLowerCase();
    const should401 =
      normalized.includes("invalid_grant") ||
      normalized.includes("session has already ended");

    return json(
      { error: should401 ? "Unauthorized" : "Failed to refresh session" },
      { status: should401 ? 401 : 500 },
    );
  }
}
