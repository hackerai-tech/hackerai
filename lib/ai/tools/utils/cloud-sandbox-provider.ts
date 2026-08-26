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

export function normalizeCloudSandboxFlagEnvironment(
  environment: string,
): string {
  return environment.trim().toLowerCase();
}

/**
 * Selects the request's preferred cloud provider. Callers supply their
 * execution environment explicitly so durable workers do not infer deployment
 * context from NODE_ENV.
 */
export async function selectCloudSandboxProvider(options: {
  userId: string;
  environment: string;
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
            normalizeCloudSandboxFlagEnvironment(options.environment),
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
