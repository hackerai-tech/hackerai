import { buildCentrifugoTransportEndpoints } from "../centrifugo-endpoints";

describe("buildCentrifugoTransportEndpoints", () => {
  it("adds a secure HTTP stream fallback for a secure WebSocket endpoint", () => {
    expect(
      buildCentrifugoTransportEndpoints(
        "wss://relay.example.test/connection/websocket",
      ),
    ).toEqual([
      {
        transport: "websocket",
        endpoint: "wss://relay.example.test/connection/websocket",
      },
      {
        transport: "http_stream",
        endpoint: "https://relay.example.test/connection/http_stream",
      },
    ]);
  });

  it("preserves a path prefix when deriving the HTTP stream endpoint", () => {
    expect(
      buildCentrifugoTransportEndpoints(
        "ws://localhost:8000/relay/connection/websocket",
      )[1],
    ).toEqual({
      transport: "http_stream",
      endpoint: "http://localhost:8000/relay/connection/http_stream",
    });
  });

  it("rejects an endpoint that cannot safely derive the fallback", () => {
    expect(() =>
      buildCentrifugoTransportEndpoints("https://relay.example.test/socket"),
    ).toThrow("must use ws:// or wss://");
    expect(() =>
      buildCentrifugoTransportEndpoints("wss://relay.example.test/socket"),
    ).toThrow("must end with /websocket");
  });
});
