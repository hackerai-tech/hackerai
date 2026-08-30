import type { PostHog } from "posthog-node";
import type { AgentAutoContinueStopSource } from "@/lib/chat/stop-conditions";
import type { UsageRefundOutcome } from "@/lib/rate-limit/refund";
import type { SubscriptionTier } from "@/types";

export const AGENT_AUTO_CONTINUE_USAGE_PROTECTION_FLAG =
  "agent_auto_continue_usage_protection_v1";
export const AGENT_AUTO_CONTINUE_RECOVERY_FINISHED_EVENT =
  "agent_auto_continue_recovery_finished";

export type AgentAutoContinueUsageProtectionAssignment = "control" | "test";

export const isAgentAutoContinueUsageProtectionEligible = ({
  subscription,
  isAutomaticContinuation,
}: {
  subscription: SubscriptionTier;
  isAutomaticContinuation: boolean;
}): boolean => subscription !== "free" && isAutomaticContinuation;

export const resolveAgentAutoContinueUsageProtectionAssignment = (
  flagValue: boolean | null,
): AgentAutoContinueUsageProtectionAssignment | undefined => {
  if (flagValue === null) return undefined;
  return flagValue ? "test" : "control";
};

export const captureAgentAutoContinueRecoveryFinished = ({
  posthog,
  userId,
  subscription,
  endpoint,
  assignment,
  stopSource,
  refund,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  endpoint: string;
  assignment: AgentAutoContinueUsageProtectionAssignment;
  stopSource: AgentAutoContinueStopSource;
  refund?: UsageRefundOutcome;
}): void => {
  if (!posthog) return;
  posthog.capture({
    distinctId: userId,
    event: AGENT_AUTO_CONTINUE_RECOVERY_FINISHED_EVENT,
    properties: {
      experiment_key: AGENT_AUTO_CONTINUE_USAGE_PROTECTION_FLAG,
      experiment_variant: assignment,
      [`$feature/${AGENT_AUTO_CONTINUE_USAGE_PROTECTION_FLAG}`]:
        assignment === "test",
      subscription,
      subscription_tier: subscription,
      endpoint,
      stop_source: stopSource,
      refund_status: refund?.status ?? "not_attempted",
      included_points_refunded: refund?.includedPointsRefunded ?? 0,
      extra_usage_points_refunded: refund?.extraUsagePointsRefunded ?? 0,
      included_points_remaining: refund?.includedPointsRemaining ?? 0,
      extra_usage_points_remaining: refund?.extraUsagePointsRemaining ?? 0,
      exposure_surface: "incomplete_automatic_recovery",
      $process_person_profile: false,
    },
  });
};
