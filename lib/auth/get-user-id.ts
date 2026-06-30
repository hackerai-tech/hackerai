import type { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
import type { SubscriptionTier } from "@/types";
import { createFreeQuotaSubject } from "@/lib/auth/free-quota-subject";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "@/lib/auth/entitlements";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";

const getSessionUserEmail = (session: unknown): string | undefined => {
  if (!session || typeof session !== "object") return undefined;
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") return undefined;
  const email = (user as { email?: unknown }).email;
  return typeof email === "string" ? email : undefined;
};

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
    if (isEndedSessionRefreshError(error)) {
      throw new ChatSDKError("unauthorized:auth");
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
  organizationId?: string;
  freeQuotaSubject?: string;
}> => {
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth");
    }

    const entitlements = parseEntitlements(session.entitlements);
    const subscription = resolveSubscriptionTier(entitlements);

    return {
      userId: session.user.id,
      subscription,
      organizationId: (session as any).organizationId as string | undefined,
      freeQuotaSubject: createFreeQuotaSubject(getSessionUserEmail(session)),
    };
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }
    if (isEndedSessionRefreshError(error)) {
      throw new ChatSDKError("unauthorized:auth");
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
  const { userId } = await getUserIDWithFreshLoginContext(req, windowMs);
  return userId;
};

export const getUserIDWithFreshLoginContext = async (
  req: NextRequest,
  windowMs: number = 10 * 60 * 1000,
): Promise<{ userId: string; freeQuotaSubject?: string }> => {
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

    return {
      userId: session.user.id,
      freeQuotaSubject: createFreeQuotaSubject(getSessionUserEmail(session)),
    };
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }
    if (isEndedSessionRefreshError(error)) {
      throw new ChatSDKError("unauthorized:auth", "recent_login_required");
    }

    console.error("Failed to verify fresh login:", error);
    throw new ChatSDKError("unauthorized:auth", "recent_login_required");
  }
};
