import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockCreateClient = jest.fn();

jest.mock("redis", () => ({
  createClient: mockCreateClient,
}));

describe("createRedisSubscriber", () => {
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    process.env.REDIS_URL = originalRedisUrl;
    jest.restoreAllMocks();
  });

  it("uses a default warning sink when no onError callback is provided", async () => {
    const listeners = new Map<string, (error: unknown) => void>();
    const client = {
      on: jest.fn((event: string, listener: (error: unknown) => void) => {
        listeners.set(event, listener);
        return client;
      }),
      connect: jest.fn(async () => {}),
    };
    mockCreateClient.mockReturnValue(client);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { createRedisSubscriber } = await import("../redis-pubsub");
    await createRedisSubscriber();

    const error = new Error("read ETIMEDOUT");
    listeners.get("error")?.(error);

    expect(warnSpy).toHaveBeenCalledWith("Redis subscriber error:", error);
  });

  it("uses the supplied onError callback instead of the default warning sink", async () => {
    const client = {
      on: jest.fn(),
      connect: jest.fn(async () => {
        throw new Error("connect failed");
      }),
    };
    mockCreateClient.mockReturnValue(client);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const onError = jest.fn();

    const { createRedisSubscriber } = await import("../redis-pubsub");
    const subscriber = await createRedisSubscriber({ onError });

    expect(subscriber).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
