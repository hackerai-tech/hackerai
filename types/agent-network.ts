export type AgentNetworkOutboundMode =
  "unrestricted" | "allow_only" | "block_list";

export interface AgentNetworkConfig {
  outboundMode: AgentNetworkOutboundMode;
  destinations: string[];
  updatedAt: number;
}
