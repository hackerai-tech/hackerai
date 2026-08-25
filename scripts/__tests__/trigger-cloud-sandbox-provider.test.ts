import {
  getTriggerCloudSandboxProviderConfig,
  setAndVerifyTriggerCloudSandboxProvider,
} from "../lib/trigger-cloud-sandbox-provider";

describe("Trigger.dev cloud sandbox provider rollout", () => {
  it("accepts an explicit E2B production rollout", () => {
    expect(
      getTriggerCloudSandboxProviderConfig({
        TRIGGER_ACCESS_TOKEN: "tr_pat_test",
        TRIGGER_PROJECT_ID: "proj_test",
        CLOUD_SANDBOX_PROVIDER: "e2b",
      }),
    ).toEqual({
      accessToken: "tr_pat_test",
      projectRef: "proj_test",
      provider: "e2b",
    });
  });

  it("rejects an unsupported provider", () => {
    expect(() =>
      getTriggerCloudSandboxProviderConfig({
        TRIGGER_ACCESS_TOKEN: "tr_pat_test",
        TRIGGER_PROJECT_ID: "proj_test",
        CLOUD_SANDBOX_PROVIDER: "unknown",
      }),
    ).toThrow("Unsupported CLOUD_SANDBOX_PROVIDER");
  });

  it("writes and verifies the production provider", async () => {
    const upload = jest.fn(async () => ({ success: true }));
    const retrieve = jest.fn(async () => ({
      name: "CLOUD_SANDBOX_PROVIDER",
      value: "e2b",
      isSecret: false,
    }));

    await setAndVerifyTriggerCloudSandboxProvider({
      client: { upload, retrieve },
      projectRef: "proj_test",
      provider: "e2b",
    });

    expect(upload).toHaveBeenCalledWith("proj_test", "prod", {
      variables: { CLOUD_SANDBOX_PROVIDER: "e2b" },
      override: true,
    });
    expect(retrieve).toHaveBeenCalledWith(
      "proj_test",
      "prod",
      "CLOUD_SANDBOX_PROVIDER",
    );
  });
});
