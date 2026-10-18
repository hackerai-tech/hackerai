import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import PostHogClient from "@/app/posthog";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { GOAL_FLAG } from "./contracts";
import { resolveCurrentAgentEntitlementContext } from "@/lib/auth/agent-auto-review-entitlements";
import { getWorkOS } from "@/app/api/workos";
import { getStripe } from "@/app/api/stripe";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import type { Doc } from "@/convex/_generated/dataModel";
import type { SubscriptionTier } from "@/types";
import type { GoalJudgment } from "./contracts";
type GoalExecutionContext = {
  chatId: string;
  userId: string;
  subscription: SubscriptionTier;
  organizationId?: string;
  convexUrl?: string;
  goalGeneration?: number;
};
import { ChatSDKError } from "@/lib/errors";

export const goalServiceKey = () => {
  const value = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!value) throw new Error("Goal persistence unavailable");
  return value;
};
export async function getGoal(
  chatId: string,
  userId: string,
): Promise<Doc<"agent_goals"> | null> {
  return getConvexClient().query(api.agentGoals.getForBackend, {
    serviceKey: goalServiceKey(),
    chatId,
    userId,
  });
}
export async function goalEnabled(
  userId: string,
  subscription: string,
): Promise<boolean> {
  if (subscription === "free") return false;
  const posthog = PostHogClient();
  if (!posthog) return false;
  try {
    return (
      (await getPostHogFlagWithoutExposure(posthog, GOAL_FLAG, userId, {
        subscription,
      })) === true
    );
  } catch {
    return false;
  } finally {
    await posthog.shutdown().catch(() => undefined);
  }
}
export async function assertGoalExecutionAllowed(
  payload: GoalExecutionContext,
) {
  await assertUserCanMakeCostIncurringRequest(payload.userId);
  const fresh = await resolveCurrentAgentEntitlementContext(payload, {
    workos: getWorkOS(),
    stripe: getStripe(),
  });
  if (
    fresh.subscription !== payload.subscription ||
    fresh.organizationId !== payload.organizationId ||
    !(await goalEnabled(payload.userId, fresh.subscription))
  ) {
    throw new ChatSDKError(
      "forbidden:chat",
      "Goal access or subscription changed. Review saved progress and resume after refreshing your account.",
    );
  }
}
export async function finishGoalRun(
  payload: GoalExecutionContext,
  runId: string,
  outcome: {
    finishReason?: string;
    messageId?: string;
    canceled: boolean;
    failed: boolean;
    usageExhausted: boolean;
    judgment?: GoalJudgment;
  },
) {
  if (payload.goalGeneration === undefined) return null;
  if (payload.convexUrl) {
    const { setConvexUrl } = await import("@/lib/db/convex-client");
    setConvexUrl(payload.convexUrl);
  }
  const goal = await getConvexClient().mutation(api.agentGoals.finish, {
    serviceKey: goalServiceKey(),
    chatId: payload.chatId,
    userId: payload.userId,
    runId,
    ...outcome,
  });
  if (goal) {
    const posthog = PostHogClient();
    try {
      posthog?.capture({
        distinctId: payload.userId,
        event: "agent_goal_state_changed",
        properties: {
          goal_id: goal._id,
          chat_id: goal.chatId,
          run_id: runId,
          state: goal.state,
          runs_used: goal.runs,
          max_runs: goal.maxRuns,
          verified_criteria_count: goal.evidence.length,
          $geoip_disable: true,
          $process_person_profile: false,
        },
      });
    } finally {
      await posthog?.shutdown().catch(() => undefined);
    }
  }
  return goal;
}

/** Reconcile only a recorded, owned run. Unknown/provider failures never authorize a restart. */
export async function reconcileGoal(chatId: string, userId: string) {
  const goal = await getGoal(chatId, userId);
  if (!goal?.activeRunId) return goal;
  const { runs } = await import("@trigger.dev/sdk");
  const run = await runs.retrieve(goal.activeRunId);
  const metadata = run.metadata as Record<string, unknown> | undefined;
  if (metadata?.chatId !== chatId || metadata?.userId !== userId)
    throw new ChatSDKError(
      "forbidden:chat",
      "Goal run identity could not be verified.",
    );
  if (
    ![
      "COMPLETED",
      "FAILED",
      "CANCELED",
      "CRASHED",
      "SYSTEM_FAILURE",
      "EXPIRED",
      "TIMED_OUT",
    ].includes(run.status)
  )
    return goal;
  const settled = await getConvexClient().mutation(api.agentGoals.finish, {
    serviceKey: goalServiceKey(),
    chatId,
    userId,
    runId: goal.activeRunId,
    canceled: run.status === "CANCELED",
    failed: run.status !== "CANCELED",
    usageExhausted: false,
  });
  const { setActiveTriggerRun } = await import("@/lib/db/actions");
  await setActiveTriggerRun({
    chatId,
    triggerRunId: null,
    approvalSessionId: null,
    expectedRunId: goal.activeRunId,
    clearApprovalPending: true,
  });
  return settled ?? (await getGoal(chatId, userId));
}
