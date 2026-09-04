import { RETENTION_OFFERS_FLAG_KEY } from "@/lib/billing/retention-offers";
import { getPostHogFeatureFlagValueForUser } from "@/lib/posthog/server";

/**
 * Retention offers are staged through the PostHog flag. The environment
 * override exists for local development and incident kill-switches; unset it
 * in production so PostHog stays the source of truth for the rollout.
 */
export async function isRetentionOffersEnabledForUser(
  userId: string,
): Promise<boolean> {
  const override = process.env.RETENTION_OFFERS_ENABLED?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  const value = await getPostHogFeatureFlagValueForUser(
    RETENTION_OFFERS_FLAG_KEY,
    userId,
  );
  // Fail closed: a missing flag or PostHog outage shows the plain cancel flow.
  return value === true;
}
