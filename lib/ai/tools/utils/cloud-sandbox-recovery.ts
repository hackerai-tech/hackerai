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
  // AWS-assigned runs may safely fall back to the established E2B backend.
  // E2B-assigned runs must not bypass the AWS rollout gate during recovery.
  if (context?.provider !== "aws-lambda-microvm" || !process.env.E2B_API_KEY) {
    return null;
  }

  context.recovery = {
    fromProvider: "aws-lambda-microvm",
    toProvider: "e2b",
    reason: "attachment_placement_failure",
  };
  context.provider = "e2b";
  return "e2b";
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
