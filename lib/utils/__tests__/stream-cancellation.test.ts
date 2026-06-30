import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockCreateRedisSubscriber = jest.fn();
const mockGetCancellationStatus = jest.fn();
const mockPhLoggerWarn = jest.fn();

jest.mock("@/lib/utils/redis-pubsub", () => ({
  createRedisSubscriber: mockCreateRedisSubscriber,
  getCancelChannel: jest.fn((chatId: string) => `stream:cancel:${chatId}`),
}));

jest.mock("@/lib/db/actions", () => ({
  getCancellationStatus: mockGetCancellationStatus,
  getTempCancellationStatus: jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    warn: mockPhLoggerWarn,
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe("createCancellationSubscriber", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("falls back to polling when a live Redis subscriber errors", async () => {
    const { createCancellationSubscriber } =
      await import("../stream-cancellation");
    let runtimeError: ((error: unknown) => void) | undefined;
    const redisSubscriber = {
      subscribe: jest.fn(async () => {}),
      unsubscribe: jest.fn(async () => {}),
      quit: jest.fn(async () => {}),
    };
    mockCreateRedisSubscriber.mockImplementation(async (options) => {
      runtimeError = options.onError;
      return redisSubscriber;
    });
    mockGetCancellationStatus.mockResolvedValue({
      canceled_at: Date.now(),
    });

    const abortController = new AbortController();
    const onStop = jest.fn();

    const subscriber = await createCancellationSubscriber({
      chatId: "chat-123",
      isTemporary: false,
      abortController,
      onStop,
      pollIntervalMs: 10,
    });

    runtimeError?.(
      Object.assign(new Error("read ETIMEDOUT"), {
        code: "ETIMEDOUT",
        syscall: "read",
      }),
    );

    jest.advanceTimersByTime(10);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPhLoggerWarn).toHaveBeenCalledWith(
      "redis_pubsub_unavailable",
      expect.objectContaining({
        event: "redis.pubsub_unavailable",
        chatId: "chat-123",
        isTemporary: false,
      }),
    );
    expect(redisSubscriber.unsubscribe).toHaveBeenCalledWith(
      "stream:cancel:chat-123",
    );
    expect(redisSubscriber.quit).toHaveBeenCalled();
    expect(mockGetCancellationStatus).toHaveBeenCalledWith({
      chatId: "chat-123",
    });
    expect(abortController.signal.aborted).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);

    await subscriber.stop();
  });
});
