import { withConnectTimeout } from "../websocket-connect-timeout";

// Jest maps `convex/browser` to a mock; the retry contract needs the real client.
const { BaseConvexClient } = jest.requireActual<
  typeof import("convex/browser")
>("../../../node_modules/convex/dist/cjs/browser/index.js");

/** A socket whose handshake stays pending until the test opens or closes it. */
class PendingSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: PendingSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: Event) => void) | null = null;

  constructor(readonly url: string | URL) {
    super();
    PendingSocket.instances.push(this);
  }

  send() {}

  open() {
    this.readyState = this.OPEN;
    const event = new Event("open");
    this.dispatchEvent(event);
    this.onopen?.(event);
  }

  close() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    // What a browser reports when a pending handshake is cancelled.
    const event = Object.assign(new Event("close"), { code: 1006, reason: "" });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}

const TIMEOUT_MS = 10_000;
const TimedSocket = withConnectTimeout(
  PendingSocket as unknown as typeof WebSocket,
  TIMEOUT_MS,
);

describe("withConnectTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    PendingSocket.instances = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("makes Convex retry a hung handshake instead of waiting behind it", async () => {
    const client = new BaseConvexClient(
      "https://example.convex.cloud",
      () => {},
      { webSocketConstructor: TimedSocket, logger: false },
    );

    try {
      jest.advanceTimersByTime(TIMEOUT_MS - 1);
      expect(PendingSocket.instances).toHaveLength(1);
      expect(PendingSocket.instances[0].readyState).toBe(
        PendingSocket.CONNECTING,
      );

      jest.advanceTimersByTime(1);
      expect(PendingSocket.instances[0].readyState).toBe(PendingSocket.CLOSED);

      // Convex's first reconnect backoff is at most 1.5 seconds.
      jest.advanceTimersByTime(1_500);
      expect(PendingSocket.instances).toHaveLength(2);
    } finally {
      // Convex waits for the pending socket's close event before resolving.
      const closed = client.close();
      PendingSocket.instances.forEach((socket) => socket.close());
      await closed;
    }
  });

  it("leaves a socket that connected in time open", () => {
    const socket = new TimedSocket(
      "wss://example.test",
    ) as unknown as PendingSocket;

    jest.advanceTimersByTime(2_000);
    socket.open();
    jest.advanceTimersByTime(TIMEOUT_MS * 2);

    expect(socket.readyState).toBe(PendingSocket.OPEN);
  });
});
