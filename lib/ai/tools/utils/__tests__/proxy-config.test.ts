import { buildAgentProxyEnvironment } from "../proxy-config";

describe("buildAgentProxyEnvironment", () => {
  it("builds authenticated HTTP proxy variables for terminal and browser tools", () => {
    const env = buildAgentProxyEnvironment({
      protocol: "http",
      host: "proxy.example.com",
      port: 8443,
      username: "user@example.com",
      password: "p@ss/word",
      proxyDns: true,
      bypassHosts: ["api.internal.example"],
      updatedAt: 1234,
    });

    expect(env).toMatchObject({
      HTTP_PROXY:
        "http://user%40example.com:p%40ss%2Fword@proxy.example.com:8443",
      HTTPS_PROXY:
        "http://user%40example.com:p%40ss%2Fword@proxy.example.com:8443",
      http_proxy:
        "http://user%40example.com:p%40ss%2Fword@proxy.example.com:8443",
      https_proxy:
        "http://user%40example.com:p%40ss%2Fword@proxy.example.com:8443",
      AGENT_BROWSER_PROXY: "http://proxy.example.com:8443",
      AGENT_BROWSER_PROXY_USERNAME: "user@example.com",
      AGENT_BROWSER_PROXY_PASSWORD: "p@ss/word",
      AGENT_BROWSER_SESSION: "proxy-1234",
    });
    expect(env?.NO_PROXY).toBe("localhost,127.0.0.1,::1,api.internal.example");
  });

  it("uses remote DNS for SOCKS5 and formats IPv6 proxy hosts", () => {
    const env = buildAgentProxyEnvironment({
      protocol: "socks5",
      host: "2001:db8::1",
      port: 1080,
      proxyDns: true,
      bypassHosts: [],
      updatedAt: 5678,
    });

    expect(env).toMatchObject({
      ALL_PROXY: "socks5h://[2001:db8::1]:1080",
      all_proxy: "socks5h://[2001:db8::1]:1080",
      AGENT_BROWSER_PROXY: "socks5://[2001:db8::1]:1080",
    });
    expect(env).not.toHaveProperty("HTTP_PROXY");
  });

  it("returns no environment when proxying is disabled", () => {
    expect(buildAgentProxyEnvironment(null)).toBeUndefined();
  });
});
