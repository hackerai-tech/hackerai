import {
  getCloudSandboxProvider,
  MIOSA_CLOUD_SANDBOX_ENVIRONMENT_PROPERTY,
  MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG,
  selectCloudSandboxProvider,
} from "../cloud-sandbox-provider";

describe("cloud sandbox provider selection", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;
  const originalMiosaKey = process.env.MIOSA_API_KEY;
  const originalVercelEnvironment = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    } else {
      process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    }
    if (originalMiosaKey === undefined) delete process.env.MIOSA_API_KEY;
    else process.env.MIOSA_API_KEY = originalMiosaKey;
    if (originalVercelEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnvironment;
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
    process.env.VERCEL_ENV = "preview";
    const getFlag = jest.fn(() => true);
    const evaluateFlags = jest.fn(async () => ({ getFlag }));

    await expect(
      selectCloudSandboxProvider({
        userId: "user-1",
        featureFlagClient: { evaluateFlags },
      }),
    ).resolves.toEqual({ provider: "miosa", reason: "miosa_rollout" });
    expect(evaluateFlags).toHaveBeenCalledWith("user-1", {
      flagKeys: [MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG],
      personProperties: {
        [MIOSA_CLOUD_SANDBOX_ENVIRONMENT_PROPERTY]: "preview",
      },
    });
    expect(getFlag).toHaveBeenCalledWith(MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG);
  });

  it("keeps E2B when MIOSA credentials are unavailable", async () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    delete process.env.MIOSA_API_KEY;
    const evaluateFlags = jest.fn(async () => ({
      getFlag: () => true,
    }));

    await expect(
      selectCloudSandboxProvider({
        userId: "user-1",
        featureFlagClient: { evaluateFlags },
      }),
    ).resolves.toEqual({
      provider: "e2b",
      reason: "miosa_credentials_unavailable",
    });
    expect(evaluateFlags).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "unknown-provider";
    expect(() => getCloudSandboxProvider()).toThrow(
      "Unsupported CLOUD_SANDBOX_PROVIDER",
    );
  });
});
