import type { CloudSandboxProvider } from "@/lib/ai/tools/utils/cloud-sandbox-provider";
import type { SandboxPreference, SubscriptionTier } from "@/types";

export type AwsLambdaMicrovmRolloutAssignment = {
  provider: CloudSandboxProvider;
  eligible: boolean;
  variant: "aws" | "e2b";
  reason:
    | "provider_disabled"
    | "provider_enabled"
    | "subscription_ineligible"
    | "persisted_parent_sandbox";
};

export function getAwsLambdaMicrovmRolloutTelemetryProperties(
  rollout?: AwsLambdaMicrovmRolloutAssignment,
): Record<string, unknown> {
  if (!rollout) return {};
  return {
    rollout_eligible: rollout.eligible,
    rollout_variant: rollout.variant,
    rollout_reason: rollout.reason,
  };
}

const assignment = (
  provider: CloudSandboxProvider,
  eligible: boolean,
  reason: AwsLambdaMicrovmRolloutAssignment["reason"],
): AwsLambdaMicrovmRolloutAssignment => ({
  provider,
  eligible,
  variant: provider === "aws-lambda-microvm" ? "aws" : "e2b",
  reason,
});

/**
 * Resolve the cloud provider once per parent Agent run.
 *
 * Free users remain hard-gated because they cannot use a cloud sandbox. Every
 * paid plan uses AWS unless the explicit E2B emergency rollback is configured.
 */
export function resolveAwsLambdaMicrovmRollout({
  subscription,
  configuredProvider,
}: {
  subscription: SubscriptionTier;
  configuredProvider: CloudSandboxProvider;
}): AwsLambdaMicrovmRolloutAssignment {
  if (configuredProvider !== "aws-lambda-microvm") {
    return assignment("e2b", false, "provider_disabled");
  }
  if (subscription === "free") {
    return assignment("e2b", false, "subscription_ineligible");
  }
  return assignment("aws-lambda-microvm", true, "provider_enabled");
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
  return assignment(provider, eligible, "persisted_parent_sandbox");
}
