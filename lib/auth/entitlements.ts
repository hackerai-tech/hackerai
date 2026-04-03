import type { SubscriptionTier } from "@/types";

/** All known paid entitlement slugs, grouped by tier (highest first). */
const TIER_ENTITLEMENTS: ReadonlyArray<{
  tier: SubscriptionTier;
  slugs: readonly string[];
}> = [
  {
    tier: "ultra",
    slugs: ["ultra-plan", "ultra-monthly-plan", "ultra-yearly-plan"],
  },
  { tier: "team", slugs: ["team-plan"] },
  {
    tier: "pro-plus",
    slugs: ["pro-plus-plan", "pro-plus-monthly-plan", "pro-plus-yearly-plan"],
  },
  {
    tier: "pro",
    slugs: ["pro-plan", "pro-monthly-plan", "pro-yearly-plan"],
  },
];

/**
 * Safely coerce a raw entitlements value (from a JWT or session) into a
 * typed string array.
 */
export function parseEntitlements(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((e: unknown): e is string => typeof e === "string")
    : [];
}

/**
 * Resolve the highest subscription tier present in an entitlements list.
 * Returns `"free"` when no paid entitlement matches.
 */
export function resolveSubscriptionTier(
  entitlements: readonly string[],
): SubscriptionTier {
  for (const { tier, slugs } of TIER_ENTITLEMENTS) {
    if (slugs.some((s) => entitlements.includes(s))) {
      return tier;
    }
  }
  return "free";
}
