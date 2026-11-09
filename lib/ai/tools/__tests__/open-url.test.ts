jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

import { phLogger } from "@/lib/posthog/server";
import { createOpenUrlTool } from "../open-url";
import { safeCountTokens } from "@/lib/token-utils";

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

  it("retrieves full Markdown and supports continuation through a rebuilt tool", async () => {
    const content =
      "Title: Advisory\n\nMarkdown Content:\n" +
      "Detailed security finding.\n".repeat(7000) +
      "Critical final mitigation.";
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => content });
    const first = (await runTool(createOpenUrlTool(), {
      url: "https://example.com/advisory",
      brief: "Read advisory",
    })) as string;
    expect(safeCountTokens(first)).toBeLessThanOrEqual(12000);
    const cursor = first.match(/cursor="([A-Za-z0-9_-]+)"/)?.[1];
    expect(cursor).toBeDefined();
    const second = (await runTool(createOpenUrlTool(), {
      url: "https://example.com/advisory",
      cursor,
      brief: "Continue advisory",
    })) as string;
    expect(second).toContain("Page content tokens");
    expect(second).not.toContain("Error");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Respond-With": "markdown",
          "X-Retain-Images": "none",
        }),
      }),
    );
  });

  it("reports an upstream error hidden in a successful Reader response without logging page text", async () => {
    const onToolFailure = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        "Title: Not Found\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\nPRIVATE_PAGE_TEXT",
    });
    const result = await runTool(createOpenUrlTool({ onToolFailure }), {
      url: "https://example.com/private-path?token=secret",
      brief: "Read",
    });
    expect(result).toContain("requested page returned HTTP 404");
    expect(onToolFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "open_url_content_unavailable",
        url_hostname: "example.com",
      }),
    );
    expect(JSON.stringify(onToolFailure.mock.calls)).not.toMatch(
      /PRIVATE_PAGE_TEXT|private-path|secret/,
    );
  });

  it("reuses one scoped snapshot for continuation, and honors cancellation before a cache hit", async () => {
    const content =
      "Title: Reference\n\nMarkdown Content:\n" +
      "Important technical details.\n".repeat(7000);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => content });
    const tool = createOpenUrlTool();
    const first = (await runTool(tool, {
      url: "https://example.com/reference",
      brief: "Read",
    })) as string;
    const cursor = first.match(/cursor="([A-Za-z0-9_-]+)"/)?.[1];
    await runTool(tool, {
      url: "https://example.com/reference",
      cursor,
      brief: "Continue",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute!(
        { url: "https://example.com/reference", cursor, brief: "Continue" },
        { toolCallId: "cancel", messages: [], abortSignal: controller.signal },
      ),
    ).resolves.toBe("Error: Operation aborted");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // A different instance does not reuse another chat's document.
    await runTool(createOpenUrlTool(), {
      url: "https://example.com/reference",
      cursor,
      brief: "Resume",
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("refetches an expired snapshot and rejects a continuation when the page changed", async () => {
    const now = jest.spyOn(Date, "now");
    try {
      now.mockReturnValue(1000);
      const content = "Reference details.\n".repeat(15000);
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, text: async () => content })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => content + "Updated mitigation.",
        });
      const tool = createOpenUrlTool();
      const first = (await runTool(tool, {
        url: "https://example.com/reference",
        brief: "Read",
      })) as string;
      const cursor = first.match(/cursor="([A-Za-z0-9_-]+)"/)?.[1];
      now.mockReturnValue(1000 + 5 * 60_000 + 1);
      const next = await runTool(tool, {
        url: "https://example.com/reference",
        cursor,
        brief: "Continue",
      });
      expect(next).toContain("Page content changed");
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
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
        tool_error_message: "fetch failed",
        tool_error_name: "TypeError",
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

    expect(result).toBe(
      "Error opening URL: The URL reader request failed (HTTP 502).",
    );
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

  it("bounds provider failures without returning the raw error page", async () => {
    const body = { cancel: jest.fn(async () => {}) };
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      body,
      text: async () => "PRIVATE_ERROR_PAGE".repeat(50000),
    });
    const result = (await runTool(createOpenUrlTool(), {
      url: "https://example.com",
      brief: "Read",
    })) as string;
    expect(result).toContain("HTTP 502");
    expect(result).not.toContain("PRIVATE_ERROR_PAGE");
    expect(safeCountTokens(result)).toBeLessThanOrEqual(12000);
    expect(body.cancel).toHaveBeenCalled();
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
        error: expect.objectContaining({
          message: "unexpected boom",
          name: "Error",
        }),
        tool_error_message: "unexpected boom",
        tool_error_name: "Error",
        event: "open_url_tool_failed",
        provider: "jina",
        url_hostname: "invalid_url",
      }),
    );
  });
});
