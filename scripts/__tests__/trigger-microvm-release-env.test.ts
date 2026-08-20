import {
  getTriggerMicrovmReleaseConfig,
  syncAndVerifyTriggerMicrovmReleaseEnv,
  TRIGGER_MICROVM_RELEASE_ENV_NAMES,
} from "../lib/trigger-microvm-release-env";

const releaseEnv = {
  TRIGGER_ACCESS_TOKEN: "tr_pat_test",
  TRIGGER_PROJECT_ID: "proj_test",
  AWS_LAMBDA_MICROVM_IMAGE_ID:
    "arn:aws:lambda:us-east-1:123:microvm-image:test",
  AWS_LAMBDA_MICROVM_IMAGE_VERSION: "15.0",
  AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN: "arn:aws:iam::123:role/test",
};

describe("Trigger.dev MicroVM release environment sync", () => {
  it("builds the exact production values without treating them as secrets", () => {
    expect(getTriggerMicrovmReleaseConfig(releaseEnv)).toEqual({
      accessToken: "tr_pat_test",
      projectRef: "proj_test",
      variables: {
        CLOUD_SANDBOX_PROVIDER: "aws-lambda-microvm",
        AWS_LAMBDA_MICROVM_IMAGE_ID:
          "arn:aws:lambda:us-east-1:123:microvm-image:test",
        AWS_LAMBDA_MICROVM_IMAGE_VERSION: "15.0",
        AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN: "arn:aws:iam::123:role/test",
      },
    });
  });

  it("requires every release input", () => {
    expect(() =>
      getTriggerMicrovmReleaseConfig({
        ...releaseEnv,
        AWS_LAMBDA_MICROVM_IMAGE_VERSION: " ",
      }),
    ).toThrow("AWS_LAMBDA_MICROVM_IMAGE_VERSION is required");
  });

  it("overrides and verifies every stored production value", async () => {
    const config = getTriggerMicrovmReleaseConfig(releaseEnv);
    const upload = jest.fn(async () => ({ success: true }));
    const retrieve = jest.fn(async (_project, _environment, name) => ({
      name,
      value: config.variables[name as keyof typeof config.variables],
      isSecret: false,
    }));

    await expect(
      syncAndVerifyTriggerMicrovmReleaseEnv({
        client: { upload, retrieve },
        config,
      }),
    ).resolves.toBeUndefined();

    expect(upload).toHaveBeenCalledWith("proj_test", "prod", {
      variables: config.variables,
      override: true,
    });
    expect(retrieve).toHaveBeenCalledTimes(
      TRIGGER_MICROVM_RELEASE_ENV_NAMES.length,
    );
  });

  it("fails the release when Trigger stores a different value", async () => {
    const config = getTriggerMicrovmReleaseConfig(releaseEnv);

    await expect(
      syncAndVerifyTriggerMicrovmReleaseEnv({
        client: {
          upload: async () => ({ success: true }),
          retrieve: async (_project, _environment, name) => ({
            name,
            value:
              name === "AWS_LAMBDA_MICROVM_IMAGE_VERSION"
                ? "14.0"
                : config.variables[name],
            isSecret: false,
          }),
        },
        config,
      }),
    ).rejects.toThrow(
      "Trigger.dev stored value verification failed for AWS_LAMBDA_MICROVM_IMAGE_VERSION",
    );
  });
});
