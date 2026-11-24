import { createHash } from "node:crypto";
import { z } from "zod";
import type { createRedisClient } from "@/lib/rate-limit/redis";

// A short account cooldown after the egress review cleared a burst as
// corroborated legitimate work on complete exact-run evidence. It only
// suppresses later routine bursts of the same account: new runs can still be
// abusive, so a burst at a materially higher volume is reviewed in full, and
// any missing, unreadable or invalid cooldown means a normal review.
//
// Only a `no_case` decision grants it. Manual cases, authorization requests,
// incomplete evidence and unverified attribution never do. Owner references
// are keyed per region, so the cooldown is keyed by the verified account and
// applies across regions; the key name is hashed and carries no identifier.

export const REVIEW_COOLDOWN_TTL_S = 24 * 60 * 60;
/** A burst at least this many times both the cleared peak and the threshold bypasses. */
export const COOLDOWN_BYPASS_FACTOR = 2;

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;

const cooldownSchema = z
  .object({
    v: z.literal(1),
    /** Connections of the cleared burst minute. */
    peak: z.number().int().positive(),
    /** Digest of the case window that granted it; a retry of it is not suppressed. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ReviewCooldown = z.infer<typeof cooldownSchema>;

export const reviewCooldownKey = (userId: string) =>
  `egress-review:v1:cooldown:${createHash("sha256")
    .update(`cooldown\n${userId}`)
    .digest("hex")
    .slice(0, 32)}`;

const parse = (value: unknown) => {
  const parsed = cooldownSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Throws when the store is unavailable; an invalid value reads as none. */
export async function readReviewCooldowns(
  redis: Redis,
  userIds: string[],
): Promise<(ReviewCooldown | null)[]> {
  if (!userIds.length) return [];
  const values = await redis.mget<unknown[]>(...userIds.map(reviewCooldownKey));
  if (values.length !== userIds.length)
    throw new Error("Incomplete cooldown lookup");
  return values.map(parse);
}

/**
 * Whether a burst of `connections` is a routine spike the cooldown covers.
 * It must be below twice the cleared peak or below twice the current
 * threshold; reaching both is a material escalation and is reviewed.
 */
export function cooldownSuppresses(
  cooldown: ReviewCooldown | null,
  connections: number,
  threshold: number,
) {
  if (!cooldown) return false;
  return !(
    connections >= COOLDOWN_BYPASS_FACTOR * cooldown.peak &&
    connections >= COOLDOWN_BYPASS_FACTOR * threshold
  );
}

/**
 * Records a clearance. A higher peak replaces the stored one with a fresh
 * 24-hour expiry; an equal or lower one leaves the stored cooldown and its
 * expiry unchanged, so a retry is idempotent and nothing extends a cooldown
 * without a new, higher cleared burst. Concurrent grants are last-writer-wins:
 * a race can only store the lower peak, which makes bypass easier.
 */
export async function grantReviewCooldown(
  redis: Redis,
  userId: string,
  clearance: { peak: number; digest: string },
): Promise<"granted" | "kept"> {
  const value = parse({ v: 1, ...clearance });
  if (!value) throw new Error("Invalid cooldown");
  const [existing] = await readReviewCooldowns(redis, [userId]);
  if (existing && existing.peak >= value.peak) return "kept";
  await redis.set(reviewCooldownKey(userId), JSON.stringify(value), {
    ex: REVIEW_COOLDOWN_TTL_S,
  });
  return "granted";
}
