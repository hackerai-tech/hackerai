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

// Terminal observer failures still stop at once, but must not look like host loss.
const PRIVATE_CONTEXT = { reason: "PRIVATE", channel: "PRIVATE" };
test.each([
  [
    "observer_disconnected",
    "disconnected",
    () => mockClient.emit("disconnected", { code: 3501, ...PRIVATE_CONTEXT }),
    { callbackCode: 3501, clientState: "disconnected" },
  ],
  [
    "subscription_unsubscribed",
    "connected",
    () =>
      mockSubscription.emit("unsubscribed", { code: 2000, ...PRIVATE_CONTEXT }),
    { callbackCode: 2000, clientState: "connected" },
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
    mockSubscription.emit("unsubscribed", context());
    expect(cause()).toEqual({
      reason: "subscription_unsubscribed",
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
  mockSubscription.emit("unsubscribed", { code: 1 });
  expect(trap).toHaveBeenCalled();
  expect(cause()).toEqual({
    reason: "subscription_unsubscribed",
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

test("distinguishes a rejected first presence read from host absence", async () => {
  mockSubscription.presence.mockRejectedValue(new Error("PRIVATE"));
  const { cause } = await start();
  expect(cause()).toEqual({
    reason: "presence_error",
    connectionId: SELECTED,
    hadPositivePresence: false,
  });
});

test("bounds a hung first presence check", async () => {
  mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
  const { onLost, cause } = await start();
  await jest.advanceTimersByTimeAsync(9_999);
  expect(onLost).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(cause()).toMatchObject({
    reason: "presence_timeout",
    hadPositivePresence: false,
  });
});

// After verification a failed or hung read opens the recovery window instead.
test.each([
  ["rejected", () => Promise.reject(new Error("PRIVATE")), 5_000],
  ["hung", () => new Promise(() => {}), 15_000],
])(
  "a %s later presence read expires the window unless a read confirms the host",
  async (_kind, read, interruptedAt) => {
    const { onLost, cause } = await start();
    mockSubscription.presence.mockImplementation(read);
    await jest.advanceTimersByTimeAsync(interruptedAt + 14_999);
    expect(onLost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(cause()).toEqual({
      reason: "observer_recovery_expired",
      connectionId: SELECTED,
      hadPositivePresence: true,
      lastPositivePresenceAgeMs: interruptedAt + 15_000,
      clientState: "connected",
    });
    expect(jest.getTimerCount()).toBe(0);
  },
);

test("a later read confirming the host ends a presence-read interruption", async () => {
  const { onLost } = await start();
  mockSubscription.presence.mockRejectedValueOnce(new Error("PRIVATE"));
  await jest.advanceTimersByTimeAsync(5_000);
  // The next read, at the normal cadence, confirms the host.
  await jest.advanceTimersByTimeAsync(5_000);
  expect(mockSubscription.presence).toHaveBeenCalledTimes(3);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(onLost).not.toHaveBeenCalled();
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
  // A recoverable interruption is not a cause; the departure during it is.
  mockClient.emit("connecting");
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: SELECTED } },
  });
  mockSubscription.emit("unsubscribed");
  await jest.advanceTimersByTimeAsync(30_000);
  expect(cause()?.reason).toBe("selected_host_left");
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
    mockClient.state = "disconnected";
    mockClient.emit("disconnected", { code: 1 });
    expect(cause()).toEqual({
      reason: "observer_disconnected",
      connectionId: SELECTED,
      hadPositivePresence: true,
      callbackCode: 1,
      clientState: "disconnected",
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
    reason: "observer_disconnected",
    connectionId: SELECTED,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 0,
    callbackCode: 1,
    clientState: "disconnected",
  };
  // The SDK's own terminal reaction to a transport close.
  const sdkDisconnects = () => {
    mockClient.state = "disconnected";
    mockClient.emit("disconnected", { code: 1, ...PRIVATE_CONTEXT });
  };

  test("adds the close pair to the first callback stop without changing it", async () => {
    const { onLost, socket, cause } = await start();
    const event = closeEvent(1006, false);
    const reason = jest.fn(() => "PRIVATE");
    Object.defineProperty(event, "reason", { get: reason });
    socket.dispatchEvent(event);
    expect(onLost).not.toHaveBeenCalled();
    sdkDisconnects();
    expect(cause()).toEqual({
      ...observerCause,
      socketCloseCode: 1006,
      socketCloseWasClean: false,
    });
    expect(reason).not.toHaveBeenCalled();
    expect(JSON.stringify(cause())).not.toContain("PRIVATE");
    // Later SDK events neither replace the first cause nor its pair.
    mockClient.emit("connecting", { code: 3012 });
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
    sdkDisconnects();
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
      sdkDisconnects();
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
    sdkDisconnects();
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
    sdkDisconnects();
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
    sdkDisconnects();
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
      sdkDisconnects();
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
    sdkDisconnects();
    expect(cause()).toEqual(observerCause);
  });
});

describe("an observer interruption after the host was verified", () => {
  function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  const hang = () => new Promise(() => {});
  // In the SDK's order: its subscription moves first, then its client.
  const transportClosed = () => {
    mockClient.state = "connecting";
    mockSubscription.emit("subscribing", { code: 1, ...PRIVATE_CONTEXT });
    mockClient.emit("connecting", { code: 1, ...PRIVATE_CONTEXT });
  };
  const resubscribed = async () => {
    mockClient.state = "connected";
    mockSubscription.emit("subscribed");
    await flush();
  };
  const interruptions: [string, () => void][] = [
    ["a transport close", transportClosed],
    [
      "a server resubscribe",
      () => mockSubscription.emit("subscribing", { code: 2500 }),
    ],
    [
      "a failed resubscribe",
      () => {
        mockSubscription.emit("subscribing", { code: 2500 });
        mockSubscription.emit("error", {
          type: "subscribe",
          error: { code: 100, message: "PRIVATE" },
        });
      },
    ],
  ];

  test.each(interruptions)(
    "recovers from %s through a new positive read",
    async (_name, interrupt) => {
      const { onLost } = await start();
      interrupt();
      const read = deferred();
      mockSubscription.presence.mockReturnValueOnce(read.promise);
      await resubscribed();
      await jest.advanceTimersByTimeAsync(9_000);
      read.resolve(online);
      await flush();
      const reads = mockSubscription.presence.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(onLost).not.toHaveBeenCalled();
      // The normal cadence resumes.
      expect(mockSubscription.presence).toHaveBeenCalledTimes(reads + 12);
    },
  );

  test.each(interruptions)(
    "a resubscription after %s alone never restores readiness",
    async (_name, interrupt) => {
      const { onLost, cause } = await start();
      interrupt();
      mockSubscription.presence.mockImplementation(hang);
      await resubscribed();
      await jest.advanceTimersByTimeAsync(14_999);
      expect(onLost).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(cause()).toEqual({
        reason: "observer_recovery_expired",
        connectionId: SELECTED,
        hadPositivePresence: true,
        lastPositivePresenceAgeMs: 15_000,
        clientState: "connected",
      });
      expect(JSON.stringify(cause())).not.toContain("PRIVATE");
      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test("repeated callbacks and failed reads never extend the window", async () => {
    const { onLost, cause } = await start();
    mockSubscription.presence.mockRejectedValue(new Error("PRIVATE"));
    transportClosed();
    for (let at = 0; at < 12_000; at += 4_000) {
      await jest.advanceTimersByTimeAsync(2_000);
      await resubscribed();
      await jest.advanceTimersByTimeAsync(2_000);
      transportClosed();
      mockSubscription.emit("error", { type: "subscribe", error: {} });
    }
    await jest.advanceTimersByTimeAsync(2_999);
    expect(onLost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(cause()).toMatchObject({
      reason: "observer_recovery_expired",
      lastPositivePresenceAgeMs: 15_000,
    });
  });

  test("ignores a read started before the interruption, even a positive one", async () => {
    const { onLost, cause } = await start();
    const stale = deferred();
    mockSubscription.presence.mockReturnValueOnce(stale.promise);
    await jest.advanceTimersByTimeAsync(5_000);
    mockSubscription.emit("subscribing", { code: 2500 });
    mockSubscription.presence.mockImplementation(hang);
    await resubscribed();
    stale.resolve(online);
    await flush();
    await jest.advanceTimersByTimeAsync(14_999);
    expect(onLost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(cause()?.reason).toBe("observer_recovery_expired");
  });

  test("ignores a failure of a superseded read after recovery", async () => {
    const { onLost, cause } = await start();
    const stale = deferred();
    mockSubscription.presence.mockReturnValueOnce(stale.promise);
    await jest.advanceTimersByTimeAsync(5_000);
    mockSubscription.emit("subscribing", { code: 2500 });
    await resubscribed();
    stale.reject(new Error("PRIVATE"));
    await flush();
    // Later reads hang: only their own timeout may open a new window.
    mockSubscription.presence.mockImplementation(hang);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(onLost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(cause()).toMatchObject({
      reason: "observer_recovery_expired",
      lastPositivePresenceAgeMs: 30_000,
    });
  });

  test("keeps at most one current read", async () => {
    await start();
    mockSubscription.presence.mockRejectedValueOnce(new Error("PRIVATE"));
    await jest.advanceTimersByTimeAsync(5_000);
    mockSubscription.presence.mockImplementation(hang);
    await jest.advanceTimersByTimeAsync(2_000);
    // Resubscribed while the next scheduled read was pending.
    mockSubscription.emit("subscribing", { code: 2500 });
    await resubscribed();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockSubscription.presence).toHaveBeenCalledTimes(3);
  });

  test.each([
    [
      "a selected host leave",
      () =>
        mockSubscription.emit("leave", {
          info: { connInfo: { connectionId: SELECTED } },
        }),
      "selected_host_left",
    ],
    [
      "a read without the selected host",
      async () => {
        mockSubscription.presence.mockResolvedValue({
          clients: { other: { connInfo: { connectionId: "replacement" } } },
        });
        await resubscribed();
      },
      "selected_presence_absent",
    ],
    [
      "a server unsubscribe",
      () => mockSubscription.emit("unsubscribed", { code: 2000 }),
      "subscription_unsubscribed",
    ],
  ])("stops at once on %s during recovery", async (_name, event, reason) => {
    const { onLost, cause } = await start();
    transportClosed();
    await jest.advanceTimersByTimeAsync(1_000);
    await event();
    expect(cause()?.reason).toBe(reason);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("normal completion during recovery cancels its timers and late reads", async () => {
    const { onLost, stop } = await start();
    transportClosed();
    const read = deferred();
    mockSubscription.presence.mockReturnValueOnce(read.promise);
    await resubscribed();
    stop();
    expect(jest.getTimerCount()).toBe(0);
    read.resolve(online);
    mockSubscription.emit("subscribed");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(onLost).not.toHaveBeenCalled();
    expect(mockSubscription.presence).toHaveBeenCalledTimes(2);
  });

  test("an expired window reports the interrupting close, not the retry's", async () => {
    const { socket, cause } = await start();
    socket.dispatchEvent(closeEvent(1006, false));
    transportClosed();
    // The SDK's next attempt fails silently before the deadline.
    sdkSocket("ws://localhost").dispatchEvent(closeEvent(1001, true));
    await jest.advanceTimersByTimeAsync(15_000);
    expect(cause()).toEqual({
      reason: "observer_recovery_expired",
      connectionId: SELECTED,
      hadPositivePresence: true,
      lastPositivePresenceAgeMs: 15_000,
      clientState: "connecting",
      socketCloseCode: 1006,
      socketCloseWasClean: false,
    });
  });

  test("leaves the SDK as the only retry owner, with delays that fit the window", async () => {
    const { Centrifuge } = jest.requireMock("centrifuge");
    await start();
    const { maxReconnectDelay } = Centrifuge.mock.calls[0][1];
    const { maxResubscribeDelay } = (
      mockClient.newSubscription.mock.calls[0] as unknown[]
    )[1] as { maxResubscribeDelay: number };
    // Several attempts of each fit in the fixed window.
    expect(maxReconnectDelay * 3).toBeLessThanOrEqual(15_000);
    expect(maxResubscribeDelay * 3).toBeLessThanOrEqual(15_000);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    transportClosed();
    await jest.advanceTimersByTimeAsync(15_000);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockSubscription.subscribe).toHaveBeenCalledTimes(1);
  });
});

// Before the first positive read, no host was verified: nothing to recover.
test.each([
  [
    "observer_reconnecting",
    "connecting",
    () => mockClient.emit("connecting", { code: 3012, ...PRIVATE_CONTEXT }),
    3012,
  ],
  [
    "subscription_reconnecting",
    "connected",
    () =>
      mockSubscription.emit("subscribing", { code: 2500, ...PRIVATE_CONTEXT }),
    2500,
  ],
])(
  "stops on %s after subscribing, before the host is verified",
  async (reason, clientState, emit, callbackCode) => {
    mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
    const { cause } = await start();
    mockClient.state = clientState;
    emit();
    expect(cause()).toEqual({
      reason,
      connectionId: SELECTED,
      hadPositivePresence: false,
      callbackCode,
      clientState,
    });
    expect(JSON.stringify(cause())).not.toContain("PRIVATE");
  },
);

test("a subscription error before verification still stops", async () => {
  mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
  const { cause } = await start();
  mockSubscription.emit("error", {
    code: 1,
    error: { code: 100, message: "PRIVATE" },
    ...PRIVATE_CONTEXT,
  });
  expect(cause()).toEqual({
    reason: "subscription_error",
    connectionId: SELECTED,
    hadPositivePresence: false,
  });
});
