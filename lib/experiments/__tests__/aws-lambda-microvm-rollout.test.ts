import {
  getAwsLambdaMicrovmRolloutTelemetryProperties,
  resolveAwsLambdaMicrovmRollout,
  resolvePersistedSubagentCloudSandboxRollout,
} from "../aws-lambda-microvm-rollout";

describe("AWS Lambda MicroVM paid rollout", () => {
  it("hard-gates the free plan to E2B", () => {
    expect(
      resolveAwsLambdaMicrovmRollout({
        subscription: "free",
        configuredProvider: "aws-lambda-microvm",
      }),
    ).toMatchObject({
      provider: "e2b",
      eligible: false,
      variant: "e2b",
      reason: "subscription_ineligible",
    });
  });

  it("keeps the explicit E2B rollback authoritative", () => {
    expect(
      resolveAwsLambdaMicrovmRollout({
        subscription: "ultra",
        configuredProvider: "e2b",
      }),
    ).toMatchObject({
      provider: "e2b",
      eligible: false,
      variant: "e2b",
      reason: "provider_disabled",
    });
  });

  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "routes the %s plan directly to AWS without flag evaluation",
    (subscription) => {
      expect(
        resolveAwsLambdaMicrovmRollout({
          subscription,
          configuredProvider: "aws-lambda-microvm",
        }),
      ).toMatchObject({
        provider: "aws-lambda-microvm",
        eligible: true,
        variant: "aws",
        reason: "provider_enabled",
      });
    },
  );

  it("preserves the parent provider for validation subagents", () => {
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "ultra",
        sandboxPreference: "desktop",
        sandboxIdentity: "aws:aws-relay",
      }),
    ).toMatchObject({ provider: "aws-lambda-microvm" });
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "ultra",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:legacy-aws-relay",
      }),
    ).toMatchObject({ provider: "aws-lambda-microvm" });
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "ultra",
        sandboxPreference: "e2b",
        sandboxIdentity: "e2b:sandbox-123",
      }),
    ).toMatchObject({ provider: "e2b" });
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "pro",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:paid-aws-relay",
      }),
    ).toMatchObject({
      provider: "aws-lambda-microvm",
      eligible: true,
    });
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "free",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:stale-aws-relay",
      }),
    ).toMatchObject({
      provider: "e2b",
      eligible: false,
    });
  });

  it("keeps provider outcome telemetry without a feature-flag property", () => {
    expect(
      getAwsLambdaMicrovmRolloutTelemetryProperties({
        provider: "aws-lambda-microvm",
        eligible: true,
        variant: "aws",
        reason: "provider_enabled",
      }),
    ).toEqual({
      rollout_eligible: true,
      rollout_variant: "aws",
      rollout_reason: "provider_enabled",
    });
  });
});
