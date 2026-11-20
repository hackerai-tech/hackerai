import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { __loaded: true, capture: mockCapture },
}));
const {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} = require("../client") as typeof import("../client");
const { getAgentPartialSaveBodyBucket } =
  require("../agent-start-diagnostics") as typeof import("../agent-start-diagnostics");
const { fetchAgentPartialSaveWithDiagnostic } =
  require("../agent-partial-save-diagnostics") as typeof import("../agent-partial-save-diagnostics");
const { createAgentPartialSaveQueue } =
  require("@/lib/chat/agent-partial-save-queue") as typeof import("@/lib/chat/agent-partial-save-queue");
const { AGENT_PARTIAL_SAVE_ENDPOINT } =
  require("@/lib/api/agent-endpoints") as typeof import("@/lib/api/agent-endpoints");

const EVENT = "agent_partial_save_http413_diagnostic";
const BUILD = "0123456789".repeat(4);
const REQUEST_ID = "iad1::8x2kq-1794094000000-0123456789ab";
const MIB = 1024 * 1024;
const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const originalBuild = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
const originalFetch = globalThis.fetch;

/**
 * Counts character reads of `body`, which is how the UTF-8 counter scans it.
 * Restored by `jest.restoreAllMocks` after each test.
 */
function observeScans(body: string) {
  const charCodeAt = jest.spyOn(String.prototype, "charCodeAt");
  return () =>
    charCodeAt.mock.contexts.filter((receiver) => String(receiver) === body)
      .length;
}

function identify(userId: string | null) {
  setAuthenticatedAnalyticsUserId(userId);
  if (userId) confirmAuthenticatedAnalyticsUserId(userId);
}

function diagnostics() {
  return mockCapture.mock.calls
    .filter(([event]) => event === EVENT)
    .map(([, properties]) => properties as Record<string, unknown>);
}

/** A synthetic HTTP response whose body must never be read. */
function httpResponse(
  status: number,
  headers: Record<string, string> = {},
  onHeaderRead?: () => void,
) {
  const bodyRead = jest.fn();
  const headerGet = jest.fn((name: string) => {
    onHeaderRead?.();
    return headers[name.toLowerCase()] ?? null;
  });
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: headerGet },
    clone: bodyRead,
    text: bodyRead,
    json: bodyRead,
    arrayBuffer: bodyRead,
    blob: bodyRead,
    formData: bodyRead,
    get body() {
      bodyRead();
      return null;
    },
    get bodyUsed() {
      bodyRead();
      return false;
    },
  };
  return { response: response as unknown as Response, bodyRead, headerGet };
}

const fetchMock = jest.fn<typeof fetch>();

/** The chat writer: one queue entry whose write calls the wrapper per attempt. */
function save(body: string) {
  const queue = createAgentPartialSaveQueue();
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
  const write = () =>
    fetchAgentPartialSaveWithDiagnostic(AGENT_PARTIAL_SAVE_ENDPOINT, init);
  return {
    queue,
    init,
    saved: queue.save("chat-1", "chat-1:message-1", write),
  };
}

const BODY = JSON.stringify({
  chatId: "PRIVATE_CHAT",
  message: { id: "PRIVATE_MESSAGE", parts: [{ text: "PRIVATE_PROMPT €😀" }] },
  triggerRunId: "run_PRIVATE",
  runCorrelationToken: "PRIVATE_TOKEN",
});

beforeAll(async () => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  await loadPostHogClient();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchMock,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: originalFetch,
  });
  for (const [key, value] of [
    ["NEXT_PUBLIC_POSTHOG_KEY", originalKey],
    ["NEXT_PUBLIC_HACKERAI_BUILD_COMMIT", originalBuild],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = BUILD;
  identify(null);
  identify("user-a");
  fetchMock.mockReset();
  mockCapture.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("getAgentPartialSaveBodyBucket", () => {
  const utf8 = (value: string) => new TextEncoder().encode(value).length;

  it.each<[string, () => string, string]>([
    ["empty", () => "", "lte_4_mib"],
    ["exactly 4 MiB of ASCII", () => "a".repeat(4 * MIB), "lte_4_mib"],
    ["one byte over 4 MiB", () => "a".repeat(4 * MIB + 1), "gt_4_lte_4_5_mib"],
    ["exactly 4.5 MiB", () => "a".repeat(4.5 * MIB), "gt_4_lte_4_5_mib"],
    [
      "one byte over 4.5 MiB",
      () => "a".repeat(4.5 * MIB + 1),
      "gt_4_5_lte_8_mib",
    ],
    ["exactly 8 MiB", () => "a".repeat(8 * MIB), "gt_4_5_lte_8_mib"],
    // 2 MiB two-byte characters: half the code units, exactly 4 MiB of UTF-8.
    ["4 MiB of two-byte UTF-8", () => "é".repeat(2 * MIB), "lte_4_mib"],
    [
      "one byte past 4 MiB of two-byte UTF-8",
      () => `${"é".repeat(2 * MIB)}a`,
      "gt_4_lte_4_5_mib",
    ],
    // Fewer than 8 Mi code units, but 9 MiB of three-byte UTF-8.
    ["9 MiB of three-byte UTF-8", () => "€".repeat(3 * MIB), "gt_8_mib"],
    [
      "a surrogate pair at the 4.5 MiB edge",
      () => `${"a".repeat(4.5 * MIB - 4)}😀`,
      "gt_4_lte_4_5_mib",
    ],
    [
      "a lone surrogate one byte past 4.5 MiB",
      () => `${"a".repeat(4.5 * MIB - 2)}\ud83d`,
      "gt_4_5_lte_8_mib",
    ],
  ])("buckets %s by UTF-8 bytes", (_name, make, bucket) => {
    const body = make();
    expect(getAgentPartialSaveBodyBucket(body)).toBe(bucket);
    // The same bucket TextEncoder's exact byte count gives.
    const bytes = utf8(body);
    expect(
      bytes <= 4 * MIB
        ? "lte_4_mib"
        : bytes <= 4.5 * MIB
          ? "gt_4_lte_4_5_mib"
          : bytes <= 8 * MIB
            ? "gt_4_5_lte_8_mib"
            : "gt_8_mib",
    ).toBe(bucket);
  });

  it("proves above 8 MiB from the UTF-16 length without scanning", () => {
    const body = "a".repeat(8 * MIB + 1);
    const charCodeAt = jest.spyOn(String.prototype, "charCodeAt");
    expect(getAgentPartialSaveBodyBucket(body)).toBe("gt_8_mib");
    expect(charCodeAt).not.toHaveBeenCalled();
    // Control: a body within the scan budget is read.
    expect(getAgentPartialSaveBodyBucket("ab")).toBe("lte_4_mib");
    expect(charCodeAt).toHaveBeenCalledTimes(2);
  });

  it("reports a non-string body as unknown without reading it", () => {
    const toString = jest.fn(() => "PRIVATE");
    expect(getAgentPartialSaveBodyBucket({ toString })).toBe("unknown");
    expect(getAgentPartialSaveBodyBucket(undefined)).toBe("unknown");
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("fetchAgentPartialSaveWithDiagnostic on the partial-save queue", () => {
  it("passes one terminal 413 through unchanged and reports one bucketed receipt", async () => {
    const { response, bodyRead, headerGet } = httpResponse(413, {
      "x-vercel-error": "FUNCTION_PAYLOAD_TOO_LARGE",
      "x-vercel-id": REQUEST_ID,
      // Only Agent start reads its app marker.
      "x-hackerai-agent-start-rejection": "trigger_payload_too_large",
    });
    fetchMock.mockResolvedValue(response);
    const attemptKey = "00000000-0000-4000-8000-00000000abcd";
    jest.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(attemptKey);
    const scans = observeScans(BODY);

    const { queue, init, saved } = save(BODY);
    await saved;
    expect(await queue.flush("chat-1")).toBe(true);
    expect(await queue.flush("chat-1")).toBe(true);

    expect(scans()).toBeGreaterThan(0);
    expect(headerGet.mock.calls.map(([name]) => name)).toEqual([
      "x-vercel-error",
      "x-vercel-id",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, sentInit] = fetchMock.mock.calls[0];
    expect(url).toBe(AGENT_PARTIAL_SAVE_ENDPOINT);
    expect(sentInit).toBe(init);
    expect(sentInit?.body).toBe(BODY);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      EVENT,
      {
        agent_partial_save_http413_diagnostic_version: 1,
        http_status: 413,
        request_body_utf8_bucket: "lte_4_mib",
        vercel_error_state: "known",
        platform_request_id_state: "valid",
        platform_request_id: REQUEST_ID,
        build_state: "measured",
        hackerai_frontend_build_commit: BUILD,
      },
      { uuid: expect.any(String) },
    );
    // Neither content nor the attempt key; the event UUID is derived from it.
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      new RegExp(`PRIVATE|${attemptKey}`),
    );
  });

  it("resolves with the exact response object fetch returned", async () => {
    const { response } = httpResponse(413);
    fetchMock.mockResolvedValue(response);
    const init = { method: "POST", body: "{}" };
    await expect(
      fetchAgentPartialSaveWithDiagnostic(AGENT_PARTIAL_SAVE_ENDPOINT, init),
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith(AGENT_PARTIAL_SAVE_ENDPOINT, init);
  });

  it.each<[number, boolean]>([
    [200, false],
    [400, true],
  ])(
    "leaves a %s outcome and the queue result unchanged without telemetry or a scan",
    async (status, rejected) => {
      const { response, bodyRead } = httpResponse(status, {
        "x-vercel-id": REQUEST_ID,
      });
      fetchMock.mockResolvedValue(response);
      const scans = observeScans(BODY);
      const { queue, saved } = save(BODY);
      await saved;
      expect(await queue.flush("chat-1")).toBe(rejected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockCapture).not.toHaveBeenCalled();
      expect(scans()).toBe(0);
      expect(bodyRead).not.toHaveBeenCalled();
    },
  );

  it.each<[string, () => Promise<Response>]>([
    ["a 429", async () => httpResponse(429).response],
    ["a 503", async () => httpResponse(503).response],
    [
      "a network failure",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])(
    "keeps %s retryable and the retry unobserved until its own 413",
    async (_name, first) => {
      fetchMock
        .mockImplementationOnce(first)
        .mockResolvedValueOnce(httpResponse(413).response);
      const { queue, saved } = save(BODY);
      await expect(saved).rejects.toThrow();
      expect(mockCapture).not.toHaveBeenCalled();
      expect(await queue.flush("chat-1")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]?.body).toBe(BODY);
      expect(diagnostics()).toHaveLength(1);
    },
  );

  it("rejects with the exact fetch error, including a synchronous throw", async () => {
    const failure = new TypeError("Failed to fetch");
    fetchMock.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      fetchAgentPartialSaveWithDiagnostic(AGENT_PARTIAL_SAVE_ENDPOINT, {
        body: "{}",
      }),
    ).rejects.toBe(failure);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>, Record<string, unknown>]>([
    [
      "absent headers",
      {},
      { vercel_error_state: "absent", platform_request_id_state: "absent" },
    ],
    [
      "an unknown error code and an invalid request ID",
      {
        "x-vercel-error": "function_payload_too_large",
        "x-vercel-id": "https://PRIVATE.example/?id=1",
      },
      { vercel_error_state: "other", platform_request_id_state: "invalid" },
    ],
  ])("classifies %s without copying them", async (_name, headers, states) => {
    fetchMock.mockResolvedValue(httpResponse(413, headers).response);
    await save(BODY).saved;
    expect(diagnostics()).toEqual([expect.objectContaining(states)]);
    expect(diagnostics()[0]).not.toHaveProperty("platform_request_id");
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      /PRIVATE|function_payload_too_large/,
    );
  });

  it("marks throwing headers unreadable and an invalid build unavailable", async () => {
    process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "not-a-commit";
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      get headers(): Headers {
        throw new Error("PRIVATE");
      },
    } as unknown as Response);
    await save(BODY).saved;
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        vercel_error_state: "unreadable",
        platform_request_id_state: "unreadable",
        build_state: "unavailable",
      }),
    ]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      /PRIVATE|not-a-commit/,
    );
  });

  it("reports an oversized body as above 8 MiB from its length alone", async () => {
    fetchMock.mockResolvedValue(httpResponse(413).response);
    const body = "a".repeat(8 * MIB + 1);
    const scans = observeScans(body);
    await save(body).saved;
    expect(diagnostics()).toEqual([
      expect.objectContaining({ request_body_utf8_bucket: "gt_8_mib" }),
    ]);
    expect(scans()).toBe(0);
  });

  it("gives each 413 attempt its own event identity", async () => {
    fetchMock.mockResolvedValue(httpResponse(413).response);
    await save(BODY).saved;
    await save(BODY).saved;
    const uuids = mockCapture.mock.calls.map(
      ([, , options]) => (options as { uuid: string }).uuid,
    );
    expect(uuids).toHaveLength(2);
    expect(uuids[0]).not.toBe(uuids[1]);
  });

  it("does not observe permitted-but-unidentified or anonymous owners", async () => {
    fetchMock.mockResolvedValue(httpResponse(413).response);
    setAuthenticatedAnalyticsUserId("user-pending");
    await save(BODY).saved;
    identify(null);
    await save(BODY).saved;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each<[string, (string | null)[]]>([
    ["switches account", ["user-b"]],
    ["revokes consent", [null]],
    ["leaves and re-enters", [null, "user-a"]],
  ])(
    "drops an in-flight 413 when the owner %s, leaving the save outcome",
    async (_name, transitions) => {
      fetchMock.mockImplementation(async () => {
        transitions.forEach(identify);
        return httpResponse(413).response;
      });
      const { queue, saved } = save(BODY);
      await saved;
      expect(await queue.flush("chat-1")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it("keeps the attempt through a same-owner identification", async () => {
    fetchMock.mockImplementation(async () => {
      confirmAuthenticatedAnalyticsUserId("user-a");
      return httpResponse(413).response;
    });
    await save(BODY).saved;
    expect(diagnostics()).toHaveLength(1);
  });

  it.each<[string, (string | null)[]]>([
    ["switches account", ["user-b"]],
    ["leaves and re-enters", [null, "user-a"]],
  ])(
    "drops a 413 when the owner %s during the header read",
    async (_name, transitions) => {
      let changed = false;
      fetchMock.mockResolvedValue(
        httpResponse(413, {}, () => {
          if (changed) return;
          changed = true;
          transitions.forEach(identify);
        }).response,
      );
      await save(BODY).saved;
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  it("checks the owner again immediately before capture", async () => {
    fetchMock.mockResolvedValue(httpResponse(413).response);
    jest.spyOn(globalThis.crypto, "randomUUID").mockImplementationOnce(() => {
      identify("user-b");
      return "00000000-0000-4000-8000-000000000000";
    });
    await save(BODY).saved;
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown]>([
    [
      "throws",
      () => {
        throw new Error("crypto unavailable");
      },
    ],
    ["is malformed", () => "not-a-uuid"],
  ])(
    "drops the report but keeps the 413 when attempt identity %s",
    async (_name, impl) => {
      const { response } = httpResponse(413);
      fetchMock.mockResolvedValue(response);
      jest
        .spyOn(globalThis.crypto, "randomUUID")
        .mockImplementation(impl as () => ReturnType<Crypto["randomUUID"]>);
      await expect(
        fetchAgentPartialSaveWithDiagnostic(AGENT_PARTIAL_SAVE_ENDPOINT, {
          body: "{}",
        }),
      ).resolves.toBe(response);
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );
});

describe("shared HTTP 413 lifecycle", () => {
  it("still reads the Agent start app marker once and reports its own event", () => {
    const { beginAgentStartDiagnostic } =
      require("../agent-start-diagnostics") as typeof import("../agent-start-diagnostics");
    const { response, headerGet } = httpResponse(413, {
      "x-hackerai-agent-start-rejection": "trigger_payload_too_large",
    });
    beginAgentStartDiagnostic("{}").onHttpErrorResponse?.(response);
    expect(headerGet.mock.calls.map(([name]) => name)).toEqual([
      "x-hackerai-agent-start-rejection",
      "x-vercel-error",
      "x-vercel-id",
    ]);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][0]).toBe("agent_start_http413_diagnostic");
    expect(mockCapture.mock.calls[0][1]).toMatchObject({
      app_rejection_marker_state: "known",
      request_body_state: "measured",
      request_body_utf8_bytes: 2,
    });
    expect(mockCapture.mock.calls[0][1]).not.toHaveProperty(
      "request_body_utf8_bucket",
    );
  });
});

describe("attempt tracking lifetime", () => {
  it("unsubscribes after success, other status, 413 and rejection", async () => {
    const listeners = new Set<() => void>();
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/analytics/client", () => ({
        captureQueuedAuthenticatedEvent: jest.fn(),
        getIdentifiedAnalyticsUserId: () => "user-a",
        getPermittedAnalyticsUserId: () => "user-a",
        subscribeAuthenticatedAnalytics: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }));
      const isolated =
        require("../agent-partial-save-diagnostics") as typeof import("../agent-partial-save-diagnostics");
      const outcomes: (() => Promise<Response>)[] = [
        async () => httpResponse(200).response,
        async () => httpResponse(400).response,
        async () => httpResponse(413).response,
        async () => {
          throw new TypeError("Failed to fetch");
        },
      ];
      for (const outcome of outcomes) {
        let inFlight = 0;
        fetchMock.mockImplementationOnce(() => {
          inFlight = listeners.size;
          return outcome();
        });
        await isolated
          .fetchAgentPartialSaveWithDiagnostic(AGENT_PARTIAL_SAVE_ENDPOINT, {
            body: "{}",
          })
          .catch(() => undefined);
        expect(inFlight).toBe(1);
        expect(listeners.size).toBe(0);
      }
    });
  });
});

describe("partial-save writer source", () => {
  it("routes the sole chat partial-save POST through the diagnostic wrapper", () => {
    const chatSource = fs.readFileSync(
      path.join(process.cwd(), "app/components/chat.tsx"),
      "utf8",
    );
    // Only the queued writer posts the snapshot; a direct fetch would bypass it.
    expect(chatSource).not.toMatch(/fetch\(\s*AGENT_PARTIAL_SAVE_ENDPOINT/);
    expect(chatSource.match(/AGENT_PARTIAL_SAVE_ENDPOINT/g)?.length ?? 0).toBe(
      2,
    );
    expect(chatSource).toMatch(
      /agentLongPartialSavesRef\.current\.save\(\s*chatId,\s*saveKey,\s*async \(\) => \{\s*return fetchAgentPartialSaveWithDiagnostic\(\s*AGENT_PARTIAL_SAVE_ENDPOINT,\s*\{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: requestBody,\s*\},\s*\);/,
    );
  });
});
