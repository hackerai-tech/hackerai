import {
  AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY,
  evaluateAwsLambdaMicrovmRollout,
  getAwsLambdaMicrovmRolloutTelemetryProperties,
  resolvePersistedSubagentCloudSandboxRollout,
} from "../aws-lambda-microvm-rollout";

describe("AWS Lambda MicroVM paid rollout", () => {
  it("hard-gates the free plan to E2B before flag evaluation", async () => {
    const evaluateFlags = jest.fn();

    await expect(
      evaluateAwsLambdaMicrovmRollout({
        posthog: { evaluateFlags } as never,
        userId: "user-free",
        subscription: "free",
        configuredProvider: "aws-lambda-microvm",
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
      }),
    ).resolves.toMatchObject({
      provider: "e2b",
      eligible: false,
      reason: "provider_disabled",
    });
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it.each(["pro", "pro-plus", "ultra", "team"] as const)(
    "allows the %s plan to reach PostHog rollout evaluation",
    async (subscription) => {
      const evaluateFlags = jest.fn(async () => ({
        getFlag: (key: string) =>
          key === AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY ? true : undefined,
      }));

      await expect(
        evaluateAwsLambdaMicrovmRollout({
          posthog: { evaluateFlags } as never,
          userId: `user-${subscription}`,
          subscription,
          configuredProvider: "aws-lambda-microvm",
        }),
      ).resolves.toMatchObject({
        provider: "aws-lambda-microvm",
        eligible: true,
        variant: "aws",
        flagValue: true,
        reason: "flag_enabled",
      });
      expect(evaluateFlags).toHaveBeenCalledWith(`user-${subscription}`, {
        flagKeys: [AWS_LAMBDA_MICROVM_ROLLOUT_FLAG_KEY],
        personProperties: {
          subscription,
          subscription_tier: subscription,
        },
      });
    },
  );

  it("routes a disabled paid flag to E2B", async () => {
    const evaluateFlags = jest.fn(async () => ({ getFlag: () => false }));

    await expect(
      evaluateAwsLambdaMicrovmRollout({
        posthog: { evaluateFlags } as never,
        userId: "user-pro",
        subscription: "pro",
        configuredProvider: "aws-lambda-microvm",
      }),
    ).resolves.toMatchObject({
      provider: "e2b",
      eligible: true,
      variant: "e2b",
      flagValue: false,
      reason: "flag_disabled",
    });
  });

  it("fails closed without claiming a control exposure when the flag is absent", async () => {
    const evaluateFlags = jest.fn(async () => ({
      getFlag: () => undefined,
    }));

    const result = await evaluateAwsLambdaMicrovmRollout({
      posthog: { evaluateFlags } as never,
      userId: "user-ultra",
      subscription: "ultra",
      configuredProvider: "aws-lambda-microvm",
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
    expect(
      resolvePersistedSubagentCloudSandboxRollout({
        subscription: "pro",
        sandboxPreference: "e2b",
        sandboxIdentity: "connection:paid-aws-relay",
      }),
    ).toMatchObject({
      provider: "aws-lambda-microvm",
      eligible: true,
      flagValue: true,
    });
    const freeAssignment = resolvePersistedSubagentCloudSandboxRollout({
      subscription: "free",
      sandboxPreference: "e2b",
      sandboxIdentity: "connection:stale-aws-relay",
    });
    expect(freeAssignment).toMatchObject({
      provider: "e2b",
      eligible: false,
    });
    expect(freeAssignment).not.toHaveProperty("flagValue");
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
