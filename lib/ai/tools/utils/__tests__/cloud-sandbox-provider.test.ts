import { getCloudSandboxProvider } from "../cloud-sandbox-provider";

describe("cloud sandbox provider selection", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;
  const originalImage = process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    } else {
      process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    }
    if (originalImage === undefined) {
      delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
    } else {
      process.env.AWS_LAMBDA_MICROVM_IMAGE_ID = originalImage;
    }
  });

  it("defaults to E2B when AWS is not configured", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("selects AWS when an image is explicitly configured", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ID = "arn:aws:lambda:microvm-image";
    expect(getCloudSandboxProvider()).toBe("aws-lambda-microvm");
  });

  it("honors an explicit E2B rollback even when an AWS image remains set", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "e2b";
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ID = "arn:aws:lambda:microvm-image";
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("fails closed for an unsupported provider", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "unknown-provider";
    expect(() => getCloudSandboxProvider()).toThrow(
      "Unsupported CLOUD_SANDBOX_PROVIDER",
    );
  });
});
