import { getCancellationResponseReceipt } from "@/lib/agent-cancellation-response";
import { cancelAgentRunWithRetry } from "../agent-run-cancellation";

const REQUEST_ID = "iad1::iad1::abcd1-1763049600000-0123456789abcdef";

// A terminal response whose body and non-diagnostic headers must stay unread.
function terminalResponse(fields: Record<string, unknown> = {}) {
  const bodyReads: string[] = [];
  const headerReads: string[] = [];
  const response = {
    ok: false,
    status: 403,
    type: "basic",
    redirected: false,
    url: "https://hackerai.co/api/agent/cancel",
    headers: {
      get: (name: string) => {
        headerReads.push(name);
        return name.toLowerCase() === "x-vercel-id" ? REQUEST_ID : "secret";
      },
    },
    ...fields,
  };
  for (const method of ["json", "text", "arrayBuffer", "blob", "formData"])
    Object.defineProperty(response, method, {
      value: () => bodyReads.push(method),
    });
  for (const property of ["body", "bodyUsed", "clone"])
    Object.defineProperty(response, property, {
      get: () => bodyReads.push(property),
    });
  return { response: response as unknown as Response, bodyReads, headerReads };
}

async function rejectWith(response: Response, runId: string) {
  jest.mocked(fetch).mockResolvedValue(response);
  const error = await cancelAgentRunWithRetry("receipt-chat", runId).catch(
    (caught: unknown) => caught,
  );
  await jest.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  return error;
}

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

  it("attaches a bounded response receipt to the unchanged terminal rejection", async () => {
    const { response, bodyReads, headerReads } = terminalResponse();
    const error = await rejectWith(response, "run-receipt");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Agent cancellation failed with status 403",
    );
    expect(getCancellationResponseReceipt(error)).toEqual({
      cancellation_response_diagnostic_version: 1,
      cancellation_response_http_status: 403,
      cancellation_response_type: "basic",
      cancellation_response_redirected: "false",
      cancellation_response_url_origin: "hackerai_production",
      cancellation_response_endpoint: "agent_cancel",
      cancellation_response_platform_request_id_state: "valid",
      cancellation_response_platform_request_id: REQUEST_ID,
    });
    expect(bodyReads).toEqual([]);
    expect(headerReads).toEqual(["x-vercel-id"]);
    expect(
      getCancellationResponseReceipt(
        new Error("Agent cancellation failed with status 403"),
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "https://signin.hackerai.co/api/agent/cancel",
      "signin_production",
      "agent_cancel",
    ],
    [
      "https://hackerai-git-x-team.vercel.app/api/agent/cancel?token=CANARY",
      "vercel_deployment",
      "agent_cancel",
    ],
    ["https://hackerai.co/login?next=CANARY", "hackerai_production", "other"],
    [
      "https://user:CANARY@hackerai.co/api/agent/cancel",
      "other",
      "agent_cancel",
    ],
    ["http://hackerai.co/api/agent/cancel", "other", "agent_cancel"],
    ["https://hackerai.co:8443/api/agent/cancel", "other", "agent_cancel"],
    ["https://a.b.vercel.app/api/agent/cancel", "other", "agent_cancel"],
    ["https://CANARY.example/api/agent/cancel#CANARY", "other", "agent_cancel"],
    ["", "absent", "absent"],
    ["not a url CANARY", "unreadable", "unreadable"],
  ])(
    "classifies response URL %j without retaining it",
    async (url, origin, endpoint) => {
      const { response } = terminalResponse({ url });
      const receipt = getCancellationResponseReceipt(
        await rejectWith(response, `run-url-${origin}-${endpoint}`),
      );
      expect(receipt).toMatchObject({
        cancellation_response_url_origin: origin,
        cancellation_response_endpoint: endpoint,
      });
      expect(JSON.stringify(receipt)).not.toMatch(
        /CANARY|example|vercel\.app|\/api/,
      );
    },
  );

  it("bounds URL parsing before classifying a terminal response", async () => {
    const { response } = terminalResponse({
      url:
        "https://hackerai.co/api/agent/cancel?token=" + "CANARY".repeat(1400),
    });
    const receipt = getCancellationResponseReceipt(
      await rejectWith(response, "run-oversized-url"),
    );
    expect(receipt).toMatchObject({
      cancellation_response_url_origin: "unreadable",
      cancellation_response_endpoint: "unreadable",
    });
    expect(JSON.stringify(receipt)).not.toContain("CANARY");
  });

  it.each([
    [null, "absent"],
    [REQUEST_ID + "\n", "invalid"],
    [REQUEST_ID + "\r", "invalid"],
    [REQUEST_ID + "\u2028", "invalid"],
    ["fra1::xyz12-1763049600000-deadbeef", "valid"],
    ["iad1::CANARY-1763049600000-deadbeef", "invalid"],
    [`iad1::abcd1-1763049600000-${"a".repeat(32)}; CANARY`, "invalid"],
    [`${"iad1::".repeat(3)}abcd1-1763049600000-deadbeef`, "invalid"],
    [`iad1::abcd1-1763049600000-${"a".repeat(200)}`, "invalid"],
  ])("validates platform request ID %j", async (header, state) => {
    const { response } = terminalResponse({ headers: { get: () => header } });
    const receipt = getCancellationResponseReceipt(
      await rejectWith(response, `run-id-${state}-${String(header).length}`),
    );
    expect(receipt?.cancellation_response_platform_request_id_state).toBe(
      state,
    );
    expect(receipt?.cancellation_response_platform_request_id).toBe(
      state === "valid" ? header : undefined,
    );
    expect(JSON.stringify(receipt)).not.toContain("CANARY");
  });

  it.each([
    [0, 0],
    [99, undefined],
    [403.5, undefined],
  ])("keeps only valid HTTP status %s", async (status, recorded) => {
    const { response } = terminalResponse({
      status,
      type: "opaque",
      redirected: "yes",
    });
    const receipt = getCancellationResponseReceipt(
      await rejectWith(response, `run-status-${status}`),
    );
    expect(receipt?.cancellation_response_http_status).toBe(recorded);
    expect(receipt).toMatchObject({
      cancellation_response_type: "opaque",
      cancellation_response_redirected: "unavailable",
    });
  });

  it("keeps the terminal rejection when diagnostic getters throw", async () => {
    const { response } = terminalResponse();
    for (const property of ["type", "redirected", "url", "headers"])
      Object.defineProperty(response, property, {
        get: () => {
          throw new Error("hostile getter");
        },
      });
    const error = await rejectWith(response, "run-hostile");
    expect((error as Error).message).toBe(
      "Agent cancellation failed with status 403",
    );
    expect(getCancellationResponseReceipt(error)).toEqual({
      cancellation_response_diagnostic_version: 1,
      cancellation_response_http_status: 403,
      cancellation_response_type: "unreadable",
      cancellation_response_redirected: "unreadable",
      cancellation_response_url_origin: "unreadable",
      cancellation_response_endpoint: "unreadable",
      cancellation_response_platform_request_id_state: "unreadable",
    });
  });

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
