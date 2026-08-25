export type CloudSandboxProvider = "e2b";

/**
 * Resolve the configured cloud sandbox provider, defaulting to E2B and
 * rejecting unsupported values instead of silently selecting a provider.
 */
export function getCloudSandboxProvider(): CloudSandboxProvider {
  const configured = process.env.CLOUD_SANDBOX_PROVIDER?.trim();
  if (configured === "e2b") {
    return configured;
  }
  if (configured) {
    throw new Error(
      `Unsupported CLOUD_SANDBOX_PROVIDER: ${configured}. Expected e2b.`,
    );
  }

  return "e2b";
}
