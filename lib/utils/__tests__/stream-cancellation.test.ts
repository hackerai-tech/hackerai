import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCreateRedisSubscriber = jest.fn();
const mockGetCancellationStatus = jest.fn();
const mockPhInfo = jest.fn();
const mockPhLoggerWarn = jest.fn();
const mockLoggerWarn = jest.fn();

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
    info: mockPhInfo,
    error: jest.fn(),
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
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

describe("createPreemptiveTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("aborts with a one-minute cleanup buffer and emits correlated logs", async () => {
    const { createPreemptiveTimeout } = await import("../stream-cancellation");
    const abortController = new AbortController();
    const abortSpy = jest.spyOn(abortController, "abort");

    const timeout = createPreemptiveTimeout({
      chatId: "chat-1",
      endpoint: "/api/chat",
      abortController,
      requestId: "iad1::request-1",
      userId: "user-1",
      getLogContext: () => ({
        mode: "ask",
        selected_model: "model-opus-4.6",
        requested_model_slug: "anthropic/claude-opus-4.6",
        provider_name: "Google Vertex",
        provider_attribution_available: true,
      }),
    });

    jest.advanceTimersByTime(359_999);
    expect(abortSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Preemptive timeout triggered",
      expect.objectContaining({
        event: "chat.preemptive_timeout_triggered",
        request_id: "iad1::request-1",
        user_id: "user-1",
        chat_id: "chat-1",
        endpoint: "/api/chat",
        mode: "ask",
        selected_model: "model-opus-4.6",
        requested_model_slug: "anthropic/claude-opus-4.6",
        provider_name: "Google Vertex",
        provider_attribution_available: true,
        max_duration_seconds: 420,
        safety_buffer_seconds: 60,
        max_stream_time_ms: 360_000,
      }),
    );
    expect(mockPhInfo).toHaveBeenCalledWith(
      "Preemptive timeout triggered",
      expect.objectContaining({
        event: "chat.preemptive_timeout_triggered",
        request_id: "iad1::request-1",
        userId: "user-1",
        selected_model: "model-opus-4.6",
        provider_name: "Google Vertex",
      }),
    );

    timeout.clear();
  });

  it("still aborts when diagnostic context resolution fails", async () => {
    const { createPreemptiveTimeout } = await import("../stream-cancellation");
    const abortController = new AbortController();

    createPreemptiveTimeout({
      chatId: "chat-1",
      endpoint: "/api/chat",
      abortController,
      requestId: "iad1::request-1",
      getLogContext: () => {
        throw new Error("context unavailable");
      },
    });

    jest.advanceTimersByTime(360_000);

    expect(abortController.signal.aborted).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Preemptive timeout triggered",
      expect.objectContaining({
        request_id: "iad1::request-1",
        log_context_resolution_failed: true,
      }),
    );
  });
});
