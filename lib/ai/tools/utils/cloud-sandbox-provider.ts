export type CloudSandboxProvider = "e2b" | "aws-lambda-microvm";

export function getCloudSandboxProvider(): CloudSandboxProvider {
  const configured = process.env.CLOUD_SANDBOX_PROVIDER?.trim();
  if (configured === "e2b" || configured === "aws-lambda-microvm") {
    return configured;
  }
  if (configured) {
    throw new Error(
      `Unsupported CLOUD_SANDBOX_PROVIDER: ${configured}. Expected e2b or aws-lambda-microvm.`,
    );
  }

  // Supplying an image is an explicit opt-in that makes AWS the cloud
  // provider without requiring a second environment variable.
  return process.env.AWS_LAMBDA_MICROVM_IMAGE_ID ? "aws-lambda-microvm" : "e2b";
}
