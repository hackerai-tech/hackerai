import "server-only";

import { ChatSDKError } from "@/lib/errors";
import {
  createFreeQuotaSubjectWithSecret,
  createCanonicalFreeQuotaSubjectWithSecret,
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

/** Separate from persisted account/referral/influencer identity. Enable only
 * after the guarded Redis cutover has preserved historical quota counters. */
export function createFreeUsageQuotaSubject(
  email: unknown,
): string | undefined {
  if (process.env.FREE_QUOTA_GMAIL_CANONICALIZATION !== "true") {
    return createFreeQuotaSubject(email);
  }
  // Retain the existing production missing-secret check.
  const legacy = createFreeQuotaSubject(email);
  if (!legacy) return legacy;
  return createCanonicalFreeQuotaSubjectWithSecret(
    email,
    getAccountIdentityHmacSecret(),
  );
}
