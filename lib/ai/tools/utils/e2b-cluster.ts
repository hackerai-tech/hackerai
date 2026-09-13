import {
  EUROPE_TRIGGER_RUN_REGION,
  type TriggerRunRegion,
} from "@/lib/api/trigger-region";

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

export class E2BRegionUnavailableError extends Error {
  readonly code = "E2B_EU_REGION_UNAVAILABLE";

  constructor() {
    super("The European E2B sandbox region is not configured");
    this.name = "E2BRegionUnavailableError";
  }
}

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

/** Keep discovery and creation inside the region selected at request ingress. */
export const getE2BClusterRouting = (
  triggerRegion?: TriggerRunRegion,
): {
  discoveryClusters: E2BClusterConfig[];
  createCluster: E2BClusterConfig;
} => {
  const us = getUsClusterConfig();
  const eu = getEuClusterConfig();

  if (triggerRegion === EUROPE_TRIGGER_RUN_REGION) {
    if (!eu) throw new E2BRegionUnavailableError();

    return {
      discoveryClusters: [eu],
      createCluster: eu,
    };
  }

  return {
    discoveryClusters: [us],
    createCluster: us,
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
