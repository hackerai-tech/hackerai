import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import type { PostHog } from "posthog-node";
import type { ChatMode, SubscriptionTier } from "@/types";
import {
  getFreeMonthlyCostLimitDollars,
  getFreeRequestLimit,
  type FreeLimitPolicy,
} from "@/lib/rate-limit/free-config";

export const FREE_AGENT_DAILY_COST_KEY = "free_agent_daily_cost_v1";
export const FREE_AGENT_BUDGET_EXPOSURE_EVENT =
  "free_agent_budget_experiment_exposed";
export const FREE_AGENT_DAILY_COST_DOLLARS = 0.1;
export type FreeAgentBudgetAssignment = { variant: "control" | "test" };

export function freeAgentBudgetProperties(
  assignment?: FreeAgentBudgetAssignment,
) {
  return assignment
    ? {
        free_agent_budget_experiment_key: FREE_AGENT_DAILY_COST_KEY,
        free_agent_budget_experiment_variant: assignment.variant,
        [`$feature/${FREE_AGENT_DAILY_COST_KEY}`]: assignment.variant,
      }
    : {};
}

/** Exposure is the quota decision, including denied attempts, not model startup. */
export async function evaluateFreeAgentBudget({
  posthog,
  userId,
  mode,
  subscription,
  requestId,
}: {
  posthog: Pick<PostHog, "getFeatureFlagResult" | "capture"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  requestId: string;
}): Promise<FreeAgentBudgetAssignment | undefined> {
  if (!posthog || !userId || mode !== "agent" || subscription !== "free")
    return;
  let assignment: FreeAgentBudgetAssignment;
  try {
    const variant = await getPostHogFlagWithoutExposure(
      posthog,
      FREE_AGENT_DAILY_COST_KEY,
      userId,
    );
    if (variant !== "control" && variant !== "test") return;
    assignment = { variant };
  } catch {
    // Preserve baseline gates when flag evaluation is unavailable.
    return;
  }
  try {
    posthog.capture({
      distinctId: userId,
      event: FREE_AGENT_BUDGET_EXPOSURE_EVENT,
      properties: {
        ...freeAgentBudgetProperties(assignment),
        experiment_key: FREE_AGENT_DAILY_COST_KEY,
        experiment_variant: assignment.variant,
        request_id: requestId,
        mode,
        subscription_tier: subscription,
        exposure_surface: "agent_quota_check",
        $process_person_profile: false,
      },
    });
  } catch {
    // Capture availability must not change assignment or billing behavior.
  }
  return assignment;
}

export function freeAgentBudgetPolicy(
  assignment: FreeAgentBudgetAssignment | undefined,
  regional?: FreeLimitPolicy,
  now = new Date(),
): FreeLimitPolicy | undefined {
  if (assignment?.variant !== "test") return regional;
  return {
    dailyRequests: getFreeRequestLimit(regional),
    monthlyCostDollars: getFreeMonthlyCostLimitDollars(regional),
    agentDailyBudget: {
      bucket: now.toISOString().slice(0, 10),
      resetTimestamp: Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
      ),
    },
  };
}
