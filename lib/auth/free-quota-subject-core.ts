import { createHmac } from "crypto";

export const FREE_QUOTA_SUBJECT_VERSION = "v1";
export const FREE_QUOTA_SUBJECT_PREFIX = `free_quota:${FREE_QUOTA_SUBJECT_VERSION}:`;
const FREE_QUOTA_HMAC_CONTEXT = `email:${FREE_QUOTA_SUBJECT_VERSION}:`;

export function normalizeQuotaEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** Consumer Gmail only: custom Google Workspace domains can distinguish dots. */
export function canonicalizeConsumerGmail(email: unknown): string | null {
  const normalized = normalizeQuotaEmail(email);
  if (!normalized) return null;
  const match =
    /^([a-z0-9.]+)(?:\+[^@\s]*)?@(gmail\.com|googlemail\.com)$/.exec(
      normalized,
    );
  if (!match) return normalized;
  const local = match[1].replaceAll(".", "");
  return local ? `${local}@gmail.com` : normalized;
}

/** A separate namespace keeps every pre-rollout quota record unchanged. */
export function createNewGmailUsageSubjectWithSecret(
  email: unknown,
  secret: string | null | undefined,
): string | undefined {
  const canonical = canonicalizeConsumerGmail(email);
  if (!canonical || !secret) return undefined;
  const digest = createHmac("sha256", secret)
    .update(`email:v2:${canonical}`)
    .digest("hex");
  return `free_quota:v2:${digest}`;
}

/** Pure selection shared by authenticated requests and local QA reset tooling. */
export function createFreeUsageQuotaSubjectWithSecret(
  email: unknown,
  createdAt: unknown,
  cutoff: string | undefined,
  secret: string | null | undefined,
): string | undefined {
  const legacy = createFreeQuotaSubjectWithSecret(email, secret);
  const normalized = normalizeQuotaEmail(email);
  if (!cutoff || !normalized || !/@(?:gmail|googlemail)\.com$/.test(normalized))
    return legacy;
  const cutoffMs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(cutoff)
    ? Date.parse(cutoff)
    : NaN;
  const createdMs = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (
    !Number.isFinite(cutoffMs) ||
    new Date(cutoffMs).toISOString() !== cutoff ||
    !Number.isFinite(createdMs)
  ) {
    throw new Error(
      "Invalid Gmail quota enrollment configuration or account metadata",
    );
  }
  return createdMs < cutoffMs
    ? legacy
    : createNewGmailUsageSubjectWithSecret(normalized, secret);
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
  const match = /^(free_quota:v[12]:)([a-f0-9]{64})$/.exec(subject);
  return match ? `${match[1]}${match[2].slice(0, 12)}` : "legacy-user-id";
}
