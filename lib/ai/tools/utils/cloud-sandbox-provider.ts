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

  // AWS is the fully released provider. Keep the explicit environment setting
  // above as an emergency rollback to E2B.
  return "aws-lambda-microvm";
}
