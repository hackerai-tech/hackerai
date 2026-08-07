import type { AgentProxyRuntimeConfig } from "@/types";

const DEFAULT_PROXY_BYPASS_HOSTS = ["localhost", "127.0.0.1", "::1"];

function formatProxyHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildAuthenticatedProxyUrl(
  config: AgentProxyRuntimeConfig,
  scheme: string,
): string {
  const credentials = config.username
    ? `${encodeURIComponent(config.username)}${
        config.password !== undefined
          ? `:${encodeURIComponent(config.password)}`
          : ""
      }@`
    : "";

  return `${scheme}://${credentials}${formatProxyHost(config.host)}:${config.port}`;
}

export function buildAgentProxyEnvironment(
  config: AgentProxyRuntimeConfig | null | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!config) return undefined;

  const bypassHosts = Array.from(
    new Set([...DEFAULT_PROXY_BYPASS_HOSTS, ...config.bypassHosts]),
  ).join(",");
  const agentBrowserProxy = `${config.protocol}://${formatProxyHost(config.host)}:${config.port}`;
  const shared = {
    // agent-browser daemons inherit environment only when they start. A stable
    // config-specific session keeps browser state while ensuring an updated
    // proxy starts a fresh daemon with the new environment.
    AGENT_BROWSER_SESSION: `proxy-${config.updatedAt}`,
    AGENT_BROWSER_PROXY: agentBrowserProxy,
    AGENT_BROWSER_PROXY_BYPASS: bypassHosts,
    NO_PROXY: bypassHosts,
    no_proxy: bypassHosts,
    ...(config.username
      ? { AGENT_BROWSER_PROXY_USERNAME: config.username }
      : {}),
    ...(config.password !== undefined
      ? { AGENT_BROWSER_PROXY_PASSWORD: config.password }
      : {}),
  };

  if (config.protocol === "http") {
    const proxyUrl = buildAuthenticatedProxyUrl(config, "http");
    return {
      ...shared,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
    };
  }

  const proxyUrl = buildAuthenticatedProxyUrl(
    config,
    config.proxyDns ? "socks5h" : "socks5",
  );
  return {
    ...shared,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
  };
}
