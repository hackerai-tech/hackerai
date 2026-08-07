export type AgentProxyProtocol = "http" | "socks5";

export type AgentProxyRuntimeConfig = {
  protocol: AgentProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxyDns: boolean;
  bypassHosts: string[];
  updatedAt: number;
};

export type AgentProxyPublicConfig = Omit<
  AgentProxyRuntimeConfig,
  "password"
> & {
  enabled: boolean;
  hasPassword: boolean;
};
