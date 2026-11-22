import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCaptureException = jest.fn();
const mockEmitPostHogLog = jest.fn<(_record: unknown) => boolean>(() => true);

jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ captureException: mockCaptureException }),
}));
jest.mock("@/lib/posthog/logs", () => ({
  emitPostHogLog: mockEmitPostHogLog,
}));

const { createOpenUrlTool } =
  require("../open-url") as typeof import("../open-url");

describe("Open URL failure capture through phLogger", () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn<typeof fetch>();

  const runTool = (onToolFailure = jest.fn(), abortSignal?: AbortSignal) =>
    createOpenUrlTool({
      chatId: "chat_123",
      userID: "user_123",
      onToolFailure,
    }).execute!(
      {
        url: "https://example.com/private-path?token=synthetic",
        brief: "Read",
      },
      { toolCallId: "call_123", messages: [], abortSignal },
    );

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    [
      new RangeError("Invalid string length"),
      "RangeError",
      "Invalid string length",
    ],
    ["unexpected reader failure", "UnknownError", "unexpected reader failure"],
  ])(
    "preserves the original sanitized exception details: %s",
    async (error, name, message) => {
      mockFetch.mockRejectedValue(error);
      const onToolFailure = jest.fn();

      await expect(runTool(onToolFailure)).resolves.toBe(
        `Error opening URL: ${message}`,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [exception, distinctId, properties] = mockCaptureException.mock
        .calls[0] as [Error, string, Record<string, unknown>];
      const log = mockEmitPostHogLog.mock.calls[0][0] as {
        body: string;
        attributes: Record<string, unknown>;
      };
      const cause = {
        event: "open_url_tool_failed",
        provider: "jina",
        chat_id: "chat_123",
        tool_error_name: name,
        tool_error_message: message,
      };
      expect(properties).toMatchObject(cause);
      expect(log.attributes).toMatchObject(cause);
      expect(distinctId).toBe("user_123");
      expect(exception).toMatchObject({ name, message });
      expect(properties.error_message).toBe(exception.message);
      expect(onToolFailure).toHaveBeenCalledWith(
        expect.objectContaining({ error_name: name, error_message: message }),
      );
    },
  );

  it("redacts before bounding cause fields and excludes raw error payloads", async () => {
    const error = Object.assign(
      new Error(
        `reader failed https://bucket.s3.amazonaws.com/private-file?X-Amz-Signature=synthetic-signature serviceKey=synthetic-key ${"x".repeat(3000)}`,
      ),
      {
        name: `ReaderError ${"x".repeat(200)}`,
        responseBody: "PRIVATE_RESPONSE",
        cause: { payload: "PRIVATE_CAUSE" },
      },
    );
    mockFetch.mockRejectedValue(error);
    await runTool();

    const properties = mockCaptureException.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(properties.tool_error_name).toHaveLength(128);
    expect(properties.tool_error_message).toHaveLength(2000);
    const captured = JSON.stringify([
      mockCaptureException.mock.calls,
      mockEmitPostHogLog.mock.calls,
    ]);
    expect(captured).toContain("[Redacted signed URL]");
    expect(captured).toContain("[Redacted]");
    for (const value of [
      "synthetic-signature",
      "synthetic-key",
      "private-file",
      "private-path",
      "PRIVATE_RESPONSE",
      "PRIVATE_CAUSE",
    ]) {
      expect(captured).not.toContain(value);
    }
  });

  it("keeps network failures as warnings with their cause and code", async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ETIMEDOUT" },
      }),
    );
    await expect(runTool()).resolves.toContain("The URL reader timed out");
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockEmitPostHogLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        attributes: expect.objectContaining({
          event: "open_url_fetch_failed",
          tool_error_name: "TypeError",
          tool_error_message: "fetch failed",
          error_code: "ETIMEDOUT",
        }),
      }),
    );
  });

  it("keeps cancellation silent and forwards the signal", async () => {
    const controller = new AbortController();
    mockFetch.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const onToolFailure = jest.fn();
    await expect(runTool(onToolFailure, controller.signal)).resolves.toBe(
      "Error: Operation aborted",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockEmitPostHogLog).not.toHaveBeenCalled();
    expect(onToolFailure).not.toHaveBeenCalled();
  });

  describe("in-flight abort stage", () => {
    const URL = "https://example.com/private-path?token=synthetic";
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const abortError = () =>
      Object.assign(new Error("aborted"), { name: "AbortError" });
    const createTool = (onToolFailure = jest.fn()) =>
      createOpenUrlTool({
        chatId: "chat_123",
        userID: "user_123",
        assistantMessageId: "assistant_msg_123",
        onToolFailure,
      });
    const run = (
      openUrl: ReturnType<typeof createTool>,
      abortSignal: AbortSignal,
      cursor?: string,
    ) =>
      openUrl.execute!(
        { url: URL, brief: "Read", ...(cursor && { cursor }) },
        { toolCallId: "call_123", messages: [], abortSignal },
      ) as Promise<string>;
    const stageLogs = () =>
      mockEmitPostHogLog.mock.calls
        .map(
          ([record]) =>
            record as { level: string; attributes: Record<string, unknown> },
        )
        .filter((r) => r.attributes.event === "open_url_in_flight_aborted");

    it("reports the header and body phases before the provider settles", async () => {
      const onToolFailure = jest.fn();
      const openUrl = createTool(onToolFailure);

      const headers = deferred<Response>();
      mockFetch.mockReturnValueOnce(headers.promise);
      const headerController = new AbortController();
      const headerRun = run(openUrl, headerController.signal);
      headerController.abort(new Error("PRIVATE_REASON"));

      // Receipt is recorded while fetch is still pending.
      expect(stageLogs()).toHaveLength(1);
      expect(stageLogs()[0]).toMatchObject({
        level: "info",
        attributes: {
          event: "open_url_in_flight_aborted",
          tool_name: "open_url",
          provider: "jina",
          phase: "awaiting_headers",
          elapsed_ms: expect.any(Number),
          assistant_message_id: "assistant_msg_123",
        },
      });
      headers.reject(abortError());
      await expect(headerRun).resolves.toBe("Error: Operation aborted");

      const body = deferred<string>();
      const reading = deferred<void>();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => {
          reading.resolve();
          return body.promise;
        },
      } as unknown as Response);
      const bodyController = new AbortController();
      const bodyRun = run(openUrl, bodyController.signal);
      await reading.promise;
      bodyController.abort();

      expect(stageLogs()).toHaveLength(2);
      expect(stageLogs()[1].attributes.phase).toBe("reading_body");
      body.reject(abortError());
      await expect(bodyRun).resolves.toBe("Error: Operation aborted");

      // A repeated phase on the same tool instance stays bounded.
      const repeatedHeaders = deferred<Response>();
      mockFetch.mockReturnValueOnce(repeatedHeaders.promise);
      const repeatController = new AbortController();
      const repeatRun = run(openUrl, repeatController.signal);
      repeatController.abort();
      expect(stageLogs()).toHaveLength(2);
      repeatedHeaders.reject(abortError());
      await expect(repeatRun).resolves.toBe("Error: Operation aborted");

      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(onToolFailure).not.toHaveBeenCalled();
      expect(mockEmitPostHogLog).toHaveBeenCalledTimes(2);
      const logged = JSON.stringify(mockEmitPostHogLog.mock.calls);
      for (const value of [
        "example.com",
        "private-path",
        "synthetic",
        "PRIVATE_REASON",
        "call_123",
        "chat_123",
        "user_123",
      ]) {
        expect(logged).not.toContain(value);
      }
    });

    it("distinguishes discarding a non-success body and keeps provider failure handling", async () => {
      const onToolFailure = jest.fn();
      const cancel = deferred<void>();
      const discarding = deferred<void>();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        body: {
          cancel: () => {
            discarding.resolve();
            return cancel.promise;
          },
        },
      } as unknown as Response);
      const controller = new AbortController();
      const result = run(createTool(onToolFailure), controller.signal);
      await discarding.promise;
      controller.abort();

      expect(stageLogs()).toHaveLength(1);
      expect(stageLogs()[0].attributes.phase).toBe("discarding_error_body");
      cancel.resolve();
      await expect(result).resolves.toBe(
        "Error opening URL: The URL reader request failed (HTTP 503).",
      );
      expect(onToolFailure).toHaveBeenCalledTimes(1);
      expect(onToolFailure).toHaveBeenCalledWith(
        expect.objectContaining({ event: "open_url_provider_failed" }),
      );
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("does not report aborts after completion, before invocation, or on cached pages", async () => {
      const openUrl = createTool();
      const content = `Title: Example\n\nMarkdown Content:\n${"word ".repeat(20_000)}`;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => content,
      } as unknown as Response);
      const succeeded = new AbortController();
      const first = await run(openUrl, succeeded.signal);
      succeeded.abort();
      const cursor = first.match(/cursor="([\w-]+)"/)?.[1];
      expect(cursor).toBeDefined();

      const cached = new AbortController();
      await expect(run(openUrl, cached.signal, cursor)).resolves.toContain(
        "[Page content tokens",
      );
      cached.abort();

      mockFetch.mockRejectedValueOnce(new RangeError("Invalid string length"));
      const failed = new AbortController();
      await run(openUrl, failed.signal);
      failed.abort();

      const preAborted = new AbortController();
      preAborted.abort();
      await expect(run(openUrl, preAborted.signal)).resolves.toBe(
        "Error: Operation aborted",
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(stageLogs()).toHaveLength(0);
    });
  });

  it.each(["run cancelled", "Canceled by user"])(
    "keeps runtime cancellation silent: %s",
    async (error) => {
      mockFetch.mockRejectedValue(error);
      const onToolFailure = jest.fn();

      await expect(runTool(onToolFailure)).resolves.toBe(
        "Error: Operation aborted",
      );

      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockEmitPostHogLog).not.toHaveBeenCalled();
      expect(onToolFailure).not.toHaveBeenCalled();
    },
  );
});
