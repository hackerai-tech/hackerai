import { cancelAgentRunWithRetry } from "../agent-run-cancellation";

describe("Agent cloud cancellation recovery", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("retries a lost request for the captured run after connectivity returns", async () => {
    const fetchMock = jest.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError("Network connection lost"));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const pending = cancelAgentRunWithRetry("chat-1", "run-stopped");
    const outcome = pending.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await outcome).toMatchObject({ outcome: "canceled" });
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init!.body as string)).toEqual({
        chatId: "chat-1",
        expectedTriggerRunId: "run-stopped",
      });
    }
  });
  it("aborts a hung request and retries even without an online event", async () => {
    const fetchMock = jest.mocked(fetch);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const pending = cancelAgentRunWithRetry("hung-chat", "hung-run");
    const signal = fetchMock.mock.calls[0][1]!.signal!;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ outcome: "canceled" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("coalesces Stop clicks and retries immediately on reconnect", async () => {
    const fetchMock = jest.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const first = cancelAgentRunWithRetry("same-chat", "same-run");
    expect(cancelAgentRunWithRetry("same-chat", "same-run")).toBe(first);
    await jest.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    expect(await first).toEqual({ outcome: "canceled" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([408, 429, 503])(
    "retries transient HTTP %s and honors Retry-After",
    async (status) => {
      const fetchMock = jest.mocked(fetch);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status,
        headers: { get: () => "3" },
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      const pending = cancelAgentRunWithRetry("http-chat", `run-${status}`);
      await jest.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ outcome: "canceled" });
    },
  );

  it.each([400, 401, 403, 404])(
    "does not retry terminal HTTP %s",
    async (status) => {
      const fetchMock = jest.mocked(fetch);
      fetchMock.mockResolvedValue({ ok: false, status } as Response);
      await expect(
        cancelAgentRunWithRetry("denied-chat", `run-${status}`),
      ).rejects.toThrow(`status ${status}`);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each([null, "run-replacement"])(
    "reconciles uncertain delivery without canceling replacement %s",
    async (activeTriggerRunId) => {
      const fetchMock = jest.mocked(fetch);
      fetchMock.mockRejectedValueOnce(new TypeError("response lost"));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ reason: "stale_run", activeTriggerRunId }),
      } as Response);
      const pending = cancelAgentRunWithRetry("race-chat", "run-original");
      await jest.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({
        outcome: "stale_run",
        expectedTriggerRunId: "run-original",
        activeTriggerRunId,
      });
      expect(
        fetchMock.mock.calls.map(
          ([, init]) => JSON.parse(init!.body as string).expectedTriggerRunId,
        ),
      ).toEqual(["run-original", "run-original"]);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});
