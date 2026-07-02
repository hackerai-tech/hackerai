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

  beforeEach(() => {
    process.env.JINA_API_KEY = "test-key";
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JINA_API_KEY;
    jest.restoreAllMocks();
  });

  it("logs expected Jina network timeouts as warnings without raw error objects", async () => {
    const timeoutError = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: { errors: [timeoutError] },
    });
    global.fetch = jest.fn().mockRejectedValue(fetchError);

    const result = await runTool(
      createOpenUrlTool({ chatId: "chat-1", userID: "user-1" }),
      {
        url: "https://example.com/private-path?token=secret",
        brief: "open example page",
      },
    );

    expect(result).toBe(
      "Error opening URL: The URL reader timed out or could not reach the page. Do not retry the same URL unless the user asks.",
    );
    expect(console.warn).toHaveBeenCalledWith(
      "Open URL provider fetch failed",
      expect.objectContaining({
        chat_id: "chat-1",
        error_code: "ETIMEDOUT",
        error_message: "fetch failed",
        error_name: "TypeError",
        event: "open_url_fetch_failed",
        level: "warn",
        provider: "jina",
        url_hostname: "example.com",
        user_id: "user-1",
      }),
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(
      JSON.stringify((console.warn as jest.Mock).mock.calls),
    ).not.toContain("private-path");
    expect(
      JSON.stringify((console.warn as jest.Mock).mock.calls),
    ).not.toContain("secret");
  });

  it("keeps unexpected tool exceptions as errors", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("unexpected boom"));

    const result = await runTool(createOpenUrlTool(), {
      url: "not-a-url",
      brief: "open malformed page",
    });

    expect(result).toBe("Error opening URL: unexpected boom");
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Open URL tool error",
      expect.objectContaining({
        error_message: "unexpected boom",
        error_name: "Error",
        event: "open_url_tool_failed",
        level: "error",
        provider: "jina",
        url_hostname: "invalid_url",
      }),
    );
  });
});
