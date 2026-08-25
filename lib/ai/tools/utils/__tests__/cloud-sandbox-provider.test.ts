import { getCloudSandboxProvider } from "../cloud-sandbox-provider";

describe("cloud sandbox provider selection", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    } else {
      process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    }
  });

  it("defaults to E2B", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("honors an explicit E2B provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "e2b";
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("fails closed for an unsupported provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "unknown-provider";
    expect(() => getCloudSandboxProvider()).toThrow(
      "Unsupported CLOUD_SANDBOX_PROVIDER",
    );
  });
});
