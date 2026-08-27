import { E2B_COST_PER_MS } from "@/lib/ai/tools/utils/e2b-cost";
import {
  BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
  E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS,
} from "@/lib/ai/tools/utils/e2b-lease";
import {
  getPostHogFeatureFlagValueForUser,
  phLogger,
} from "@/lib/posthog/server";

export const E2B_IDLE_LEASE_RELEASE_FLAG_KEY = "e2b-idle-lease-release";
export const E2B_IDLE_LEASE_FLAG_EVALUATION_TIMEOUT_MS = 2_000;

type FlagEvaluator = (
  flagKey: string,
  userId: string,
) => Promise<boolean | null>;

type ExposureCapture = (
  event: string,
  properties: Record<string, unknown> & { userId: string },
) => void;

export type E2BIdleLeaseReleaseOutcome =
  | "not_eligible"
  | "flag_unavailable"
  | "control"
  | "released"
  | "release_failed";

const evaluateFlagWithTimeout = async (
  evaluateFlag: FlagEvaluator,
  userId: string,
): Promise<boolean | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      evaluateFlag(E2B_IDLE_LEASE_RELEASE_FLAG_KEY, userId),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(null),
          E2B_IDLE_LEASE_FLAG_EVALUATION_TIMEOUT_MS,
        );
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * Evaluates and records the eligible experiment assignment, shortening the
 * settled sandbox lease only for treatment users and failing closed otherwise.
 */
export async function finalizeE2BIdleLeaseRelease({
  userId,
  chatId,
  triggerRunId,
  triggerRegion,
  subscription,
  e2bRuntimeMs,
  releaseLease,
  evaluateFlag = getPostHogFeatureFlagValueForUser,
  captureExposure = (event, properties) => phLogger.event(event, properties),
}: {
  userId: string;
  chatId: string;
  triggerRunId: string;
  triggerRegion: string;
  subscription: string;
  e2bRuntimeMs: number;
  releaseLease: () => Promise<boolean>;
  evaluateFlag?: FlagEvaluator;
  captureExposure?: ExposureCapture;
}): Promise<E2BIdleLeaseReleaseOutcome> {
  if (e2bRuntimeMs <= 0) return "not_eligible";

  const enabled = await evaluateFlagWithTimeout(evaluateFlag, userId);
  if (enabled === null) {
    phLogger.warn("E2B idle lease flag evaluation unavailable", {
      event: "e2b_idle_lease_release_flag_unavailable",
      userId,
      chat_id: chatId,
      trigger_run_id: triggerRunId,
    });
    return "flag_unavailable";
  }

  const released = enabled ? await releaseLease() : false;
  const outcome: E2BIdleLeaseReleaseOutcome = enabled
    ? released
      ? "released"
      : "release_failed"
    : "control";
  const potentialIdleSavingsMs =
    BASH_SANDBOX_AUTOPAUSE_TIMEOUT - E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS;

  captureExposure("e2b_idle_lease_release_exposure", {
    userId,
    chat_id: chatId,
    trigger_run_id: triggerRunId,
    trigger_region: triggerRegion,
    subscription_tier: subscription,
    feature_flag_key: E2B_IDLE_LEASE_RELEASE_FLAG_KEY,
    feature_flag_enabled: enabled,
    [`$feature/${E2B_IDLE_LEASE_RELEASE_FLAG_KEY}`]: enabled,
    assignment: enabled ? "treatment" : "control",
    release_outcome: outcome,
    e2b_runtime_ms: e2bRuntimeMs,
    normal_timeout_ms: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    release_timeout_ms: E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS,
    potential_idle_savings_ms: potentialIdleSavingsMs,
    estimated_max_cost_savings_usd: released
      ? potentialIdleSavingsMs * E2B_COST_PER_MS
      : 0,
    event_version: 1,
  });

  return outcome;
}
