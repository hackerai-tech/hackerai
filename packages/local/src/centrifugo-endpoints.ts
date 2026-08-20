import type { TransportEndpoint } from "centrifuge";

const WEBSOCKET_PATH_SUFFIX = "/websocket";
const HTTP_STREAM_PATH_SUFFIX = "/http_stream";

/**
 * Prefer WebSocket, then fall back to Centrifugo's bidirectional HTTP stream
 * for networks and proxies that reject the WebSocket upgrade handshake.
 */
export function buildCentrifugoTransportEndpoints(
  websocketUrl: string,
): TransportEndpoint[] {
  const httpStreamUrl = new URL(websocketUrl);
  if (httpStreamUrl.protocol !== "ws:" && httpStreamUrl.protocol !== "wss:") {
    throw new Error("Centrifugo WebSocket URL must use ws:// or wss://");
  }
  if (!httpStreamUrl.pathname.endsWith(WEBSOCKET_PATH_SUFFIX)) {
    throw new Error(
      "Centrifugo WebSocket URL must end with /websocket to derive the HTTP stream endpoint",
    );
  }

  httpStreamUrl.protocol =
    httpStreamUrl.protocol === "wss:" ? "https:" : "http:";
  httpStreamUrl.pathname = `${httpStreamUrl.pathname.slice(0, -WEBSOCKET_PATH_SUFFIX.length)}${HTTP_STREAM_PATH_SUFFIX}`;
  httpStreamUrl.search = "";
  httpStreamUrl.hash = "";

  return [
    { transport: "websocket", endpoint: websocketUrl },
    { transport: "http_stream", endpoint: httpStreamUrl.toString() },
  ];
}
