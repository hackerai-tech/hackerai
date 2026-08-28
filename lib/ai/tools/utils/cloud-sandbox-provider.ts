export type CloudSandboxProvider = "e2b" | "miosa";

const SUPPORTED: readonly CloudSandboxProvider[] = ["e2b", "miosa"] as const;

/**
 * Resolve the configured cloud sandbox provider, defaulting to E2B and
 * rejecting unsupported values instead of silently selecting a provider.
 *
 * `miosa` runs the same image on Firecracker microVMs. Both providers build the
 * sandbox FROM `docker/Dockerfile` - the sandbox is the image, not a container
 * inside a VM - so the agent's tooling and paths are unchanged between them.
 */
export function getCloudSandboxProvider(): CloudSandboxProvider {
  const configured = process.env.CLOUD_SANDBOX_PROVIDER?.trim();

  if (configured && (SUPPORTED as readonly string[]).includes(configured)) {
    return configured as CloudSandboxProvider;
  }

  if (configured) {
    throw new Error(
      `Unsupported CLOUD_SANDBOX_PROVIDER: ${configured}. Expected one of ${SUPPORTED.join(", ")}.`,
    );
  }

  return "e2b";
}
