import {
  getCloudSandboxProvider,
  MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG,
  selectCloudSandboxProvider,
} from "../cloud-sandbox-provider";

describe("cloud sandbox provider selection", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;
  const originalMiosaKey = process.env.MIOSA_API_KEY;

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    } else {
      process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    }
    if (originalMiosaKey === undefined) delete process.env.MIOSA_API_KEY;
    else process.env.MIOSA_API_KEY = originalMiosaKey;
  });

  it("defaults to E2B", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("honors an explicit E2B provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "e2b";
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("honors an explicit MIOSA provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "miosa";
    expect(getCloudSandboxProvider()).toBe("miosa");
  });

  it("selects MIOSA only for an enabled rollout assignment with credentials", async () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    process.env.MIOSA_API_KEY = "msk_test";
    const getFeatureFlag = jest.fn(async () => true);

    await expect(
      selectCloudSandboxProvider({
        userId: "user-1",
        featureFlagClient: { getFeatureFlag },
      }),
    ).resolves.toEqual({ provider: "miosa", reason: "miosa_rollout" });
    expect(getFeatureFlag).toHaveBeenCalledWith(
      MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG,
      "user-1",
      { sendFeatureFlagEvents: false },
    );
  });

  it("keeps E2B when MIOSA credentials are unavailable", async () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    delete process.env.MIOSA_API_KEY;
    const getFeatureFlag = jest.fn(async () => true);

    await expect(
      selectCloudSandboxProvider({
        userId: "user-1",
        featureFlagClient: { getFeatureFlag },
      }),
    ).resolves.toEqual({
      provider: "e2b",
      reason: "miosa_credentials_unavailable",
    });
    expect(getFeatureFlag).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "unknown-provider";
    expect(() => getCloudSandboxProvider()).toThrow(
      "Unsupported CLOUD_SANDBOX_PROVIDER",
    );
  });
});
