import { PAUSE_OFFER_FLAG_KEY } from "@/lib/billing/retention-offers";
import {
  getPostHogFeatureFlagValueForUser,
  phLogger,
} from "@/lib/posthog/server";

export type PauseOfferFlagState = "enabled" | "disabled" | "unavailable";

/**
 * The pause offer is staged through the PostHog flag. The environment
 * override exists for local development and incident kill-switches; unset it
 * in production so PostHog stays the source of truth for the rollout.
 *
 * A flag lookup that times out or errors returns "unavailable". The offer
 * fails closed in that case, and the state is reported so a slow flag service
 * cannot silently hide the offer from every canceller.
 */
export async function getPauseOfferFlagState(
  userId: string,
): Promise<PauseOfferFlagState> {
  const override = process.env.PAUSE_OFFER_ENABLED?.trim().toLowerCase();
  if (override === "true") return "enabled";
  if (override === "false") return "disabled";

  let value = await getPostHogFeatureFlagValueForUser(
    PAUSE_OFFER_FLAG_KEY,
    userId,
  );
  if (value === null) {
    // One retry covers the common transient: a cold flag request that hits
    // the client's short timeout.
    value = await getPostHogFeatureFlagValueForUser(
      PAUSE_OFFER_FLAG_KEY,
      userId,
    );
  }
  if (value === null) {
    phLogger.warn("pause_offer_flag_unavailable", {
      userId,
      flag_key: PAUSE_OFFER_FLAG_KEY,
    });
    return "unavailable";
  }
  return value ? "enabled" : "disabled";
}

export async function isPauseOfferEnabledForUser(
  userId: string,
): Promise<boolean> {
  return (await getPauseOfferFlagState(userId)) === "enabled";
}
