import { getCloudSandboxProvider } from "../cloud-sandbox-provider";

describe("cloud sandbox provider selection", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;
  const originalImage = process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
  const originalManifest = process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST;

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
    if (originalManifest === undefined) {
      delete process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST;
    } else {
      process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = originalManifest;
    }
  });

  it("defaults to E2B", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
    delete process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST;
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("does not let a stale AWS release manifest override the E2B default", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
    process.env.AWS_LAMBDA_MICROVM_RELEASE_MANIFEST = "{}";
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("does not let a stale AWS image override the E2B default", () => {
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    process.env.AWS_LAMBDA_MICROVM_IMAGE_ID = "arn:aws:lambda:microvm-image";
    expect(getCloudSandboxProvider()).toBe("e2b");
  });

  it("honors an explicit AWS rollback", () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "aws-lambda-microvm";
    expect(getCloudSandboxProvider()).toBe("aws-lambda-microvm");
  });

  it("honors explicit E2B even when an AWS image remains set", () => {
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
