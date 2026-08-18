import type { PostHog } from "posthog-node";

import type { CloudSandboxProvider } from "@/lib/ai/tools/utils/cloud-sandbox-provider";
import type { SandboxPreference, SubscriptionTier } from "@/types";

export const AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY =
  "aws_lambda_microvm_ultra_rollout_v1";
export const AWS_LAMBDA_MICROVM_ROLLOUT_FEATURE_PROPERTY = `$feature/${AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY}`;

export type AwsLambdaMicrovmRolloutAssignment = {
  key: typeof AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY;
  provider: CloudSandboxProvider;
  eligible: boolean;
  variant: "aws" | "e2b";
  flagValue?: boolean;
  reason:
    | "provider_disabled"
    | "subscription_ineligible"
    | "flag_enabled"
    | "flag_disabled"
    | "flag_unavailable"
    | "flag_evaluation_failed"
    | "persisted_parent_sandbox";
};

export function getAwsLambdaMicrovmRolloutTelemetryProperties(
  rollout?: AwsLambdaMicrovmRolloutAssignment,
): Record<string, unknown> {
  if (!rollout) return {};
  return {
    rollout_eligible: rollout.eligible,
    rollout_flag_key: rollout.key,
    rollout_variant: rollout.variant,
    rollout_reason: rollout.reason,
    ...(rollout.flagValue !== undefined
      ? {
          [AWS_LAMBDA_MICROVM_ROLLOUT_FEATURE_PROPERTY]: rollout.flagValue,
        }
      : {}),
  };
}

const assignment = (
  provider: CloudSandboxProvider,
  eligible: boolean,
  reason: AwsLambdaMicrovmRolloutAssignment["reason"],
  flagValue?: boolean,
): AwsLambdaMicrovmRolloutAssignment => ({
  key: AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY,
  provider,
  eligible,
  variant: provider === "aws-lambda-microvm" ? "aws" : "e2b",
  ...(flagValue !== undefined ? { flagValue } : {}),
  reason,
});

/**
 * Resolve the cloud provider once per parent Agent run.
 *
 * Free users remain hard-gated outside PostHog because they cannot use a cloud
 * sandbox. Every paid plan is eligible for the rollout, while PostHog remains
 * the final provider gate. Evaluation failures route to E2B.
 */
export async function evaluateAwsLambdaMicrovmRollout({
  posthog,
  userId,
  subscription,
  configuredProvider,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  configuredProvider: CloudSandboxProvider;
  requestId?: string;
}): Promise<AwsLambdaMicrovmRolloutAssignment> {
  if (configuredProvider !== "aws-lambda-microvm") {
    return assignment("e2b", false, "provider_disabled");
  }
  if (subscription === "free") {
    return assignment("e2b", false, "subscription_ineligible");
  }
  if (!posthog) {
    return assignment("e2b", true, "flag_unavailable");
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY],
      personProperties: {
        subscription: subscription,
        subscription_tier: subscription,
      },
    });
    const value = flags.getFlag(AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY);
    if (value === true) {
      return assignment("aws-lambda-microvm", true, "flag_enabled", true);
    }
    if (value === false) {
      return assignment("e2b", true, "flag_disabled", false);
    }
    return assignment("e2b", true, "flag_unavailable");
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "aws_lambda_microvm_rollout_evaluation_failed",
        service: "cloud-sandbox-rollout",
        environment:
          process.env.TRIGGER_ENV ??
          process.env.VERCEL_ENV ??
          process.env.NODE_ENV ??
          "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        subscription_tier: subscription,
        flag_key: AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return assignment("e2b", true, "flag_evaluation_failed");
  }
}

/** Preserve the provider already acquired by a parent when a subagent starts. */
export function resolvePersistedSubagentCloudSandboxRollout({
  subscription,
  sandboxPreference,
  sandboxIdentity,
}: {
  subscription: SubscriptionTier;
  sandboxPreference?: SandboxPreference;
  sandboxIdentity?: string;
}): AwsLambdaMicrovmRolloutAssignment {
  const eligible = subscription !== "free";
  const hasAwsIdentity =
    sandboxIdentity?.startsWith("aws:") ||
    (sandboxPreference === "e2b" && sandboxIdentity?.startsWith("connection:"));
  const provider = eligible && hasAwsIdentity ? "aws-lambda-microvm" : "e2b";
  return assignment(
    provider,
    eligible,
    "persisted_parent_sandbox",
    eligible ? provider === "aws-lambda-microvm" : undefined,
  );
}
