import { NextRequest } from "next/server";
import {
  json,
  extractErrorMessage,
  isRateLimitError,
} from "@/lib/api/response";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "@/lib/auth/entitlements";
import { workos } from "@/app/api/workos";

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

    const organizationId = authResult.authenticated
      ? ((authResult as any).organizationId as string | undefined)
      : undefined;

    // Only scope the refresh when the authenticated session already names an
    // active organization. Picking the first membership here can silently
    // switch multi-organization users to an unrelated organization.
    const refreshResult = organizationId
      ? await session.refresh({ organizationId })
      : await session.refresh();

    const { sealedSession, entitlements } = refreshResult as any;

    const allEntitlements = parseEntitlements(entitlements);
    const subscription = resolveSubscriptionTier(allEntitlements);

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
    // On WorkOS rate limits, return a 429 so the client knows to retry
    // rather than silently downgrading the user to free tier
    if (isRateLimitError(error)) {
      return json(
        { error: "Rate limited", entitlements: [], subscription: "free" },
        { status: 429 },
      );
    }

    const normalized = extractErrorMessage(error).toLowerCase();
    const should401 =
      normalized.includes("invalid_grant") ||
      normalized.includes("session has already ended");

    if (!should401) {
      // Keep auth errors quiet, log only unexpected cases
      console.error("Error refreshing session:", error);
    }

    return json(
      { error: should401 ? "Unauthorized" : "Failed to refresh session" },
      { status: should401 ? 401 : 500 },
    );
  }
}
