import type { PostHog } from "posthog-node";
import {
  getFreeMonthlyCostLimitDollars,
  getFreeRequestLimit,
  type FreeLimitPolicy,
} from "@/lib/rate-limit/free-config";

export const REGIONAL_FREE_LIMITS_KEY = "regional_free_limits_v1";
export const REGIONAL_FREE_LIMITS_EXPOSURE = "regional_free_limits_exposed";
export const REGIONAL_FREE_COUNTRIES = ["IN", "PK", "BD"] as const;
export type RegionalFreeCountry = (typeof REGIONAL_FREE_COUNTRIES)[number];
export type RegionalFreeLimitsAssignment = FreeLimitPolicy & {
  key: typeof REGIONAL_FREE_LIMITS_KEY;
  variant: "control" | "test";
  country: RegionalFreeCountry;
};

export function isRegionalFreeCountry(
  value: unknown,
): value is RegionalFreeCountry {
  return REGIONAL_FREE_COUNTRIES.some((country) => country === value);
}

/** Only server-derived country and consent may reach this evaluator. */
export async function evaluateRegionalFreeLimits({
  posthog,
  userId,
  subscription,
  country,
}: {
  posthog: Pick<PostHog, "getFeatureFlag"> | null;
  userId: string;
  subscription: string;
  country?: string;
}): Promise<RegionalFreeLimitsAssignment | undefined> {
  if (
    !posthog ||
    !userId ||
    subscription !== "free" ||
    !isRegionalFreeCountry(country)
  )
    return;
  try {
    const variant = await posthog.getFeatureFlag(
      REGIONAL_FREE_LIMITS_KEY,
      userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          regional_free_country: country,
          subscription: "free",
        },
      },
    );
    // Disabled, missing and failed evaluations preserve the established allowance
    // and are not mislabeled as experiment controls.
    if (variant !== "control" && variant !== "test") return;
    return {
      key: REGIONAL_FREE_LIMITS_KEY,
      variant,
      country,
      dailyRequests:
        variant === "test"
          ? Math.min(3, getFreeRequestLimit())
          : getFreeRequestLimit(),
      monthlyCostDollars:
        variant === "test"
          ? Math.min(0.1, getFreeMonthlyCostLimitDollars())
          : getFreeMonthlyCostLimitDollars(),
    };
  } catch {
    return;
  }
}

export function regionalFreeLimitsProperties(
  assignment?: RegionalFreeLimitsAssignment,
) {
  return assignment
    ? {
        [`$feature/${REGIONAL_FREE_LIMITS_KEY}`]: assignment.variant,
        regional_free_variant: assignment.variant,
        regional_free_country: assignment.country,
        regional_free_daily_requests: assignment.dailyRequests,
        regional_free_monthly_cost_dollars: assignment.monthlyCostDollars,
      }
    : {};
}

/** Called at quota enforcement, including requests rejected by the quota. */
export async function captureRegionalFreeLimitsExposure(
  posthog: Pick<PostHog, "capture" | "flush"> | null,
  assignment: RegionalFreeLimitsAssignment | undefined,
  userId: string,
  mode: string,
) {
  if (!posthog || !assignment) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    posthog.capture({
      distinctId: userId,
      event: REGIONAL_FREE_LIMITS_EXPOSURE,
      properties: {
        ...regionalFreeLimitsProperties(assignment),
        subscription_tier: "free",
        mode,
        exposure_surface: "quota_enforcement",
        $geoip_disable: true,
        $process_person_profile: false,
      },
    });
    // Rejected preflight never reaches normal completion telemetry. Flush before
    // returning so zero-usage exposed accounts remain in the denominator. Bound
    // the wait so analytics outages cannot hold up quota enforcement. The race
    // also handles a flush rejection after the timeout has already won.
    await Promise.race([
      posthog.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 750);
      }),
    ]);
  } catch {
    /* Analytics must not prevent quota enforcement. */
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
