import type { TriggerRunRegion } from "@/lib/api/trigger-region";

export const E2B_EU_DOMAIN = "e2b-juliett.dev";

export type E2BCluster = "us" | "eu";

export type E2BConnectionOptions = {
  apiKey: string;
  domain: string;
};

export type E2BClusterConfig = {
  cluster: E2BCluster;
  template: string;
  connectionOptions?: E2BConnectionOptions;
};

const envValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const getUsClusterConfig = (): E2BClusterConfig => ({
  cluster: "us",
  template: envValue(process.env.E2B_TEMPLATE) ?? "terminal-agent-sandbox",
});

const getEuClusterConfig = (): E2BClusterConfig | null => {
  const apiKey = envValue(process.env.E2B_EU_API_KEY);
  if (!apiKey) return null;

  return {
    cluster: "eu",
    template:
      envValue(process.env.E2B_EU_TEMPLATE) ??
      envValue(process.env.E2B_TEMPLATE) ??
      "terminal-agent-sandbox",
    connectionOptions: {
      apiKey,
      domain: envValue(process.env.E2B_EU_DOMAIN) ?? E2B_EU_DOMAIN,
    },
  };
};

/**
 * US stays first so users keep their existing sandbox until it disappears or
 * is intentionally replaced. EU is an optional second cluster, enabled only
 * when its separate API key is present.
 */
export const getE2BClusterRouting = (
  triggerRegion?: TriggerRunRegion,
): {
  discoveryClusters: E2BClusterConfig[];
  createCluster: E2BClusterConfig;
} => {
  const us = getUsClusterConfig();
  const eu = getEuClusterConfig();

  return {
    discoveryClusters: eu ? [us, eu] : [us],
    createCluster: triggerRegion === "eu-central-1" && eu ? eu : us,
  };
};

export const getConfiguredE2BClustersForCleanup = (): E2BClusterConfig[] => {
  const clusters: E2BClusterConfig[] = [];
  if (envValue(process.env.E2B_API_KEY)) {
    clusters.push(getUsClusterConfig());
  }
  const eu = getEuClusterConfig();
  if (eu) clusters.push(eu);
  return clusters;
};
