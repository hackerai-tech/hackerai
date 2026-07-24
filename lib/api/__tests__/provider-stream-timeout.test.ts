import {
  getProviderErrorCategory,
  extractErrorDetails,
} from "@/lib/utils/error-utils";
import {
  createProviderStreamTimeoutGuard,
  ProviderStreamTimeoutError,
} from "@/lib/api/provider-stream-timeout";

describe("provider stream inactivity timeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("times out a provider step that never emits a first chunk", async () => {
    const externalAbortController = new AbortController();
    const onTimeout = jest.fn();
    const guard = createProviderStreamTimeoutGuard({
      externalAbortSignal: externalAbortController.signal,
      onTimeout,
      timeoutMs: 100,
    });

    guard.startProviderStep();
    await jest.advanceTimersByTimeAsync(100);

    expect(guard.signal.aborted).toBe(true);
    expect(guard.getTimeoutError()).toMatchObject({
      name: "ProviderStreamTimeoutError",
      code: "PROVIDER_STREAM_TIMEOUT",
      phase: "first_chunk",
      timeoutMs: 100,
    });
    expect(guard.signal.reason).toBe(guard.getTimeoutError());
    expect(onTimeout).toHaveBeenCalledWith(guard.getTimeoutError());
  });

  it("resets the deadline for activity and classifies a between-chunk stall", async () => {
    const guard = createProviderStreamTimeoutGuard({
      externalAbortSignal: new AbortController().signal,
      onTimeout: jest.fn(),
      timeoutMs: 100,
    });

    guard.startProviderStep();
    await jest.advanceTimersByTimeAsync(90);
    guard.recordProviderActivity();
    await jest.advanceTimersByTimeAsync(99);
    expect(guard.signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);

    expect(guard.getTimeoutError()).toMatchObject({
      phase: "between_chunks",
    });
    expect(guard.signal.aborted).toBe(true);
  });

  it("keeps explicit user abort separate from an internal timeout", async () => {
    const externalAbortController = new AbortController();
    const onTimeout = jest.fn();
    const guard = createProviderStreamTimeoutGuard({
      externalAbortSignal: externalAbortController.signal,
      onTimeout,
      timeoutMs: 100,
    });

    guard.startProviderStep();
    externalAbortController.abort(
      new DOMException("The user stopped the run", "AbortError"),
    );
    await jest.advanceTimersByTimeAsync(1_000);

    expect(guard.signal.aborted).toBe(false);
    expect(guard.getTimeoutError()).toBeUndefined();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not time out a long terminal tool execution", async () => {
    const guard = createProviderStreamTimeoutGuard({
      externalAbortSignal: new AbortController().signal,
      onTimeout: jest.fn(),
      timeoutMs: 100,
    });

    guard.startProviderStep();
    guard.recordProviderActivity();
    guard.pauseForToolExecution();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(guard.signal.aborted).toBe(false);

    guard.startProviderStep();
    await jest.advanceTimersByTimeAsync(100);
    expect(guard.getTimeoutError()).toMatchObject({
      phase: "first_chunk",
    });
  });

  it("uses the existing provider timeout error category", () => {
    const error = new ProviderStreamTimeoutError({
      phase: "between_chunks",
      timeoutMs: 120_000,
    });

    expect(getProviderErrorCategory(extractErrorDetails(error))).toBe(
      "timeout",
    );
  });
});
