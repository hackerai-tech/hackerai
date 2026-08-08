export type AgentNetworkInboundMode = "public" | "token_required";

export type AgentNetworkOutboundMode =
  "unrestricted" | "allow_only" | "block_list";

export interface AgentNetworkConfig {
  inboundMode: AgentNetworkInboundMode;
  outboundMode: AgentNetworkOutboundMode;
  destinations: string[];
  updatedAt: number;
}
