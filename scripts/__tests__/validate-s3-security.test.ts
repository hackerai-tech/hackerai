import { validateWorkspaceBucketVersioning } from "../validate-s3-security";

const WORKSPACE_BUCKET_ENV_NAMES = [
  "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_US_EAST_1",
  "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_US_WEST_2",
  "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_EU_WEST_1",
] as const;

describe("MicroVM workspace bucket versioning validation", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;
  const originalBuckets = Object.fromEntries(
    WORKSPACE_BUCKET_ENV_NAMES.map((name) => [name, process.env[name]]),
  );

  beforeEach(() => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    for (const name of WORKSPACE_BUCKET_ENV_NAMES) delete process.env[name];
  });

  afterAll(() => {
    if (originalProvider === undefined) {
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    } else {
      process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    }
    for (const name of WORKSPACE_BUCKET_ENV_NAMES) {
      const value = originalBuckets[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("warns without failing when the MicroVM provider is not configured", async () => {
    const readVersioning = jest.fn();

    await expect(
      validateWorkspaceBucketVersioning(readVersioning),
    ).resolves.toEqual(
      expect.objectContaining({ passed: true, warning: expect.any(String) }),
    );
    expect(readVersioning).not.toHaveBeenCalled();
  });

  it("fails closed when a selected provider has incomplete bucket configuration", async () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "aws-lambda-microvm";
    process.env[WORKSPACE_BUCKET_ENV_NAMES[0]] = "workspace-east";
    const readVersioning = jest.fn();

    const result = await validateWorkspaceBucketVersioning(readVersioning);

    expect(result.passed).toBe(false);
    expect(result.message).toContain(WORKSPACE_BUCKET_ENV_NAMES[1]);
    expect(result.message).toContain(WORKSPACE_BUCKET_ENV_NAMES[2]);
    expect(readVersioning).not.toHaveBeenCalled();
  });

  it.each(["Enabled", "Suspended"])(
    "rejects a workspace bucket whose versioning status is %s",
    async (status) => {
      for (const [index, name] of WORKSPACE_BUCKET_ENV_NAMES.entries()) {
        process.env[name] = `workspace-${index}`;
      }
      const readVersioning = jest.fn(async (region: string) =>
        region === "us-west-2" ? status : undefined,
      );

      const result = await validateWorkspaceBucketVersioning(readVersioning);

      expect(result.passed).toBe(false);
      expect(result.message).toContain(`us-west-2 (${status})`);
      expect(readVersioning).toHaveBeenCalledTimes(3);
    },
  );

  it("accepts only never-versioned workspace buckets", async () => {
    for (const [index, name] of WORKSPACE_BUCKET_ENV_NAMES.entries()) {
      process.env[name] = `workspace-${index}`;
    }
    const readVersioning = jest.fn().mockResolvedValue(undefined);

    await expect(
      validateWorkspaceBucketVersioning(readVersioning),
    ).resolves.toEqual(expect.objectContaining({ passed: true }));
    expect(readVersioning).toHaveBeenCalledTimes(3);
  });

  it("fails closed when versioning status cannot be verified", async () => {
    for (const [index, name] of WORKSPACE_BUCKET_ENV_NAMES.entries()) {
      process.env[name] = `workspace-${index}`;
    }
    const readVersioning = jest
      .fn()
      .mockRejectedValue(new Error("AccessDenied"));

    const result = await validateWorkspaceBucketVersioning(readVersioning);

    expect(result).toEqual(
      expect.objectContaining({ passed: false, message: expect.any(String) }),
    );
  });
});
