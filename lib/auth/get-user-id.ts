import type { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
import type { SubscriptionTier } from "@/types";

/**
 * Get the current user ID from the authenticated session
 * Throws ChatSDKError if user is not authenticated
 *
 * @param req - NextRequest object (server-side only)
 * @returns Promise<string> - User ID
 * @throws ChatSDKError - When user is not authenticated
 */
export const getUserID = async (req: NextRequest): Promise<string> => {
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth");
    }

    return session.user.id;
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }

    console.error("Failed to get user session:", error);
    throw new ChatSDKError("unauthorized:auth");
  }
};

/**
 * Get the current user ID and pro status from the authenticated session
 * Throws ChatSDKError if user is not authenticated
 *
 * @param req - NextRequest object (server-side only)
 * @returns Promise<{ userId: string; isPro: boolean; subscription: SubscriptionTier }> - Object with userId, isPro, and subscription
 * @throws ChatSDKError - When user is not authenticated
 */
export const getUserIDAndPro = async (
  req: NextRequest,
): Promise<{
  userId: string;
  subscription: SubscriptionTier;
}> => {
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth");
    }

    // Check if user has paid entitlements (pro or ultra) and determine tier
    const entitlements: Array<string> = Array.isArray(session.entitlements)
      ? (session.entitlements.filter(
          (e: unknown): e is string => typeof e === "string",
        ) as Array<string>)
      : [];

    // Prefer normalized entitlements ("pro-plan", "ultra-plan", "team-plan"); also support legacy monthly/yearly keys
    const hasUltra =
      entitlements.includes("ultra-plan") ||
      entitlements.includes("ultra-monthly-plan") ||
      entitlements.includes("ultra-yearly-plan");
    const hasTeam = entitlements.includes("team-plan");
    const hasPro =
      entitlements.includes("pro-plan") ||
      entitlements.includes("pro-monthly-plan") ||
      entitlements.includes("pro-yearly-plan");

    let subscription: SubscriptionTier = "free";
    if (hasUltra) {
      subscription = "ultra";
    } else if (hasTeam) {
      subscription = "team";
    } else if (hasPro) {
      subscription = "pro";
    }

    return { userId: session.user.id, subscription };
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }

    console.error("Failed to get user session:", error);
    throw new ChatSDKError("unauthorized:auth");
  }
};

/**
 * Get the current user ID only if the user has signed in recently.
 * Enforces a freshness window (default 10 minutes) using session.user.lastSignInAt.
 * Throws ChatSDKError if unauthenticated or if the last sign-in is stale.
 *
 * @param req - NextRequest object (server-side only)
 * @param windowMs - Freshness window in milliseconds (default 10 minutes)
 * @returns Promise<string> - User ID
 * @throws ChatSDKError - When user is not authenticated or login is stale
 */
export const getUserIDWithFreshLogin = async (
  req: NextRequest,
  windowMs: number = 10 * 60 * 1000,
): Promise<string> => {
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth", "missing_session_user");
    }

    const lastSignInAt: unknown = (session as any)?.user?.lastSignInAt;
    const lastSignInMs =
      typeof lastSignInAt === "string" ? Date.parse(lastSignInAt) : NaN;

    if (!Number.isFinite(lastSignInMs)) {
      throw new ChatSDKError("unauthorized:auth", "missing_last_sign_in");
    }

    const now = Date.now();
    const isFresh = now - lastSignInMs <= windowMs;
    if (!isFresh) {
      throw new ChatSDKError("unauthorized:auth", "recent_login_required");
    }

    return session.user.id;
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }

    console.error("Failed to verify fresh login:", error);
    throw new ChatSDKError("unauthorized:auth", "recent_login_required");
  }
};
