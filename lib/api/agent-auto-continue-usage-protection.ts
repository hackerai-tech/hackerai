import "server-only";

import type { PostHog } from "posthog-node";
import type { UIMessageStreamWriter } from "ai";
import type { AgentAutoContinueStopSource } from "@/lib/chat/stop-conditions";
import {
  captureAgentAutoContinueRecoveryFinished,
  type AgentAutoContinueUsageProtectionAssignment,
} from "@/lib/experiments/agent-auto-continue-usage-protection";
import type { UsageRefundTracker } from "@/lib/rate-limit/refund";
import { writeAutoContinueUsageProtected } from "@/lib/utils/stream-writer-utils";
import type { SubscriptionTier } from "@/types";

export const protectIncompleteAutomaticContinuation = async ({
  assignment,
  stopSource,
  usageRefundTracker,
  writer,
  posthog,
  userId,
  subscription,
  endpoint,
}: {
  assignment?: AgentAutoContinueUsageProtectionAssignment;
  stopSource: AgentAutoContinueStopSource | null;
  usageRefundTracker: UsageRefundTracker;
  writer: UIMessageStreamWriter;
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  endpoint: string;
}): Promise<void> => {
  if (!assignment || !stopSource) return;

  const refund =
    assignment === "test"
      ? await usageRefundTracker.refundWithResult()
      : undefined;

  if (refund?.status === "refunded") {
    writeAutoContinueUsageProtected(writer);
  }

  captureAgentAutoContinueRecoveryFinished({
    posthog,
    userId,
    subscription,
    endpoint,
    assignment,
    stopSource,
    refund,
  });
};
