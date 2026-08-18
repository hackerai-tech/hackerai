import {
  AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY,
  evaluateAwsLambdaMicrovmRollout,
  getAwsLambdaMicrovmRolloutTelemetryProperties,
  resolvePersistedSubagentCloudSandboxRollout,
} from "../aws-lambda-microvm-rollout";

const production = {
  VERCEL_ENV: "production",
  TRIGGER_ENV: "PRODUCTION",
  NODE_ENV: "production",
};

describe("AWS Lambda MicroVM Ultra rollout", () => {
  it("hard-gates every non-Ultra plan to E2B before flag evaluation", async () => {
    const evaluateFlags = jest.fn();

    await expect(
      evaluateAwsLambdaMicrovmRollout({
        posthog: { evaluateFlags } as never,
        userId: "user-pro",
        subscription: "pro",
        configuredProvider: "aws-lambda-microvm",
        environment: production,
      }),
    ).resolves.toMatchObject({
      provider: "e2b",
      eligible: false,
      variant: "e2b",
      reason: "subscription_ineligible",
    });
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("keeps the explicit E2B rollback authoritative", async () => {
    const evaluateFlags = jest.fn();

    await expect(
      evaluateAwsLambdaMicrovmRollout({
        posthog: { evaluateFlags } as never,
        userId: "user-ultra",
        subscription: "ultra",
        configuredProvider: "e2b",
        environment: production,
      }),
    ).resolves.toMatchObject({
      provider: "e2b",
      eligible: false,
      reason: "provider_disabled",
    });
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it.each([
    [true, "aws-lambda-microvm", "aws", "flag_enabled"],
    [false, "e2b", "e2b", "flag_disabled"],
  ] as const)(
    "routes an Ultra flag value of %s to %s",
    async (value, provider, variant, reason) => {
      const evaluateFlags = jest.fn(async () => ({
        getFlag: (key: string) =>
          key === AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY ? value : undefined,
      }));

      await expect(
        evaluateAwsLambdaMicrovmRollout({
          posthog: { evaluateFlags } as never,
          userId: "user-ultra",
          subscription: "ultra",
          configuredProvider: "aws-lambda-microvm",
          environment: production,
        }),
      ).resolves.toMatchObject({
        provider,
        eligible: true,
        variant,
        flagValue: value,
        reason,
      });
      expect(evaluateFlags).toHaveBeenCalledWith("user-ultra", {
        flagKeys: [AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY],
        personProperties: {
          subscription: "ultra",
          subscription_tier: "ultra",
        },
      });
    },
  );

  it("fails closed without claiming a control exposure when the flag is absent", async () => {
    const evaluateFlags = jest.fn(async () => ({
      getFlag: () => undefined,
    }));

    const result = await evaluateAwsLambdaMicrovmRollout({
      posthog: { evaluateFlags } as never,
      userId: "user-ultra",
      subscription: "ultra",
      configuredProvider: "aws-lambda-microvm",
      environment: production,
    });

    expect(result).toMatchObject({
      provider: "e2b",
      eligible: true,
      reason: "flag_unavailable",
    });
    expect(result).not.toHaveProperty("flagValue");
  });

  it("fails closed to E2B when PostHog evaluation fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation();

    await expect(
      evaluateAwsLambdaMicrovmRollout({
        posthog: {
          evaluateFlags: jest.fn(async () => {
            throw Object.assign(new Error("private detail"), {
              name: "FlagServiceError",
            });
          }),
        } as never,
        userId: "user-ultra",
        subscription: "ultra",
        configuredProvider: "aws-lambda-microvm",
        requestId: "run-1",
        environment: production,
      }),
    ).resolves.toMatchObject({
      provider: "e2b",
      eligible: true,
      reason: "flag_evaluation_failed",
    });

    const log = JSON.parse(warn.mock.calls[0][0] as string);
    expect(log).toMatchObject({
      event: "aws_lambda_microvm_rollout_evaluation_failed",
      request_id: "run-1",
      error_name: "FlagServiceError",
    });
    expect(warn.mock.calls[0][0]).not.toContain("private detail");
    warn.mockRestore();
  });

  it("enables AWS for Ultra users in non-production previews", async () => {
    const evaluateFlags = jest.fn();
    await expect(
      evaluateAwsLambdaMicrovmRollout({
        posthog: { evaluateFlags } as never,
        userId: "user-ultra",
        subscription: "ultra",
        configuredProvider: "aws-lambda-microvm",
        environment: { VERCEL_ENV: "preview", NODE_ENV: "production" },
      }),
    ).resolves.toMatchObject({
      provider: "aws-lambda-microvm",
      eligible: true,
      reason: "non_production_ultra",
    });
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("preserves the parent provider for validation subagents", () => {
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "ultra",
        sandboxPreference: "desktop",
        sandboxIdentity: "aws:aws-relay",
      }),
    ).toMatchObject({ provider: "aws-lambda-microvm", flagValue: true });
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "ultra",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:legacy-aws-relay",
      }),
    ).toMatchObject({ provider: "aws-lambda-microvm", flagValue: true });
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "ultra",
        sandboxPreference: "e2b",
        sandboxIdentity: "e2b:sandbox-123",
      }),
    ).toMatchObject({ provider: "e2b", flagValue: false });
    const downgradedAssignment = resolvePersistedSubagentCloudSandboxRollout({
      subscription: "pro",
      sandboxPreference: "e2b",
      sandboxIdentity: "connection:stale-aws-relay",
    });
    expect(downgradedAssignment).toMatchObject({
      provider: "e2b",
      eligible: false,
    });
    expect(downgradedAssignment).not.toHaveProperty("flagValue");
  });

  it("carries the evaluated flag value on provider outcome events", () => {
    expect(
      getAwsLambdaMicrovmRolloutTelemetryProperties({
        key: AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY,
        provider: "aws-lambda-microvm",
        eligible: true,
        variant: "aws",
        flagValue: true,
        reason: "flag_enabled",
      }),
    ).toEqual({
      rollout_eligible: true,
      rollout_flag_key: AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY,
      rollout_variant: "aws",
      rollout_reason: "flag_enabled",
      [`$feature/${AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY}`]: true,
    });
  });
});
