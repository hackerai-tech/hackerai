jest.mock("server-only", () => ({}), { virtual: true });

import {
  getCloudSandboxRecoveryTelemetryProperties,
  selectAlternateCloudSandboxProviderForRecovery,
} from "../cloud-sandbox-recovery";
import type { CloudSandboxAcquisitionContext } from "../cloud-sandbox";

describe("cloud sandbox placement recovery", () => {
  const originalE2BApiKey = process.env.E2B_API_KEY;

  afterEach(() => {
    if (originalE2BApiKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = originalE2BApiKey;
  });

  it("switches an AWS-assigned run once to the established E2B backend", () => {
    process.env.E2B_API_KEY = "configured";
    const context: CloudSandboxAcquisitionContext = {
      provider: "aws-lambda-microvm",
    };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBe("e2b");
    expect(context.provider).toBe("e2b");
    expect(getCloudSandboxRecoveryTelemetryProperties(context)).toEqual({
      cloud_sandbox_recovery_from_provider: "aws-lambda-microvm",
      cloud_sandbox_recovery_to_provider: "e2b",
      cloud_sandbox_recovery_reason: "attachment_placement_failure",
    });
  });

  it("does not bypass the AWS rollout for an E2B-assigned run", () => {
    process.env.E2B_API_KEY = "configured";
    const context: CloudSandboxAcquisitionContext = { provider: "e2b" };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBeNull();
    expect(context).toEqual({ provider: "e2b" });
  });

  it("fails closed when E2B is not configured", () => {
    delete process.env.E2B_API_KEY;
    const context: CloudSandboxAcquisitionContext = {
      provider: "aws-lambda-microvm",
    };

    expect(selectAlternateCloudSandboxProviderForRecovery(context)).toBeNull();
    expect(context.provider).toBe("aws-lambda-microvm");
  });
});
