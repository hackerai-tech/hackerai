import type { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
import type { SubscriptionTier } from "@/types";
import {
  createFreeQuotaSubject,
  createFreeUsageQuotaSubject,
} from "@/lib/auth/free-quota-subject";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "@/lib/auth/entitlements";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";
import {
  analyticsAccountCohort,
  type AnalyticsAccountCohort,
} from "@/lib/analytics/account-cohort";

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

export type AuthSessionPhase = "load_sdk" | "session" | "entitlements";

/**
 * Get the current user ID and pro status from the authenticated session
 * Throws ChatSDKError if user is not authenticated
 *
 * @param req - NextRequest object (server-side only)
 * @param onPhase - Optional finite progress observer; receives no session data.
 * @returns Authenticated identity, subscription and quota metadata.
 * @throws ChatSDKError - When user is not authenticated
 */
export const getUserIDAndPro = async (
  req: NextRequest,
  onPhase?: (phase: AuthSessionPhase) => void,
): Promise<{
  userId: string;
  subscription: SubscriptionTier;
  emailVerified: boolean;
  analyticsAccountCohort?: AnalyticsAccountCohort;
  organizationId?: string;
  freeQuotaSubject?: string;
  freeUsageQuotaSubject?: string;
}> => {
  /** Observe progress without allowing diagnostics to alter authentication. */
  const reportPhase = (phase: AuthSessionPhase) => {
    try {
      onPhase?.(phase);
    } catch {
      // Optional timing context cannot change authentication or its errors.
    }
  };
  try {
    reportPhase("load_sdk");
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    reportPhase("session");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth");
    }

    reportPhase("entitlements");
    const entitlements = parseEntitlements(session.entitlements);
    const subscription = resolveSubscriptionTier(entitlements);

    return {
      userId: session.user.id,
      subscription,
      emailVerified: session.user.emailVerified === true,
      analyticsAccountCohort: analyticsAccountCohort(
        getSessionUserEmail(session),
      ),
      organizationId: (session as any).organizationId as string | undefined,
      freeQuotaSubject: createFreeQuotaSubject(getSessionUserEmail(session)),
      freeUsageQuotaSubject:
        subscription === "free"
          ? createFreeUsageQuotaSubject(
              getSessionUserEmail(session),
              session.user.createdAt,
            )
          : undefined,
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
