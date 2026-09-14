import { createHash } from "node:crypto";
import type { PostHog } from "posthog-node";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  FREE_QUOTA_MIGRATION_STATE,
  resolveMigratedFreeQuotaSubject,
} from "@/lib/rate-limit/free-quota-migration";
import {
  getFreeMonthlyCostLimitDollars,
  getFreeRequestLimit,
  type FreeLimitPolicy,
} from "@/lib/rate-limit/free-config";
import { isRegionalFreeCountry } from "./regional-free-limits";

export const FREE_MONTHLY_BUDGET_KEY = "free_monthly_budget_v1";
export const FREE_MONTHLY_BUDGET_EXPOSURE = "free_monthly_budget_exposed";
export type FreeMonthlyBudgetAssignment = FreeLimitPolicy & {
  monthlyBudgetExperiment: typeof FREE_MONTHLY_BUDGET_KEY;
  variant: "control" | "test";
};

export function isMonthlyBudgetCountry(country: unknown): country is string {
  return (
    typeof country === "string" &&
    /^[A-Z]{2}$/.test(country) &&
    country !== "XX" &&
    country !== "NG" &&
    !isRegionalFreeCountry(country)
  );
}

// The input is already a secret HMAC. Independent digest bytes select enrollment
// and arm, keeping aliases together without sending their identity to PostHog.
export function monthlyBudgetAllocation(subject: string) {
  const digest = createHash("sha256")
    .update(`${FREE_MONTHLY_BUDGET_KEY}:${subject}`)
    .digest();
  return {
    bucket: digest.readUInt32BE(0) % 10000,
    variant: digest[4] % 2 === 0 ? ("control" as const) : ("test" as const),
  };
}

export async function evaluateFreeMonthlyBudget({
  posthog,
  userId,
  subscription,
  emailVerified,
  country,
  freeQuotaSubject,
}: {
  posthog: Pick<PostHog, "getFeatureFlag"> | null;
  userId: string;
  subscription: string;
  emailVerified?: boolean;
  /** Present only after trusted ingress geography and consent checks. */
  country?: string;
  freeQuotaSubject?: string;
}): Promise<FreeMonthlyBudgetAssignment | undefined> {
  if (
    !posthog ||
    !userId ||
    subscription !== "free" ||
    emailVerified !== true ||
    !isMonthlyBudgetCountry(country) ||
    process.env.FREE_QUOTA_GMAIL_CANONICALIZATION !== "true" ||
    !freeQuotaSubject ||
    !/^free_quota:v1:[a-f0-9]{64}$/.test(freeQuotaSubject) ||
    getFreeMonthlyCostLimitDollars() !== 0.25
  )
    return;
  try {
    const redis = createRedisClient();
    if (!redis || (await redis.get(FREE_QUOTA_MIGRATION_STATE)) !== "complete")
      return;
    const subject = await resolveMigratedFreeQuotaSubject(
      redis,
      freeQuotaSubject,
    );
    const { bucket, variant } = monthlyBudgetAllocation(subject);
    const evaluated = await posthog.getFeatureFlag(
      FREE_MONTHLY_BUDGET_KEY,
      userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          free_monthly_budget_eligible: true,
          free_monthly_budget_bucket: bucket,
          free_monthly_budget_arm: variant,
        },
      },
    );
    // Require the configured override to agree with the identity's stable arm.
    if (evaluated !== variant) return;
    return {
      monthlyBudgetExperiment: FREE_MONTHLY_BUDGET_KEY,
      variant,
      dailyRequests: getFreeRequestLimit(),
      monthlyCostDollars: variant === "test" ? 0.5 : 0.25,
    };
  } catch {
    // Flag/Redis failures keep the normal allowance; admission enforces Redis.
    return;
  }
}

export function freeMonthlyBudgetProperties(
  assignment?: FreeMonthlyBudgetAssignment,
) {
  return assignment
    ? {
        [`$feature/${FREE_MONTHLY_BUDGET_KEY}`]: assignment.variant,
        free_monthly_budget_variant: assignment.variant,
        free_monthly_budget_dollars: assignment.monthlyCostDollars,
        free_monthly_budget_version: 1,
      }
    : {};
}

/** Includes rejected preflight so zero-usage participants remain measurable. */
export async function captureFreeMonthlyBudgetExposure(
  posthog: Pick<PostHog, "capture" | "flush"> | null,
  assignment: FreeMonthlyBudgetAssignment | undefined,
  userId: string,
  mode: string,
) {
  if (!posthog || !assignment) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    posthog.capture({
      distinctId: userId,
      event: FREE_MONTHLY_BUDGET_EXPOSURE,
      properties: {
        ...freeMonthlyBudgetProperties(assignment),
        mode,
        subscription_tier: "free",
        exposure_surface: "quota_enforcement",
        $geoip_disable: true,
        $process_person_profile: false,
      },
    });
    await Promise.race([
      posthog.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 750);
      }),
    ]);
  } catch {
    // Analytics must not block quota enforcement.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
