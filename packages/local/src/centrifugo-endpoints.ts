import type { TransportEndpoint } from "centrifuge";

const WEBSOCKET_PATH_SUFFIX = "/connection/websocket";
const HTTP_STREAM_PATH_SUFFIX = "/connection/http_stream";

export interface CentrifugoTransportConfig {
  endpoints: TransportEndpoint[];
  emulationEndpoint: string;
}

/**
 * Prefer WebSocket, then fall back to Centrifugo's bidirectional HTTP stream
 * for networks and proxies that reject the WebSocket upgrade handshake.
 */
export function buildCentrifugoTransportConfig(
  websocketUrl: string,
): CentrifugoTransportConfig {
  const httpStreamUrl = new URL(websocketUrl);
  if (httpStreamUrl.protocol !== "ws:" && httpStreamUrl.protocol !== "wss:") {
    throw new Error("Centrifugo WebSocket URL must use ws:// or wss://");
  }
  if (!httpStreamUrl.pathname.endsWith(WEBSOCKET_PATH_SUFFIX)) {
    throw new Error(
      "Centrifugo WebSocket URL must end with /connection/websocket to derive fallback endpoints",
    );
  }

  const pathPrefix = httpStreamUrl.pathname.slice(
    0,
    -WEBSOCKET_PATH_SUFFIX.length,
  );
  httpStreamUrl.protocol =
    httpStreamUrl.protocol === "wss:" ? "https:" : "http:";
  httpStreamUrl.pathname = `${pathPrefix}${HTTP_STREAM_PATH_SUFFIX}`;
  httpStreamUrl.search = "";
  httpStreamUrl.hash = "";

  const emulationUrl = new URL(httpStreamUrl);
  emulationUrl.pathname = `${pathPrefix}/emulation`;

  return {
    endpoints: [
      { transport: "websocket", endpoint: websocketUrl },
      { transport: "http_stream", endpoint: httpStreamUrl.toString() },
    ],
    emulationEndpoint: emulationUrl.toString(),
  };
}
