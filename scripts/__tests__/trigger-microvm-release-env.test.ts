import {
  getTriggerMicrovmReleaseConfig,
  syncAndVerifyTriggerMicrovmReleaseEnv,
  TRIGGER_MICROVM_RELEASE_ENV_NAMES,
} from "../lib/trigger-microvm-release-env";

const releaseManifest = {
  schemaVersion: 1,
  releaseId: "sha-test",
  regions: Object.fromEntries(
    ["us-east-1", "us-west-2", "eu-west-1"].map((region) => [
      region,
      {
        imageIdentifier: `arn:aws:lambda:${region}:123:microvm-image:test`,
        imageVersion: "15.0",
        executionRoleArn: `arn:aws:iam::123:role/test-${region}`,
        egressConnectorArn: `arn:aws:lambda:${region}:123:network-connector:hackerai-static-egress:1`,
        egressIpv4Address: "192.0.2.10",
        enabledForNewPlacements: true,
      },
    ]),
  ),
};

const releaseEnv = {
  TRIGGER_ACCESS_TOKEN: "tr_pat_test",
  TRIGGER_PROJECT_ID: "proj_test",
  AWS_LAMBDA_MICROVM_RELEASE_MANIFEST: JSON.stringify(releaseManifest),
};

describe("Trigger.dev MicroVM release environment sync", () => {
  it("builds the exact production values without treating them as secrets", () => {
    expect(getTriggerMicrovmReleaseConfig(releaseEnv)).toEqual({
      accessToken: "tr_pat_test",
      projectRef: "proj_test",
      variables: {
        CLOUD_SANDBOX_PROVIDER: "aws-lambda-microvm",
        AWS_LAMBDA_MICROVM_RELEASE_MANIFEST: JSON.stringify(releaseManifest),
        AWS_LAMBDA_MICROVM_IMAGE_ID:
          "arn:aws:lambda:us-east-1:123:microvm-image:test",
        AWS_LAMBDA_MICROVM_IMAGE_VERSION: "15.0",
        AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN:
          "arn:aws:iam::123:role/test-us-east-1",
      },
    });
  });

  it("requires every release input", () => {
    expect(() =>
      getTriggerMicrovmReleaseConfig({
        ...releaseEnv,
        AWS_LAMBDA_MICROVM_RELEASE_MANIFEST: " ",
      }),
    ).toThrow("AWS_LAMBDA_MICROVM_RELEASE_MANIFEST is required");
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
