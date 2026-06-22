import { createHmac } from "crypto";

export const FREE_QUOTA_SUBJECT_VERSION = "v1";
export const FREE_QUOTA_SUBJECT_PREFIX = `free_quota:${FREE_QUOTA_SUBJECT_VERSION}:`;
const FREE_QUOTA_HMAC_CONTEXT = `email:${FREE_QUOTA_SUBJECT_VERSION}:`;

export function normalizeQuotaEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function createFreeQuotaSubjectWithSecret(
  email: unknown,
  secret: string | null | undefined,
): string | undefined {
  const normalizedEmail = normalizeQuotaEmail(email);
  if (!normalizedEmail || !secret) return undefined;

  const digest = createHmac("sha256", secret)
    .update(`${FREE_QUOTA_HMAC_CONTEXT}${normalizedEmail}`)
    .digest("hex");

  return `${FREE_QUOTA_SUBJECT_PREFIX}${digest}`;
}

export function redactFreeQuotaSubjectForLog(
  subject: string | null | undefined,
): string | undefined {
  if (!subject) return undefined;
  if (!subject.startsWith(FREE_QUOTA_SUBJECT_PREFIX)) return "legacy-user-id";
  return `${FREE_QUOTA_SUBJECT_PREFIX}${subject.slice(
    FREE_QUOTA_SUBJECT_PREFIX.length,
    FREE_QUOTA_SUBJECT_PREFIX.length + 12,
  )}`;
}
