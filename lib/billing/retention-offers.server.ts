import {
  DEFAULT_DOWNGRADE_REASON_POLICY,
  DOWNGRADE_OFFER_FLAG_KEY,
  PAUSE_OFFER_FLAG_KEY,
  parseDowngradeReasonPolicy,
  type DowngradeReasonPolicy,
} from "@/lib/billing/retention-offers";
import {
  getPostHogFeatureFlagRawValueForUser,
  phLogger,
} from "@/lib/posthog/server";

export type RetentionOfferFlagState = "enabled" | "disabled" | "unavailable";
/** @deprecated Use RetentionOfferFlagState. */
export type PauseOfferFlagState = RetentionOfferFlagState;

export type DowngradeOfferFlag = {
  state: RetentionOfferFlagState;
  /** Which cancellation reasons see the offer; the flag variant when enabled. */
  reasonPolicy: DowngradeReasonPolicy;
};

/**
 * Retention offers are staged through PostHog flags. The environment
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

/**
 * The downgrade flag is multivariate: `price_reasons` (default mapping) or
 * `all_reasons` (the wider-audience test). A boolean `true` from an older flag
 * definition counts as the default policy. `DOWNGRADE_OFFER_ENABLED` accepts
 * `true`, `false`, or a policy name.
 */
export async function getDowngradeOfferFlag(
  userId: string,
): Promise<DowngradeOfferFlag> {
  const override = process.env.DOWNGRADE_OFFER_ENABLED?.trim().toLowerCase();
  const overridePolicy = parseDowngradeReasonPolicy(override);
  if (override === "true" || overridePolicy) {
    return {
      state: "enabled",
      reasonPolicy: overridePolicy ?? DEFAULT_DOWNGRADE_REASON_POLICY,
    };
  }
  if (override === "false") {
    return { state: "disabled", reasonPolicy: DEFAULT_DOWNGRADE_REASON_POLICY };
  }

  const value = await resolveRetentionOfferFlagValue({
    flagKey: DOWNGRADE_OFFER_FLAG_KEY,
    userId,
  });
  if (value === null) {
    return {
      state: "unavailable",
      reasonPolicy: DEFAULT_DOWNGRADE_REASON_POLICY,
    };
  }
  if (!value) {
    return { state: "disabled", reasonPolicy: DEFAULT_DOWNGRADE_REASON_POLICY };
  }
  const policy = parseDowngradeReasonPolicy(value);
  if (typeof value === "string" && !policy) {
    phLogger.warn("retention_offer_flag_unknown_variant", {
      userId,
      flag_key: DOWNGRADE_OFFER_FLAG_KEY,
      variant: value,
    });
  }
  return {
    state: "enabled",
    reasonPolicy: policy ?? DEFAULT_DOWNGRADE_REASON_POLICY,
  };
}

export async function isPauseOfferEnabledForUser(
  userId: string,
): Promise<boolean> {
  return (await getPauseOfferFlagState(userId)) === "enabled";
}
