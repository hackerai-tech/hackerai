export type CloudSandboxProvider = "e2b" | "aws-lambda-microvm";

/**
 * Resolve the configured cloud sandbox provider, defaulting to E2B and
 * rejecting unsupported values instead of silently selecting a provider.
 */
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

  // E2B is the default cloud provider. AWS remains available through the
  // explicit environment setting above as an operational rollback.
  return "e2b";
}
