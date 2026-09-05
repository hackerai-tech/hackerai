import {
  DOWNGRADE_OFFER_FLAG_KEY,
  PAUSE_OFFER_FLAG_KEY,
} from "@/lib/billing/retention-offers";
import {
  getPostHogFeatureFlagValueForUser,
  phLogger,
} from "@/lib/posthog/server";

export type RetentionOfferFlagState = "enabled" | "disabled" | "unavailable";
/** @deprecated Use RetentionOfferFlagState. */
export type PauseOfferFlagState = RetentionOfferFlagState;

/**
 * Retention offers are staged through PostHog flags. The environment
 * overrides exist for local development and incident kill-switches; leave
 * them unset in production so PostHog stays the source of truth.
 *
 * A flag lookup that times out or errors returns "unavailable". The offer
 * fails closed in that case, and the state is reported so a slow flag service
 * cannot silently hide the offer from every canceller.
 */
export async function getRetentionOfferFlagState(args: {
  flagKey: string;
  envOverride: string | undefined;
  userId: string;
}): Promise<RetentionOfferFlagState> {
  const override = args.envOverride?.trim().toLowerCase();
  if (override === "true") return "enabled";
  if (override === "false") return "disabled";

  let value = await getPostHogFeatureFlagValueForUser(
    args.flagKey,
    args.userId,
  );
  if (value === null) {
    // One retry covers the common transient: a cold flag request that hits
    // the client's short timeout.
    value = await getPostHogFeatureFlagValueForUser(args.flagKey, args.userId);
  }
  if (value === null) {
    phLogger.warn("retention_offer_flag_unavailable", {
      userId: args.userId,
      flag_key: args.flagKey,
    });
    return "unavailable";
  }
  return value ? "enabled" : "disabled";
}

export async function getPauseOfferFlagState(
  userId: string,
): Promise<RetentionOfferFlagState> {
  return getRetentionOfferFlagState({
    flagKey: PAUSE_OFFER_FLAG_KEY,
    envOverride: process.env.PAUSE_OFFER_ENABLED,
    userId,
  });
}

export async function getDowngradeOfferFlagState(
  userId: string,
): Promise<RetentionOfferFlagState> {
  return getRetentionOfferFlagState({
    flagKey: DOWNGRADE_OFFER_FLAG_KEY,
    envOverride: process.env.DOWNGRADE_OFFER_ENABLED,
    userId,
  });
}

export async function isPauseOfferEnabledForUser(
  userId: string,
): Promise<boolean> {
  return (await getPauseOfferFlagState(userId)) === "enabled";
}
