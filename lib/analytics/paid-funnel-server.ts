import "server-only";

import { createRedisClient } from "@/lib/rate-limit/redis";
import { createHash } from "node:crypto";

const CHECKOUT_STARTED_CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;

function stableDigest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function stableEventUuid(parts: string[]): string {
  const hex = stableDigest(parts).slice(0, 32).split("");
  // UUIDv8 is reserved for application-defined deterministic identifiers.
  hex[12] = "8";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function paidFunnelEventUuid({
  event,
  userId,
  checkoutAttemptId,
}: {
  event: string;
  userId: string;
  checkoutAttemptId: string;
}): string {
  return stableEventUuid([event, userId, checkoutAttemptId]);
}

export function paidFunnelIdempotencyKey({
  operation,
  scopeId,
  checkoutAttemptId,
}: {
  operation: string;
  scopeId: string;
  checkoutAttemptId: string;
}): string {
  const key = stableDigest([operation, scopeId, checkoutAttemptId]).slice(
    0,
    32,
  );
  return `${operation}:${key}`;
}

export async function claimCheckoutStarted({
  userId,
  checkoutAttemptId,
}: {
  userId: string;
  checkoutAttemptId: string;
}): Promise<boolean> {
  try {
    const redis = createRedisClient();
    if (!redis) return true;
    const claimId = stableDigest([
      "checkout_started",
      userId,
      checkoutAttemptId,
    ]).slice(0, 32);
    const claimed = await redis.set(
      `paid_funnel:checkout_started:${claimId}`,
      1,
      {
        nx: true,
        ex: CHECKOUT_STARTED_CLAIM_TTL_SECONDS,
      },
    );
    return claimed === "OK";
  } catch {
    // Analytics must never block checkout; deterministic PostHog identity remains
    // a secondary deduplication path when the Redis claim is unavailable.
    return true;
  }
}
