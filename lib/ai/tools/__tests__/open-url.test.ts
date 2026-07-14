jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

import { phLogger } from "@/lib/posthog/server";
import { createOpenUrlTool } from "../open-url";

async function runTool(
  tool: ReturnType<typeof createOpenUrlTool>,
  input: Record<string, unknown>,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;

  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

describe("open_url", () => {
  const originalFetch = global.fetch;
  const mockPhLoggerWarn = phLogger.warn as jest.MockedFunction<
    typeof phLogger.warn
  >;
  const mockPhLoggerError = phLogger.error as jest.MockedFunction<
    typeof phLogger.error
  >;

  beforeEach(() => {
    process.env.JINA_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JINA_API_KEY;
    jest.clearAllMocks();
  });

  it("logs expected Jina network timeouts as warnings without raw error objects", async () => {
    const onToolFailure = jest.fn();
    const timeoutError = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: { errors: [timeoutError] },
    });
    global.fetch = jest.fn().mockRejectedValue(fetchError);

    const result = await runTool(
      createOpenUrlTool({ chatId: "chat-1", onToolFailure, userID: "user-1" }),
      {
        url: "https://example.com/private-path?token=secret",
        brief: "open example page",
      },
    );

    expect(result).toBe(
      "Error opening URL: The URL reader timed out or could not reach the page. Do not retry the same URL unless the user asks.",
    );
    expect(mockPhLoggerWarn).toHaveBeenCalledWith(
      "Open URL provider fetch failed",
      expect.objectContaining({
        chat_id: "chat-1",
        error_code: "ETIMEDOUT",
        error_message: "fetch failed",
        error_name: "TypeError",
        event: "open_url_fetch_failed",
        provider: "jina",
        url_hostname: "example.com",
        userId: "user-1",
      }),
    );
    expect(onToolFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        duration_ms: expect.any(Number),
        error_code: "ETIMEDOUT",
        error_message: "fetch failed",
        error_name: "TypeError",
        event: "open_url_fetch_failed",
        provider: "jina",
        tool_name: "open_url",
        url_hostname: "example.com",
      }),
    );
    expect(mockPhLoggerError).not.toHaveBeenCalled();
    const loggedPayloads = JSON.stringify([
      mockPhLoggerWarn.mock.calls,
      onToolFailure.mock.calls,
    ]);
    expect(loggedPayloads).not.toContain("private-path");
    expect(loggedPayloads).not.toContain("secret");
  });

  it("reports non-OK Jina HTTP responses to the tool failure hook", async () => {
    const onToolFailure = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: jest.fn(async () => "upstream down"),
    });

    const result = await runTool(
      createOpenUrlTool({ chatId: "chat-1", onToolFailure, userID: "user-1" }),
      {
        url: "https://example.com/advisory",
        brief: "open example page",
      },
    );

    expect(result).toBe("Error: HTTP 502 - upstream down");
    expect(onToolFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        duration_ms: expect.any(Number),
        error_message: "HTTP 502",
        event: "open_url_provider_failed",
        provider: "jina",
        status: 502,
        status_text: "Bad Gateway",
        tool_name: "open_url",
        url_hostname: "example.com",
      }),
    );
  });

  it("keeps unexpected tool exceptions as errors", async () => {
    const onToolFailure = jest.fn();
    global.fetch = jest.fn().mockRejectedValue(new Error("unexpected boom"));

    const result = await runTool(createOpenUrlTool({ onToolFailure }), {
      url: "not-a-url",
      brief: "open malformed page",
    });

    expect(result).toBe("Error opening URL: unexpected boom");
    expect(mockPhLoggerWarn).not.toHaveBeenCalled();
    expect(onToolFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        duration_ms: expect.any(Number),
        error_message: "unexpected boom",
        error_name: "Error",
        event: "open_url_tool_failed",
        provider: "jina",
        tool_name: "open_url",
        url_hostname: "invalid_url",
      }),
    );
    expect(mockPhLoggerError).toHaveBeenCalledWith(
      "Open URL tool error",
      expect.objectContaining({
        error_message: "unexpected boom",
        error_name: "Error",
        event: "open_url_tool_failed",
        provider: "jina",
        url_hostname: "invalid_url",
      }),
    );
  });
});
