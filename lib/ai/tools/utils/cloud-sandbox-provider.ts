export type CloudSandboxProvider = "miosa" | "e2b";
export type CloudSandboxSelectionReason =
  | "configured"
  | "miosa_rollout"
  | "miosa_rollout_control"
  | "miosa_credentials_unavailable";

export const MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG =
  "miosa_cloud_sandbox_rollout_v1";
export const MIOSA_CLOUD_SANDBOX_ENVIRONMENT_PROPERTY = "hackerai_environment";

/**
 * Resolve an explicit provider override. Without one, production request
 * routing is decided by {@link selectCloudSandboxProvider}.
 */
export function getCloudSandboxProvider(): CloudSandboxProvider {
  const configured = process.env.CLOUD_SANDBOX_PROVIDER?.trim();
  if (configured === "e2b" || configured === "miosa") {
    return configured;
  }
  if (configured) {
    throw new Error(
      `Unsupported CLOUD_SANDBOX_PROVIDER: ${configured}. Expected miosa or e2b.`,
    );
  }

  return "e2b";
}

type FeatureFlagClient = {
  evaluateFlags: (
    distinctId: string,
    options?: {
      flagKeys?: string[];
      personProperties?: Record<string, string>;
    },
  ) => Promise<{ getFlag: (flagKey: string) => unknown }>;
};

export function getCloudSandboxFlagEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return (
    environment.VERCEL_ENV ??
    environment.TRIGGER_ENV ??
    environment.NODE_ENV ??
    "unknown"
  );
}

/**
 * Selects the request's preferred cloud provider. Explicit environment
 * configuration is useful for local/staging smoke tests; production leaves it
 * unset and uses stable PostHog distinct-id assignment.
 */
export async function selectCloudSandboxProvider(options: {
  userId: string;
  featureFlagClient?: FeatureFlagClient | null;
}): Promise<{
  provider: CloudSandboxProvider;
  reason: CloudSandboxSelectionReason;
}> {
  if (process.env.CLOUD_SANDBOX_PROVIDER) {
    return { provider: getCloudSandboxProvider(), reason: "configured" };
  }

  if (!process.env.MIOSA_API_KEY) {
    return {
      provider: "e2b",
      reason: "miosa_credentials_unavailable",
    };
  }

  try {
    const flags = await options.featureFlagClient?.evaluateFlags(
      options.userId,
      {
        flagKeys: [MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG],
        personProperties: {
          [MIOSA_CLOUD_SANDBOX_ENVIRONMENT_PROPERTY]:
            getCloudSandboxFlagEnvironment(),
        },
      },
    );
    const enabled = flags?.getFlag(MIOSA_CLOUD_SANDBOX_ROLLOUT_FLAG) === true;
    return enabled
      ? { provider: "miosa", reason: "miosa_rollout" }
      : { provider: "e2b", reason: "miosa_rollout_control" };
  } catch {
    return { provider: "e2b", reason: "miosa_rollout_control" };
  }
}
