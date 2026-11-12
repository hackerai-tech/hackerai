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
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.CENTRIFUGO_WS_URL;
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
  mockSubscription.emit("subscribed");
  await flush();
  return watcher;
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
  const { onLost, stop } = await start();
  stop();
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: SELECTED } },
  });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(onLost).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
