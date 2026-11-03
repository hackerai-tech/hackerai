import {
  PAUSE_OFFER_FLAG_KEY,
  type DowngradeReasonPolicy,
} from "@/lib/billing/retention-offers";
import {
  getPostHogFeatureFlagRawValueForUser,
  phLogger,
} from "@/lib/posthog/server";

export type RetentionOfferFlagState = "enabled" | "disabled" | "unavailable";
/** @deprecated Use RetentionOfferFlagState. */
export type PauseOfferFlagState = RetentionOfferFlagState;

export type DowngradeOfferPolicy = {
  state: RetentionOfferFlagState;
  /** Stable policy label retained in analytics after the rollout ends. */
  reasonPolicy: DowngradeReasonPolicy;
};

/**
 * The pause offer is staged through a PostHog flag. The environment
 * overrides exist for local development and incident kill-switches; leave
 * them unset in production so PostHog stays the source of truth.
 *
 * A flag lookup that times out or errors returns "unavailable". The offer
 * fails closed in that case, and the state is reported so a slow flag service
 * cannot silently hide the offer from every canceller.
 */
async function resolveRetentionOfferFlagValue(args: {
  flagKey: string;
  userId: string;
}): Promise<boolean | string | null> {
  let value = await getPostHogFeatureFlagRawValueForUser(
    args.flagKey,
    args.userId,
  );
  if (value === null) {
    // One retry covers the common transient: a cold flag request that hits
    // the client's short timeout.
    value = await getPostHogFeatureFlagRawValueForUser(
      args.flagKey,
      args.userId,
    );
  }
  if (value === null) {
    phLogger.warn("retention_offer_flag_unavailable", {
      userId: args.userId,
      flag_key: args.flagKey,
    });
  }
  return value;
}

export async function getRetentionOfferFlagState(args: {
  flagKey: string;
  envOverride: string | undefined;
  userId: string;
}): Promise<RetentionOfferFlagState> {
  const override = args.envOverride?.trim().toLowerCase();
  if (override === "true") return "enabled";
  if (override === "false") return "disabled";

  const value = await resolveRetentionOfferFlagValue(args);
  if (value === null) return "unavailable";
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

/** Standard offer policy; preserve explicit environment restrictions. */
export function getDowngradeOfferPolicy(): DowngradeOfferPolicy {
  const override = process.env.DOWNGRADE_OFFER_ENABLED?.trim().toLowerCase();
  return {
    state: override === "false" ? "disabled" : "enabled",
    reasonPolicy:
      override === "price_reasons" ? "price_reasons" : "all_reasons",
  };
}

export async function isPauseOfferEnabledForUser(
  userId: string,
): Promise<boolean> {
  return (await getPauseOfferFlagState(userId)) === "enabled";
}
