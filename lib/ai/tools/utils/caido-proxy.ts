export const CAIDO_DEFAULTS = {
  host: "127.0.0.1",
  port: 48080,
} as const;

export function buildCaidoProxyEnvVars(
  config: typeof CAIDO_DEFAULTS = CAIDO_DEFAULTS,
): Record<string, string> {
  const proxyUrl = `http://${config.host}:${config.port}`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    // Disable TLS verification so tools don't reject Caido's self-signed CA
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    PYTHONHTTPSVERIFY: "0",
    REQUESTS_CA_BUNDLE: "",
  };
}
