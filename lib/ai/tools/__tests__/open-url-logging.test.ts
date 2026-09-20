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
    controller.abort();
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
