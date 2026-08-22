jest.mock("server-only", () => ({}), { virtual: true });

import {
  getCloudSandboxRecoveryTelemetryProperties,
  selectAlternateCloudSandboxProviderForRecovery,
} from "../cloud-sandbox-recovery";
import type { CloudSandboxAcquisitionContext } from "../cloud-sandbox";

describe("cloud sandbox placement recovery", () => {
  it("switches an eligible E2B-assigned paid run once to AWS", () => {
    const context: CloudSandboxAcquisitionContext = {
      provider: "e2b",
      subscription: "pro",
      rollout: {
        provider: "e2b",
        eligible: true,
        variant: "e2b",
        reason: "persisted_parent_sandbox",
      },
    };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBe(
      "aws-lambda-microvm",
    );
    expect(context.provider).toBe("aws-lambda-microvm");
    expect(getCloudSandboxRecoveryTelemetryProperties(context)).toEqual({
      cloud_sandbox_recovery_from_provider: "e2b",
      cloud_sandbox_recovery_to_provider: "aws-lambda-microvm",
      cloud_sandbox_recovery_reason: "attachment_placement_failure",
    });
  });

  it("does not mask an AWS-assigned run failure with E2B", () => {
    const context: CloudSandboxAcquisitionContext = {
      provider: "aws-lambda-microvm",
      subscription: "pro",
    };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBeNull();
    expect(context.provider).toBe("aws-lambda-microvm");
  });

  it("does not bypass rollout eligibility for an E2B-assigned run", () => {
    const context: CloudSandboxAcquisitionContext = {
      provider: "e2b",
      subscription: "pro",
      rollout: {
        provider: "e2b",
        eligible: false,
        variant: "e2b",
        reason: "provider_disabled",
      },
    };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBeNull();
    expect(context.provider).toBe("e2b");
  });

  it("keeps free users out of cloud recovery", () => {
    const context: CloudSandboxAcquisitionContext = {
      provider: "e2b",
      subscription: "free",
      rollout: {
        provider: "e2b",
        eligible: false,
        variant: "e2b",
        reason: "subscription_ineligible",
      },
    };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBeNull();
    expect(context.provider).toBe("e2b");
  });
});
