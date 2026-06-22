import "server-only";

import { ChatSDKError } from "@/lib/errors";
import {
  createFreeQuotaSubjectWithSecret,
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
      throw new ChatSDKError(
        "forbidden:auth",
        "account_identity_hmac_secret_missing",
      );
    }
    return undefined;
  }

  return createFreeQuotaSubjectWithSecret(normalizedEmail, secret);
}
