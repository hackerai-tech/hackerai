import { createHash } from "node:crypto";
import type { PostHog } from "posthog-node";
import type { FreeLimitPolicy } from "@/lib/rate-limit/free-config";
import { isRegionalFreeCountry } from "@/lib/rate-limit/regional-free-limits";

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

// Reserved allocation helper for a future approved pilot. Enrollment is disabled.
export function monthlyBudgetAllocation(subject: string) {
  const digest = createHash("sha256")
    .update(`${FREE_MONTHLY_BUDGET_KEY}:${subject}`)
    .digest();
  return {
    bucket: digest.readUInt32BE(0) % 10000,
    variant: digest[4] % 2 === 0 ? ("control" as const) : ("test" as const),
  };
}

/** Enrollment stays off until a migration-independent pilot is approved. */
export async function evaluateFreeMonthlyBudget(_input: {
  posthog: Pick<PostHog, "getFeatureFlag"> | null;
  userId: string;
  subscription: string;
  emailVerified?: boolean;
  country?: string;
  freeQuotaSubject?: string;
}): Promise<FreeMonthlyBudgetAssignment | undefined> {
  return undefined;
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
