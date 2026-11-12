import { EventEmitter } from "events";
import { watchLocalRunConnection } from "../watch-local-run-connection";
import { getLocalStopDiagnostic } from "@/lib/chat/local-connection-stop";

const mockSubscription = Object.assign(new EventEmitter(), {
  presence: jest.fn(),
  subscribe: jest.fn(),
});
const mockClient = Object.assign(new EventEmitter(), {
  state: "connected",
  connect: jest.fn(),
  disconnect: jest.fn(),
  newSubscription: jest.fn(() => mockSubscription),
});
jest.mock("centrifuge", () => ({ Centrifuge: jest.fn(() => mockClient) }));
jest.mock("../jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("token"),
}));

const SELECTED = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const online = {
  clients: { desktop: { connInfo: { connectionId: SELECTED } } },
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// The runtime's WebSocket class; only its public EventTarget surface is used.
class NativeSocket extends EventTarget {
  static created: NativeSocket[] = [];
  readonly args: unknown[];
  constructor(...args: unknown[]) {
    super();
    this.args = args;
    NativeSocket.created.push(this);
  }
}
const closeEvent = (code: unknown, wasClean: unknown) =>
  Object.assign(new Event("close"), { code, wasClean, reason: "PRIVATE" });

// Constructs a socket as the SDK does: a supplied constructor, else the global.
function sdkSocket(...args: unknown[]) {
  const { Centrifuge } = jest.requireMock("centrifuge");
  const options = Centrifuge.mock.calls.at(-1)[1];
  const Socket = options.websocket ?? globalThis.WebSocket;
  return new Socket(...args) as NativeSocket;
}

const originalWebSocket = Object.getOwnPropertyDescriptor(
  globalThis,
  "WebSocket",
)!;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSubscription.removeAllListeners();
  mockClient.removeAllListeners();
  mockClient.state = "connected";
  mockClient.disconnect.mockImplementation(() => {
    mockClient.state = "disconnected";
  });
  mockSubscription.presence.mockResolvedValue(online);
  process.env.CENTRIFUGO_WS_URL = "ws://localhost";
  NativeSocket.created = [];
  globalThis.WebSocket = NativeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.CENTRIFUGO_WS_URL;
  Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
});

function watch() {
  const onLost = jest.fn();
  const stop = watchLocalRunConnection({
    userId: "u",
    connectionId: SELECTED,
    onLost,
  });
  const cause = () => {
    expect(onLost).toHaveBeenCalledTimes(1);
    return getLocalStopDiagnostic(onLost.mock.calls[0][0]);
  };
  return { onLost, stop, cause };
}

async function start() {
  const watcher = watch();
  await flush();
  // The SDK opens its socket before the subscription completes.
  const socket = sdkSocket("ws://localhost");
  mockSubscription.emit("subscribed");
  await flush();
  return { ...watcher, socket };
}

test("stops once on the selected desktop leaving, never on another subscriber", async () => {
  const { onLost, cause } = await start();
  await jest.advanceTimersByTimeAsync(1_200);
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: "other" } },
  });
  expect(onLost).not.toHaveBeenCalled();
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: SELECTED } },
  });
  expect(cause()).toEqual({
    reason: "selected_host_left",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 1_200,
  });
  mockSubscription.emit("subscribed");
  await jest.advanceTimersByTimeAsync(30_000);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
});

test("detects a crash without a leave event and rejects a replacement session", async () => {
  const { cause } = await start();
  mockSubscription.presence.mockResolvedValue({
    clients: { replacement: { connInfo: { connectionId: "replacement" } } },
  });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(cause()).toMatchObject({
    reason: "selected_presence_absent",
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 5_000,
  });
});

test("stops a thinking run even when no commands are being executed", async () => {
  const { cause } = await start();
  mockSubscription.presence.mockResolvedValue({ clients: {} });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(cause()?.reason).toBe("selected_presence_absent");
});

// Observer failures still stop immediately, but must not look like host loss.
const PRIVATE_CONTEXT = { reason: "PRIVATE", channel: "PRIVATE" };
test.each([
  [
    "observer_reconnecting",
    "connecting",
    () => mockClient.emit("connecting", { code: 3012, ...PRIVATE_CONTEXT }),
    { callbackCode: 3012, clientState: "connecting" },
  ],
  [
    "observer_disconnected",
    "disconnected",
    () => mockClient.emit("disconnected", { code: 3501, ...PRIVATE_CONTEXT }),
    { callbackCode: 3501, clientState: "disconnected" },
  ],
  [
    "subscription_reconnecting",
    "connected",
    () =>
      mockSubscription.emit("subscribing", { code: 2500, ...PRIVATE_CONTEXT }),
    { callbackCode: 2500, clientState: "connected" },
  ],
  [
    "subscription_unsubscribed",
    "connected",
    () =>
      mockSubscription.emit("unsubscribed", { code: 2000, ...PRIVATE_CONTEXT }),
    { callbackCode: 2000, clientState: "connected" },
  ],
  // A distinct question: its nested error code is not this callback code.
  [
    "subscription_error",
    "connected",
    () =>
      mockSubscription.emit("error", {
        code: 1,
        error: { code: 100, message: "PRIVATE" },
        ...PRIVATE_CONTEXT,
      }),
    {},
  ],
])(
  "stops on %s after positive host presence with that observer cause",
  async (reason, clientState, emit, callback) => {
    const { cause } = await start();
    mockClient.state = clientState;
    emit();
    expect(cause()).toEqual({
      reason,
      connectionId: SELECTED,
      hadPositivePresence: true,
      lastPositivePresenceAgeMs: 0,
      ...callback,
    });
    expect(JSON.stringify(cause())).not.toContain("PRIVATE");
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  },
);

test.each([
  [
    "a getter",
    () =>
      Object.defineProperty({ ...PRIVATE_CONTEXT }, "code", {
        enumerable: true,
        get: () => {
          throw new Error("PRIVATE getter");
        },
      }),
  ],
  [
    "a throwing proxy",
    () =>
      new Proxy(PRIVATE_CONTEXT, {
        getOwnPropertyDescriptor: () => {
          throw new Error("PRIVATE trap");
        },
      }),
  ],
  ["a string", () => ({ code: "2500", ...PRIVATE_CONTEXT })],
])(
  "omits an unreadable callback code from %s without changing the stop",
  async (_name, context) => {
    const { onLost, cause } = await start();
    mockSubscription.emit("subscribing", context());
    expect(cause()).toEqual({
      reason: "subscription_reconnecting",
      connectionId: SELECTED,
      hadPositivePresence: true,
      lastPositivePresenceAgeMs: 0,
      clientState: "connected",
    });
    expect(JSON.stringify(cause())).not.toContain("PRIVATE");
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(onLost).toHaveBeenCalledTimes(1);
  },
);

test("a hostile client state read cannot block, replace or revive the first stop", async () => {
  const { Centrifuge } = jest.requireMock("centrifuge");
  let armed = false;
  let stopWatcher = () => {};
  const trap = jest.fn((target: object, key: string | symbol) => {
    if (!armed || key !== "state")
      return Reflect.getOwnPropertyDescriptor(target, key);
    // Re-enter the watcher and the SDK before failing.
    stopWatcher();
    mockClient.emit("disconnected", { code: 3501 });
    throw new Error("PRIVATE trap");
  });
  Centrifuge.mockImplementationOnce(
    () => new Proxy(mockClient, { getOwnPropertyDescriptor: trap }),
  );
  const { onLost, stop, cause } = watch();
  stopWatcher = stop;
  await flush();
  mockSubscription.emit("subscribed");
  await flush();
  const polls = mockSubscription.presence.mock.calls.length;
  armed = true;
  mockSubscription.emit("subscribing", { code: 1 });
  expect(trap).toHaveBeenCalled();
  expect(cause()).toEqual({
    reason: "subscription_reconnecting",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 0,
    callbackCode: 1,
  });
  expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(mockSubscription.presence).toHaveBeenCalledTimes(polls);
  expect(jest.getTimerCount()).toBe(0);
});

test("distinguishes a rejected later presence read from host absence", async () => {
  const { cause } = await start();
  mockSubscription.presence.mockRejectedValue(new Error("PRIVATE"));
  await jest.advanceTimersByTimeAsync(5_000);
  expect(cause()).toMatchObject({
    reason: "presence_error",
    hadPositivePresence: true,
  });
});

test.each([
  ["first", false],
  ["later", true],
])("bounds a hung %s presence check", async (_check, hadPositive) => {
  if (!hadPositive)
    mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
  const { onLost, cause } = await start();
  if (hadPositive) {
    mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
    await jest.advanceTimersByTimeAsync(5_000);
  }
  await jest.advanceTimersByTimeAsync(9_999);
  expect(onLost).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(cause()).toMatchObject({
    reason: "presence_timeout",
    hadPositivePresence: hadPositive,
  });
});

test("distinguishes setup deadline, setup failure and an initial disconnect", async () => {
  const silent = watch();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(silent.cause()).toEqual({
    reason: "setup_timeout",
    connectionId: SELECTED,
    hadPositivePresence: false,
  });

  delete process.env.CENTRIFUGO_WS_URL;
  const misconfigured = watch();
  await flush();
  expect(misconfigured.cause()?.reason).toBe("setup_error");

  process.env.CENTRIFUGO_WS_URL = "ws://localhost";
  mockSubscription.removeAllListeners();
  mockClient.removeAllListeners();
  const disconnected = watch();
  await flush();
  mockClient.emit("disconnected", {});
  expect(disconnected.cause()).toMatchObject({
    reason: "observer_disconnected",
    hadPositivePresence: false,
  });
  expect(jest.getTimerCount()).toBe(0);
});

test("keeps the first cause when later events and deadlines follow", async () => {
  const { cause } = await start();
  mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
  mockClient.emit("connecting");
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: SELECTED } },
  });
  mockSubscription.emit("unsubscribed");
  await jest.advanceTimersByTimeAsync(30_000);
  expect(cause()?.reason).toBe("observer_reconnecting");
});

test.each([
  [
    "throws",
    () => {
      throw new Error("clock unavailable");
    },
  ],
  ["is non-finite", () => NaN],
])(
  "keeps monitoring when the optional clock %s, then reports genuine loss once",
  async (_fault, clock) => {
    const now = jest.spyOn(performance, "now").mockImplementation(clock);
    try {
      const { onLost, cause } = await start();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(onLost).not.toHaveBeenCalled();
      expect(mockSubscription.presence).toHaveBeenCalledTimes(4);
      mockSubscription.emit("leave", {
        info: { connInfo: { connectionId: SELECTED } },
      });
      expect(cause()).toEqual({
        reason: "selected_host_left",
        connectionId: SELECTED,
        hadPositivePresence: true,
      });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      now.mockRestore();
    }
  },
);

test("omits a stale age when the clock fails after an earlier positive read", async () => {
  const { cause } = await start();
  const now = jest.spyOn(performance, "now").mockImplementation(() => {
    throw new Error("clock unavailable");
  });
  try {
    await jest.advanceTimersByTimeAsync(5_000);
    now.mockRestore();
    mockClient.state = "connecting";
    mockClient.emit("connecting", { code: 1 });
    expect(cause()).toEqual({
      reason: "observer_reconnecting",
      connectionId: SELECTED,
      hadPositivePresence: true,
      callbackCode: 1,
      clientState: "connecting",
    });
  } finally {
    now.mockRestore();
  }
});

test("normal completion disposes monitoring without marking the run interrupted", async () => {
  const { onLost, stop, socket } = await start();
  const removed = jest.spyOn(socket, "removeEventListener");
  stop();
  // Its own close listener is gone before stop returns, not on a later tick.
  expect(removed).toHaveBeenCalledWith("close", expect.any(Function));
  socket.dispatchEvent(closeEvent(1005, true));
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: SELECTED } },
  });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(onLost).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

describe("native socket close observed before the first stop", () => {
  const observerCause = {
    reason: "observer_reconnecting",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 0,
    callbackCode: 1,
    clientState: "connecting",
  };
  // The SDK's own reaction to a transport close.
  const sdkReconnects = () => {
    mockClient.state = "connecting";
    mockClient.emit("connecting", { code: 1, ...PRIVATE_CONTEXT });
  };

  test("adds the close pair to the first callback stop without changing it", async () => {
    const { onLost, socket, cause } = await start();
    const event = closeEvent(1006, false);
    const reason = jest.fn(() => "PRIVATE");
    Object.defineProperty(event, "reason", { get: reason });
    socket.dispatchEvent(event);
    expect(onLost).not.toHaveBeenCalled();
    sdkReconnects();
    expect(cause()).toEqual({
      ...observerCause,
      socketCloseCode: 1006,
      socketCloseWasClean: false,
    });
    expect(reason).not.toHaveBeenCalled();
    expect(JSON.stringify(cause())).not.toContain("PRIVATE");
    // Later SDK events neither replace the first cause nor its pair.
    mockClient.emit("disconnected", { code: 3501 });
    mockSubscription.emit("unsubscribed", { code: 2000 });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  });

  test("forwards the exact constructor arguments once and returns the native socket", async () => {
    watch();
    await flush();
    const json = sdkSocket("ws://localhost");
    const protobuf = sdkSocket("ws://localhost", "centrifuge-protobuf");
    expect(NativeSocket.created).toEqual([json, protobuf]);
    expect(json.args).toEqual(["ws://localhost"]);
    expect(protobuf.args).toEqual(["ws://localhost", "centrifuge-protobuf"]);
    expect(Object.getPrototypeOf(protobuf)).toBe(NativeSocket.prototype);
  });

  test("propagates a constructor failure unchanged, once, without a stop", async () => {
    const failure = new Error("PRIVATE construction failure");
    const construct = jest.fn(() => {
      throw failure;
    });
    globalThis.WebSocket = function () {
      construct();
    } as unknown as typeof WebSocket;
    const { onLost } = watch();
    await flush();
    let thrown: unknown;
    try {
      sdkSocket("ws://localhost");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });

  test.each([
    ["the client's own disconnect", 1005, true],
    ["a later transport failure", 1006, false],
  ])(
    "omits %s delivered after a host-left stop",
    async (_name, code, clean) => {
      const { socket, cause } = await start();
      mockSubscription.emit("leave", {
        info: { connInfo: { connectionId: SELECTED } },
      });
      socket.dispatchEvent(closeEvent(code, clean));
      expect(cause()).toEqual({
        reason: "selected_host_left",
        connectionId: SELECTED,
        hadPositivePresence: true,
        lastPositivePresenceAgeMs: 0,
      });
    },
  );

  test("never attaches a pre-stop close to a cause without an observer callback", async () => {
    const { socket, cause } = await start();
    socket.dispatchEvent(closeEvent(1006, false));
    mockSubscription.emit("leave", {
      info: { connInfo: { connectionId: SELECTED } },
    });
    expect(cause()).toEqual({
      reason: "selected_host_left",
      connectionId: SELECTED,
      hadPositivePresence: true,
      lastPositivePresenceAgeMs: 0,
    });
  });

  test("ignores a close during initial setup, before the first subscription", async () => {
    const { cause } = watch();
    await flush();
    const socket = sdkSocket("ws://localhost");
    socket.dispatchEvent(closeEvent(1006, false));
    mockSubscription.emit("subscribed");
    await flush();
    sdkReconnects();
    expect(cause()).toEqual(observerCause);
  });

  const failRemoval = (socket: NativeSocket) =>
    jest.spyOn(socket, "removeEventListener").mockImplementation(() => {
      throw new Error("PRIVATE removal");
    });
  test.each([
    ["closing after a new construction", () => {}, false],
    ["whose detach fails, closing after it", failRemoval, false],
    ["closed before a new construction", () => {}, true],
  ])(
    "never attributes the subscribed socket %s to the stop",
    async (_name, breakRemoval, closesFirst) => {
      const { socket: earlier, cause } = await start();
      breakRemoval(earlier);
      if (closesFirst) earlier.dispatchEvent(closeEvent(4000, true));
      const current = sdkSocket("ws://localhost");
      if (!closesFirst) earlier.dispatchEvent(closeEvent(4000, true));
      sdkReconnects();
      expect(cause()).toEqual(observerCause);
      expect(NativeSocket.created).toEqual([earlier, current]);
    },
  );

  test("keeps the current attempt's pair after an earlier attempt", async () => {
    const { cause } = watch();
    await flush();
    sdkSocket("ws://localhost");
    const current = sdkSocket("ws://localhost");
    mockSubscription.emit("subscribed");
    await flush();
    current.dispatchEvent(closeEvent(1000, true));
    sdkReconnects();
    expect(cause()).toEqual({
      ...observerCause,
      socketCloseCode: 1000,
      socketCloseWasClean: true,
    });
  });

  test.each([
    ["below 1000", 999, false],
    ["above 4999", 5_000, true],
    ["fractional", 1_006.5, false],
    ["string", "1006", false],
    ["non-boolean wasClean", 1_006, "false"],
    ["missing wasClean", 1_006, undefined],
  ])("omits a %s close pair", async (_name, code, wasClean) => {
    const { socket, cause } = await start();
    socket.dispatchEvent(closeEvent(code, wasClean));
    sdkReconnects();
    expect(cause()).toEqual(observerCause);
  });

  // Each optional observation fault keeps the original stop and SDK behavior.
  test.each([
    [
      "no global WebSocket",
      () => {
        globalThis.WebSocket = undefined as unknown as typeof WebSocket;
      },
    ],
    [
      "an unreadable global WebSocket",
      () =>
        Object.defineProperty(globalThis, "WebSocket", {
          configurable: true,
          get: () => {
            throw new Error("PRIVATE global");
          },
        }),
    ],
  ])("keeps the SDK's default socket with %s", async (_name, breakGlobal) => {
    breakGlobal();
    const { Centrifuge } = jest.requireMock("centrifuge");
    const { onLost, cause } = watch();
    await flush();
    expect(Centrifuge).toHaveBeenCalledTimes(1);
    expect(Centrifuge.mock.calls[0][1]).not.toHaveProperty("websocket");
    mockSubscription.emit("subscribed");
    await flush();
    expect(onLost).not.toHaveBeenCalled();
    sdkReconnects();
    expect(cause()).toEqual(observerCause);
  });

  const throwing = () => {
    throw new Error("PRIVATE fault");
  };
  test.each([
    [
      "has no EventTarget API",
      (socket: NativeSocket) =>
        Object.defineProperty(socket, "addEventListener", { value: undefined }),
    ],
    [
      "rejects the listener",
      (socket: NativeSocket) =>
        Object.defineProperty(socket, "addEventListener", { value: throwing }),
    ],
    [
      "fails to detach it on stop",
      (socket: NativeSocket) =>
        Object.defineProperty(socket, "removeEventListener", {
          value: throwing,
        }),
    ],
  ])(
    "keeps the stop unchanged when the native socket %s",
    async (_name, breakSocket) => {
      class FaultySocket extends NativeSocket {
        constructor(...args: unknown[]) {
          super(...args);
          breakSocket(this);
        }
      }
      globalThis.WebSocket = FaultySocket as unknown as typeof WebSocket;
      const { onLost, cause } = watch();
      await flush();
      const socket = sdkSocket("ws://localhost");
      expect(socket).toBeInstanceOf(FaultySocket);
      mockSubscription.emit("subscribed");
      await flush();
      sdkReconnects();
      expect(cause()).toEqual(observerCause);
      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
      socket.dispatchEvent(closeEvent(1006, false));
      await jest.advanceTimersByTimeAsync(30_000);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test("omits a pair whose native getters fail", async () => {
    const { socket, cause } = await start();
    const event = new Event("close");
    Object.defineProperty(event, "code", { get: throwing });
    socket.dispatchEvent(event);
    sdkReconnects();
    expect(cause()).toEqual(observerCause);
  });
});
