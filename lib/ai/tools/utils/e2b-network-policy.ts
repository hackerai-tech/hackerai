import type {
  SandboxNetworkOpts,
  SandboxNetworkUpdate,
} from "@e2b/code-interpreter";
import type { AgentNetworkConfig, AgentNetworkInboundMode } from "@/types";

export const DEFAULT_AGENT_NETWORK_CONFIG: AgentNetworkConfig = {
  inboundMode: "public",
  outboundMode: "unrestricted",
  destinations: [],
  updatedAt: 0,
};

export const E2B_INBOUND_MODE_METADATA_KEY = "networkInboundMode";

function composeEgressPolicy(config: AgentNetworkConfig): SandboxNetworkUpdate {
  switch (config.outboundMode) {
    case "allow_only":
      return {
        allowOut: config.destinations,
        denyOut: ({ allTraffic }) => [allTraffic],
      };
    case "block_list":
      return { denyOut: config.destinations };
    case "unrestricted":
      // updateNetwork replaces the complete egress policy. An empty object is
      // intentional here: it clears rules left by an earlier configuration.
      return {};
  }
}

export function composeE2BNetworkPolicy(config: AgentNetworkConfig): {
  create: SandboxNetworkOpts;
  update: SandboxNetworkUpdate;
} {
  const egress = composeEgressPolicy(config);
  return {
    create: {
      allowPublicTraffic: config.inboundMode === "public",
      ...egress,
    },
    update: egress,
  };
}

export function getExistingE2BInboundMode(
  metadata: Record<string, string> | undefined,
): AgentNetworkInboundMode {
  // Sandboxes created before this feature used E2B's public-traffic default.
  return metadata?.[E2B_INBOUND_MODE_METADATA_KEY] === "token_required"
    ? "token_required"
    : "public";
}
