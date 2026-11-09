import { EventEmitter } from "events";
import { watchLocalRunConnection } from "../watch-local-run-connection";

const mockSubscription = Object.assign(new EventEmitter(), {
  presence: jest.fn(),
  subscribe: jest.fn(),
});
const mockClient = Object.assign(new EventEmitter(), {
  connect: jest.fn(),
  disconnect: jest.fn(),
  newSubscription: jest.fn(() => mockSubscription),
});
jest.mock("centrifuge", () => ({ Centrifuge: jest.fn(() => mockClient) }));
jest.mock("../jwt", () => ({
  generateCentrifugoToken: jest.fn().mockResolvedValue("token"),
}));

const online = {
  clients: { desktop: { connInfo: { connectionId: "original" } } },
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
  mockSubscription.presence.mockResolvedValue(online);
  process.env.CENTRIFUGO_WS_URL = "ws://localhost";
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.CENTRIFUGO_WS_URL;
});

async function start() {
  const onLost = jest.fn();
  const stop = watchLocalRunConnection({
    userId: "u",
    connectionId: "original",
    onLost,
  });
  await flush();
  mockSubscription.emit("subscribed");
  await flush();
  return { onLost, stop };
}

test("stops once on the selected desktop leaving, never on another subscriber", async () => {
  const { onLost } = await start();
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: "other" } },
  });
  expect(onLost).not.toHaveBeenCalled();
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: "original" } },
  });
  expect(onLost).toHaveBeenCalledTimes(1);
  mockSubscription.emit("subscribed");
  await jest.advanceTimersByTimeAsync(30_000);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
});

test("detects a crash without a leave event and rejects a replacement session", async () => {
  const { onLost } = await start();
  mockSubscription.presence.mockResolvedValue({
    clients: { replacement: { connInfo: { connectionId: "replacement" } } },
  });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("stops a thinking run even when no commands are being executed", async () => {
  const { onLost } = await start();
  mockSubscription.presence.mockResolvedValue({ clients: {} });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("ends the run when the relay starts reconnecting", async () => {
  const { onLost } = await start();
  mockClient.emit("connecting");
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("bounds a hung presence check", async () => {
  mockSubscription.presence.mockImplementation(() => new Promise(() => {}));
  const { onLost } = await start();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(onLost).toHaveBeenCalledTimes(1);
});

test("normal completion disposes monitoring without marking the run interrupted", async () => {
  const { onLost, stop } = await start();
  stop();
  mockSubscription.emit("leave", {
    info: { connInfo: { connectionId: "original" } },
  });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(onLost).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
