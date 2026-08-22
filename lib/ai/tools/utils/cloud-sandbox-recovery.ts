import type { CloudSandboxAcquisitionContext } from "./cloud-sandbox";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider";

export class AlternateCloudSandboxUnavailableError extends Error {
  constructor() {
    super(
      "No rollout-authorized alternate cloud sandbox provider is available",
    );
    this.name = "AlternateCloudSandboxUnavailableError";
  }
}

export function selectAlternateCloudSandboxProviderForRecovery(
  context?: CloudSandboxAcquisitionContext,
): CloudSandboxProvider | null {
  // Keep AWS failures visible while the product migrates away from E2B.
  // A paid run that was eligible for the AWS rollout may use AWS for one
  // bounded recovery attempt when its E2B attachment placement fails, even
  // when the normal rollout assignment selected the E2B control variant.
  if (
    context?.provider !== "e2b" ||
    context.rollout?.eligible !== true ||
    context.subscription === "free"
  ) {
    return null;
  }

  context.recovery = {
    fromProvider: "e2b",
    toProvider: "aws-lambda-microvm",
    reason: "attachment_placement_failure",
  };
  context.provider = "aws-lambda-microvm";
  return "aws-lambda-microvm";
}

export function getCloudSandboxRecoveryTelemetryProperties(
  context?: CloudSandboxAcquisitionContext,
): Record<string, unknown> {
  if (!context?.recovery) return {};
  return {
    cloud_sandbox_recovery_from_provider: context.recovery.fromProvider,
    cloud_sandbox_recovery_to_provider: context.recovery.toProvider,
    cloud_sandbox_recovery_reason: context.recovery.reason,
  };
}
