import { PAUSE_OFFER_FLAG_KEY } from "@/lib/billing/retention-offers";
import { getPostHogFeatureFlagValueForUser } from "@/lib/posthog/server";

/**
 * The pause offer is staged through the PostHog flag. The environment
 * override exists for local development and incident kill-switches; unset it
 * in production so PostHog stays the source of truth for the rollout.
 */
export async function isPauseOfferEnabledForUser(
  userId: string,
): Promise<boolean> {
  const override = process.env.PAUSE_OFFER_ENABLED?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  const value = await getPostHogFeatureFlagValueForUser(
    PAUSE_OFFER_FLAG_KEY,
    userId,
  );
  // Fail closed: a missing flag or PostHog outage shows the plain cancel flow.
  return value === true;
}
