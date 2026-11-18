import {
  cancelAgentLongRealtimeStreams,
  fetchAgentLongStream,
  getPendingAgentLongRunStart,
} from "../agent-long-transport";
import {
  readTriggerRunStream,
  retrieveTriggerRunStatus,
} from "../trigger-browser-realtime";

import {
  confirmAuthenticatedAnalyticsUserId,
  loadPostHogClient,
  setAuthenticatedAnalyticsUserId,
} from "@/lib/analytics/client";
import { ChatSDKError } from "@/lib/errors";

jest.mock("../trigger-browser-realtime", () => ({
  readTriggerRunStream: jest.fn(),
  retrieveTriggerRunStatus: jest.fn(),
}));
const mockCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { __loaded: true, capture: mockCapture },
}));

const pendingResponse = () => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const handleResponse = (runId: string) =>
  ({
    ok: true,
    json: async () => ({ runId, publicAccessToken: "synthetic" }),
  }) as Response;
const init = (signal?: AbortSignal) => ({
  method: "POST",
  body: JSON.stringify({ chatId: "handoff-chat" }),
  signal,
});

beforeEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: jest.fn(),
  });
});

it("does not start a request that was already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchAgentLongStream(init(controller.signal)),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("navigation detaches a pending start without canceling durable work or attaching stale UI", async () => {
  const pending = pendingResponse();
  jest.mocked(fetch).mockReturnValueOnce(pending.promise);
  const onRunStarted = jest.fn();
  const response = fetchAgentLongStream(init(), onRunStarted).catch(
    (error) => error,
  );
  const handoff = getPendingAgentLongRunStart("handoff-chat");
  cancelAgentLongRealtimeStreams("handoff-chat");
  pending.resolve(handleResponse("run-navigation"));
  expect(await handoff).toMatchObject({ runId: "run-navigation" });
  expect(await response).toMatchObject({ name: "AbortError" });
  expect(onRunStarted).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("an older start finishing does not remove a newer pending start", async () => {
  const first = pendingResponse();
  const second = pendingResponse();
  jest
    .mocked(fetch)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const oldResponse = fetchAgentLongStream(init()).catch((error) => error);
  const oldHandoff = getPendingAgentLongRunStart("handoff-chat");
  const newResponse = fetchAgentLongStream(init()).catch((error) => error);
  cancelAgentLongRealtimeStreams("handoff-chat");
  first.resolve(handleResponse("run-old"));
  expect(await oldHandoff).toMatchObject({ runId: "run-old" });
  await oldResponse;
  const newHandoff = getPendingAgentLongRunStart("handoff-chat");
  expect(newHandoff).toBeDefined();
  second.resolve(handleResponse("run-new"));
  expect(await newHandoff).toMatchObject({ runId: "run-new" });
  await newResponse;
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("acknowledges durable admission after detachment without attaching stale UI or replaying the POST", async () => {
  const pending = pendingResponse();
  jest.mocked(fetch).mockReturnValueOnce(pending.promise);
  const onRunStarted = jest.fn();
  const onRunAdmitted = jest.fn();
  const response = fetchAgentLongStream(
    init(),
    onRunStarted,
    undefined,
    onRunAdmitted,
  ).catch((error) => error);
  cancelAgentLongRealtimeStreams("handoff-chat");
  pending.resolve(handleResponse("run-admitted-before-detach"));
  expect(await response).toMatchObject({ name: "AbortError" });
  expect(onRunAdmitted).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: "handoff-chat",
      runId: "run-admitted-before-detach",
    }),
  );
  expect(onRunStarted).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("surfaces a failed start to Stop and releases the pending handle", async () => {
  const pending = pendingResponse();
  jest.mocked(fetch).mockReturnValueOnce(pending.promise);
  const response = fetchAgentLongStream(init()).catch((error) => error);
  const handoff = getPendingAgentLongRunStart("handoff-chat")!.catch(
    (error) => error,
  );
  pending.reject(new Error("Synthetic network failure"));
  expect(await response).toMatchObject({
    message: "Synthetic network failure",
  });
  expect(await handoff).toMatchObject({ message: "Synthetic network failure" });
  expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
});

it("preserves a slow startup handle beyond the old browser deadline", async () => {
  jest.useFakeTimers();
  try {
    const pending = pendingResponse();
    jest.mocked(fetch).mockReturnValueOnce(pending.promise);
    const response = fetchAgentLongStream(init()).catch((error) => error);
    const handoff = getPendingAgentLongRunStart("handoff-chat");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(jest.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(getPendingAgentLongRunStart("handoff-chat")).toBeDefined();
    // A detached UI still hands Stop the exact durable run that just started.
    cancelAgentLongRealtimeStreams("handoff-chat");
    pending.resolve(handleResponse("run-slow-start"));
    expect(await handoff).toMatchObject({ runId: "run-slow-start" });
    expect(await response).toMatchObject({ name: "AbortError" });
    expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it("bounds a stalled start even when the request ignores its abort signal", async () => {
  jest.useFakeTimers();
  try {
    jest.mocked(fetch).mockReturnValueOnce(new Promise(() => {}));
    const response = fetchAgentLongStream(init()).catch((error) => error);
    const handoff = getPendingAgentLongRunStart("handoff-chat")!.catch(
      (error) => error,
    );
    await jest.advanceTimersByTimeAsync(75_000);
    expect(await response).toMatchObject({
      message: expect.stringContaining("Agent startup timed out"),
    });
    expect(await handoff).toBe(await response);
    expect(jest.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it.each(["finish", "abort"])(
  "reports the exact closing run once for a %s stream",
  async (terminalType) => {
    const originalResponse = globalThis.Response;
    // jsdom lacks Response; the real stream still drives lifecycle callbacks.
    globalThis.Response = class {
      constructor(public body: ReadableStream<Uint8Array>) {}
    } as unknown as typeof Response;
    try {
      jest.mocked(fetch).mockResolvedValueOnce(handleResponse("run-closing"));
      jest.mocked(retrieveTriggerRunStatus).mockResolvedValue("EXECUTING");
      jest.mocked(readTriggerRunStream).mockReturnValue(
        (async function* () {
          yield { type: terminalType };
        })(),
      );
      const onRunClosed = jest.fn();
      const response = await fetchAgentLongStream(
        init(),
        undefined,
        onRunClosed,
      );
      const reader = response.body!.getReader();
      while (!(await reader.read()).done) {
        /* Drain the real stream. */
      }
      expect(onRunClosed).toHaveBeenCalledTimes(1);
      expect(onRunClosed).toHaveBeenCalledWith("run-closing");
    } finally {
      globalThis.Response = originalResponse;
    }
  },
);

it("keeps the original run after a temporary status 503 and polls again on its cadence", async () => {
  const originalResponse = globalThis.Response;
  // jsdom lacks Response; the real stream still drives lifecycle callbacks.
  globalThis.Response = class {
    constructor(public body: ReadableStream<Uint8Array>) {}
  } as unknown as typeof Response;
  jest.useFakeTimers();
  try {
    jest.mocked(fetch).mockResolvedValueOnce(handleResponse("run-polled"));
    // The status route's bounded ownership read timed out once.
    jest
      .mocked(retrieveTriggerRunStatus)
      .mockRejectedValueOnce(
        new Error("Trigger run status request failed: 503"),
      )
      .mockResolvedValueOnce("EXECUTING")
      .mockResolvedValueOnce("CANCELED");
    // A quiet stream that stays open until the reader is aborted.
    jest
      .mocked(readTriggerRunStream)
      .mockImplementation((_runId, _streamId, options) =>
        (async function* () {
          await new Promise((resolve) =>
            options.signal?.addEventListener("abort", resolve, { once: true }),
          );
        })(),
      );
    const onRunClosed = jest.fn();
    const response = await fetchAgentLongStream(init(), undefined, onRunClosed);
    await jest.advanceTimersByTimeAsync(0);
    expect(retrieveTriggerRunStatus).toHaveBeenCalledTimes(1);
    expect(onRunClosed).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(9_999);
    expect(retrieveTriggerRunStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(retrieveTriggerRunStatus).toHaveBeenCalledTimes(2);
    expect(onRunClosed).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    // Every poll asks about the same run; only a real terminal status ends it.
    expect(
      jest.mocked(retrieveTriggerRunStatus).mock.calls.map(([runId]) => runId),
    ).toEqual(["run-polled", "run-polled", "run-polled"]);
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) {
      /* Drain the real stream. */
    }
    expect(onRunClosed).toHaveBeenCalledTimes(1);
    expect(onRunClosed).toHaveBeenCalledWith("run-polled");
  } finally {
    jest.useRealTimers();
    globalThis.Response = originalResponse;
  }
});

describe("Agent start HTTP 413 diagnostics", () => {
  const EVENT = "agent_start_http413_diagnostic";
  const REQUEST_ID = "iad1::8x2kq-1794094000000-0123456789ab";
  const originalKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const utf8 = (value: string) => new TextEncoder().encode(value).length;
  const identify = (userId: string | null) => {
    setAuthenticatedAnalyticsUserId(userId);
    if (userId) confirmAuthenticatedAnalyticsUserId(userId);
  };
  const diagnostics = () =>
    mockCapture.mock.calls
      .filter(([event]) => event === EVENT)
      .map(([, properties]) => properties as Record<string, unknown>);
  // The fetch boundary: a non-OK response whose body only the parser reads.
  const rejection = ({
    status = 413,
    headers = {},
    json,
    text = "",
  }: {
    status?: number;
    headers?: Record<string, string>;
    json?: unknown;
    text?: string;
  }) => {
    const parsed = jest.fn(async () => {
      if (json === undefined) throw new SyntaxError("Not JSON");
      return json;
    });
    return {
      ok: false,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      clone: jest.fn(() => ({ json: parsed })),
      text: jest.fn(async () => text),
    };
  };
  const startBody = JSON.stringify({
    chatId: "handoff-chat",
    messages: [{ parts: [{ type: "text", text: "PRIVATE_PROMPT €😀" }] }],
  });

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    await loadPostHogClient();
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    else process.env.NEXT_PUBLIC_POSTHOG_KEY = originalKey;
  });

  beforeEach(() => {
    identify("user-a");
    mockCapture.mockClear();
  });

  afterEach(() => identify(null));

  it("reports a route 413 once and rejects with the unchanged JSON error", async () => {
    const response = rejection({
      headers: {
        "x-hackerai-agent-start-rejection": "trigger_payload_too_large",
        "x-vercel-id": REQUEST_ID,
      },
      json: {
        code: "bad_request:api",
        cause: "This Agent request is too large to start.",
      },
    });
    jest.mocked(fetch).mockResolvedValueOnce(response as unknown as Response);
    const startInit = { method: "POST", body: startBody };

    const error = await fetchAgentLongStream(startInit).catch((e) => e);

    expect(error).toBeInstanceOf(ChatSDKError);
    expect(error).toMatchObject({
      type: "bad_request",
      surface: "api",
      cause: "This Agent request is too large to start.",
      statusCode: 413,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetch).mock.calls[0]).toEqual([
      "/api/agent",
      expect.objectContaining({ method: "POST", body: startBody }),
    ]);
    expect(response.clone).toHaveBeenCalledTimes(1);
    expect(response.text).not.toHaveBeenCalled();
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        http_status: 413,
        request_body_state: "measured",
        request_body_utf8_bytes: utf8(startBody),
        app_rejection_marker_state: "known",
        vercel_error_state: "absent",
        platform_request_id_state: "valid",
        platform_request_id: REQUEST_ID,
      }),
    ]);
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      /PRIVATE|handoff-chat|too large/,
    );
    expect(getPendingAgentLongRunStart("handoff-chat")).toBeUndefined();
  });

  it("attributes a plain-text platform 413 without changing its error", async () => {
    const response = rejection({
      headers: { "x-vercel-error": "FUNCTION_PAYLOAD_TOO_LARGE" },
      text: "Request Entity Too Large",
    });
    jest.mocked(fetch).mockResolvedValueOnce(response as unknown as Response);

    const error = await fetchAgentLongStream({
      method: "POST",
      body: startBody,
    }).catch((e) => e);

    expect(error).toMatchObject({
      type: "bad_request",
      surface: "api",
      cause: "Request Entity Too Large",
      statusCode: 413,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.text).toHaveBeenCalledTimes(1);
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        app_rejection_marker_state: "absent",
        vercel_error_state: "known",
        platform_request_id_state: "absent",
      }),
    ]);
  });

  it("measures the body fetch received when the caller's body is an accessor", async () => {
    let reads = 0;
    const accessorInit = {
      method: "POST",
      get body() {
        reads += 1;
        return JSON.stringify({
          chatId: "handoff-chat",
          pad: "é".repeat(reads),
        });
      },
    };
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(rejection({}) as unknown as Response);

    await fetchAgentLongStream(accessorInit).catch((e) => e);

    // The existing chat ID read and request copy; measurement adds no read.
    expect(reads).toBe(3);
    const sentBody = jest.mocked(fetch).mock.calls[0][1]?.body as string;
    expect(diagnostics()).toEqual([
      expect.objectContaining({ request_body_utf8_bytes: utf8(sentBody) }),
    ]);
  });

  it("keeps errors unchanged and silent for malformed headers, other failures, success and aborts", async () => {
    jest.mocked(fetch).mockResolvedValueOnce({
      ...rejection({ status: 413, text: "Too large" }),
      get headers(): Headers {
        throw new Error("PRIVATE");
      },
    } as unknown as Response);
    await expect(
      fetchAgentLongStream({ method: "POST", body: startBody }),
    ).rejects.toMatchObject({ cause: "Too large", statusCode: 413 });
    expect(diagnostics()).toEqual([
      expect.objectContaining({ platform_request_id_state: "unreadable" }),
    ]);
    mockCapture.mockClear();

    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        rejection({ status: 403, text: "Forbidden" }) as unknown as Response,
      );
    await expect(
      fetchAgentLongStream({ method: "POST", body: startBody }),
    ).rejects.toMatchObject({ cause: "Forbidden", statusCode: 403 });

    const pending = pendingResponse();
    jest.mocked(fetch).mockReturnValueOnce(pending.promise);
    const detached = fetchAgentLongStream(init()).catch((e) => e);
    cancelAgentLongRealtimeStreams("handoff-chat");
    pending.resolve(handleResponse("run-success"));
    expect(await detached).toMatchObject({ name: "AbortError" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchAgentLongStream(init(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "GET"],
    ["an absent", undefined],
  ])("observes only an actual POST, not %s method", async (_name, method) => {
    const response = rejection({ text: "Request Entity Too Large" });
    jest.mocked(fetch).mockResolvedValueOnce(response as unknown as Response);

    await expect(
      fetchAgentLongStream({ method, body: startBody }),
    ).rejects.toMatchObject({
      cause: "Request Entity Too Large",
      statusCode: 413,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetch).mock.calls[0][1]).toMatchObject({
      body: startBody,
      ...(method && { method }),
    });
    expect(response.text).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();

    // A lowercase POST is still an Agent start.
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(rejection({}) as unknown as Response);
    await fetchAgentLongStream({ method: "post", body: startBody }).catch(
      (e) => e,
    );
    expect(diagnostics()).toHaveLength(1);
  });

  it("drops a 413 after the owner changes mid-request, even back to the same owner", async () => {
    const pending = pendingResponse();
    jest.mocked(fetch).mockReturnValueOnce(pending.promise);
    const switched = fetchAgentLongStream({
      method: "POST",
      body: startBody,
    }).catch((e) => e);
    identify("user-b");
    identify("user-a");
    pending.resolve(rejection({ text: "Too large" }) as unknown as Response);
    expect(await switched).toMatchObject({ statusCode: 413 });
    expect(mockCapture).not.toHaveBeenCalled();

    // The next attempt has its own owner snapshot and event identity.
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(rejection({}) as unknown as Response);
    await fetchAgentLongStream({ method: "POST", body: startBody }).catch(
      (e) => e,
    );
    expect(diagnostics()).toHaveLength(1);
  });
});
