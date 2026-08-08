import type {
  SandboxNetworkOpts,
  SandboxNetworkUpdate,
} from "@e2b/code-interpreter";
import type { AgentNetworkConfig } from "@/types";

export const DEFAULT_AGENT_NETWORK_CONFIG: AgentNetworkConfig = {
  outboundMode: "unrestricted",
  destinations: [],
  updatedAt: 0,
};

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
    create: egress,
    update: egress,
  };
}
