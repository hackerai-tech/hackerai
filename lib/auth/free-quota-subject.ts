import "server-only";

import { ChatSDKError } from "@/lib/errors";
import {
  createFreeQuotaSubjectWithSecret,
  createFreeUsageQuotaSubjectWithSecret,
  normalizeQuotaEmail,
} from "@/lib/auth/free-quota-subject-core";
export {
  normalizeQuotaEmail,
  redactFreeQuotaSubjectForLog,
} from "@/lib/auth/free-quota-subject-core";

function getAccountIdentityHmacSecret(): string | null {
  const secret = process.env.ACCOUNT_IDENTITY_HMAC_SECRET;
  if (typeof secret !== "string" || secret.length === 0) return null;
  return secret;
}

/** Set one future UTC cutoff before rollout to every web runtime; retain it
 * unchanged afterwards. Account creation comes from the verified AuthKit user,
 * never a request field. Existing account/referral/influencer identities use
 * createFreeQuotaSubject instead. No historical counters are read or rewritten. */
export function createFreeUsageQuotaSubject(
  email: unknown,
  createdAt: unknown,
): string | undefined {
  // Retain the production missing-secret check used by persisted identity.
  createFreeQuotaSubject(email);
  try {
    return createFreeUsageQuotaSubjectWithSecret(
      email,
      createdAt,
      process.env.FREE_QUOTA_GMAIL_NEW_USERS_FROM,
      getAccountIdentityHmacSecret(),
    );
  } catch {
    throw new ChatSDKError("forbidden:auth");
  }
}

export function createFreeQuotaSubject(email: unknown): string | undefined {
  const normalizedEmail = normalizeQuotaEmail(email);
  if (!normalizedEmail) return undefined;

  const secret = getAccountIdentityHmacSecret();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new ChatSDKError("forbidden:auth");
    }
    return undefined;
  }

  return createFreeQuotaSubjectWithSecret(normalizedEmail, secret);
}
