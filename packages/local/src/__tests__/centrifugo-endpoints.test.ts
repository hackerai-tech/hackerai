import { buildCentrifugoTransportConfig } from "../centrifugo-endpoints";

describe("buildCentrifugoTransportConfig", () => {
  it("adds a secure HTTP stream fallback for a secure WebSocket endpoint", () => {
    expect(
      buildCentrifugoTransportConfig(
        "wss://relay.example.test/connection/websocket",
      ),
    ).toEqual({
      endpoints: [
        {
          transport: "websocket",
          endpoint: "wss://relay.example.test/connection/websocket",
        },
        {
          transport: "http_stream",
          endpoint: "https://relay.example.test/connection/http_stream",
        },
      ],
      emulationEndpoint: "https://relay.example.test/emulation",
    });
  });

  it("preserves a path prefix when deriving the HTTP stream endpoint", () => {
    expect(
      buildCentrifugoTransportConfig(
        "ws://localhost:8000/relay/connection/websocket",
      ),
    ).toEqual({
      endpoints: [
        {
          transport: "websocket",
          endpoint: "ws://localhost:8000/relay/connection/websocket",
        },
        {
          transport: "http_stream",
          endpoint: "http://localhost:8000/relay/connection/http_stream",
        },
      ],
      emulationEndpoint: "http://localhost:8000/relay/emulation",
    });
  });

  it("rejects an endpoint that cannot safely derive the fallback", () => {
    expect(() =>
      buildCentrifugoTransportConfig("https://relay.example.test/socket"),
    ).toThrow("must use ws:// or wss://");
    expect(() =>
      buildCentrifugoTransportConfig("wss://relay.example.test/socket"),
    ).toThrow("must end with /connection/websocket");
  });
});
