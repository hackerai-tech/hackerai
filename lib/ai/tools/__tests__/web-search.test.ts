import type { ToolContext } from "@/types";
import { createWebSearch } from "../web-search";
import { summarizePerplexityErrorBody } from "../utils/perplexity";

const HTML_504 = `
<html>
  <body>
    <h1>Sorry! There was a server error while processing your request.</h1>
    <h2>Please try again shortly.</h2>
    <div class="cf-error-details cf-error-504">
      <h1>Gateway time-out</h1>
      <p>The web server reported a gateway time-out error.</p>
      <ul>
        <li>Ray ID: a0611dc9caa93928</li>
        <li>Your IP address: 54.81.73.203</li>
        <li>Error reference number: 504</li>
      </ul>
    </div>
  </body>
</html>`;

function makeContext(
  onToolCost = jest.fn(),
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    userLocation: { country: "US" },
    onToolCost,
    ...overrides,
  } as unknown as ToolContext;
}

async function runTool(
  tool: ReturnType<typeof createWebSearch>,
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

function response(
  body: string,
  init: {
    headers?: Record<string, string>;
    status: number;
    statusText?: string;
  },
): Response {
  const headers = new Map(
    Object.entries(init.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );

  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: init.statusText || "",
    headers: {
      get: (key: string) => headers.get(key.toLowerCase()) || null,
    },
    text: jest.fn(async () => body),
    json: jest.fn(async () => JSON.parse(body)),
  } as unknown as Response;
}

describe("web_search", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = "test-key";
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PERPLEXITY_API_KEY;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sanitizes Perplexity HTML error bodies", () => {
    const summary = summarizePerplexityErrorBody(HTML_504, "text/html");

    expect(summary).toContain("Gateway time-out");
    expect(summary).toContain("gateway time-out error");
    expect(summary).not.toContain("<html");
    expect(summary).not.toContain("54.81.73.203");
    expect(summary).not.toContain("a0611dc9caa93928");
  });

  it("returns a validation message for blank queries without calling Perplexity or logging", async () => {
    const onToolCost = jest.fn();
    const onToolFailure = jest.fn();
    global.fetch = jest.fn();

    const result = await runTool(
      createWebSearch(makeContext(onToolCost, { onToolFailure })),
      {
        queries: ["", "   ", "\n"],
        brief: "search with blank input",
      },
    );

    expect(result).toBe(
      "Error performing web search: Provide at least one non-empty query.",
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onToolCost).not.toHaveBeenCalled();
    expect(onToolFailure).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("trims and drops blank query variants before calling Perplexity", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response(
        JSON.stringify({
          id: "search-1",
          results: [
            {
              title: "Perplexity status",
              url: "https://status.perplexity.ai",
              snippet: "Service status page",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = await runTool(createWebSearch(makeContext()), {
      queries: [" ", " perplexity status ", "\n"],
      brief: "check provider status",
    });

    const requestInit = (global.fetch as jest.Mock).mock
      .calls[0][1] as RequestInit;
    expect(JSON.parse(requestInit.body as string)).toMatchObject({
      query: "perplexity status",
    });
    expect(result).toEqual([
      {
        title: "Perplexity status",
        url: "https://status.perplexity.ai",
        content: "Service status page",
        date: null,
        lastUpdated: null,
      },
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects overlong queries without calling Perplexity or logging", async () => {
    const onToolCost = jest.fn();
    const onToolFailure = jest.fn();
    global.fetch = jest.fn();

    const result = await runTool(
      createWebSearch(makeContext(onToolCost, { onToolFailure })),
      {
        queries: ["x".repeat(8193)],
        brief: "search with overlong input",
      },
    );

    expect(result).toBe(
      "Error performing web search: Each query must be 8192 characters or fewer.",
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onToolCost).not.toHaveBeenCalled();
    expect(onToolFailure).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retries a transient 504 and returns results when a later attempt succeeds", async () => {
    jest.useFakeTimers();

    const onToolCost = jest.fn();
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response(HTML_504, {
          status: 504,
          statusText: "Gateway Timeout",
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            id: "search-1",
            results: [
              {
                title: "Perplexity status",
                url: "https://status.perplexity.ai",
                snippet: "Service status page",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const resultPromise = runTool(createWebSearch(makeContext(onToolCost)), {
      queries: ["perplexity status"],
      brief: "check provider status",
    });
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        title: "Perplexity status",
        url: "https://status.perplexity.ai",
        content: "Service status page",
        date: null,
        lastUpdated: null,
      },
    ]);
    expect(onToolCost).toHaveBeenCalledWith(0.005);
    expect(console.warn).toHaveBeenCalledWith(
      "Web search provider error; retrying",
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        status: 504,
        bodySummary: expect.stringContaining("Gateway time-out"),
      }),
    );
  });

  it("returns a compact fallback message after repeated 504s", async () => {
    jest.useFakeTimers();
    const onToolFailure = jest.fn();

    global.fetch = jest.fn().mockResolvedValue(
      response(HTML_504, {
        status: 504,
        statusText: "Gateway Timeout",
        headers: { "content-type": "text/html" },
      }),
    );

    const resultPromise = runTool(
      createWebSearch(makeContext(jest.fn(), { onToolFailure })),
      {
        queries: ["perplexity status"],
        brief: "check provider status",
      },
    );
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(result).toBe(
      "Error performing web search: Perplexity search is temporarily unavailable (HTTP 504 Gateway Timeout after 3 attempts). Please retry shortly or continue without live web results if the task can proceed.",
    );
    expect(result).not.toContain("<html");
    expect(result).not.toContain("54.81.73.203");

    expect(console.error).toHaveBeenCalledWith(
      "Web search tool error:",
      expect.objectContaining({
        name: "PerplexityApiError",
        status: 504,
        retryable: true,
        bodySummary: expect.stringContaining("Gateway time-out"),
      }),
    );
    expect(onToolFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 3,
        body_summary: expect.stringContaining("Gateway time-out"),
        event: "web_search_provider_failed",
        provider: "perplexity",
        retryable: true,
        status: 504,
        status_text: "Gateway Timeout",
        tool_name: "web_search",
      }),
    );
    const loggedPayload = (console.error as jest.Mock).mock.calls[0][1] as {
      bodySummary: string;
    };
    expect(loggedPayload.bodySummary).not.toContain("<html");
    expect(loggedPayload.bodySummary).not.toContain("54.81.73.203");
  });

  it("does not retry authorization failures", async () => {
    const onToolFailure = jest.fn();
    global.fetch = jest.fn().mockResolvedValue(
      response(JSON.stringify({ error: "invalid api key" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await runTool(
      createWebSearch(makeContext(jest.fn(), { onToolFailure })),
      {
        queries: ["perplexity status"],
        brief: "check provider status",
      },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(
      "Error performing web search: Perplexity search is not authorized (HTTP 401 Unauthorized). Check the Perplexity API key or account access.",
    );
    expect(onToolFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        body_summary: expect.stringContaining("invalid api key"),
        event: "web_search_provider_failed",
        provider: "perplexity",
        retryable: false,
        status: 401,
        status_text: "Unauthorized",
        tool_name: "web_search",
      }),
    );
  });

  it("sanitizes non-retry provider failure details before logging or returning", async () => {
    const esc = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const rawBody = JSON.stringify({
      error: `${esc}[31mapi_key=provider-secret${bell} from 54.81.73.203 Ray ID: a0611dc9caa93928`,
    });

    global.fetch = jest.fn().mockResolvedValue(
      response(rawBody, {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await runTool(createWebSearch(makeContext()), {
      queries: ["perplexity status"],
      brief: "check provider status",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toBe(
      "Error performing web search: Perplexity search failed (HTTP 400 Bad Request).",
    );
    expect(result).not.toContain("provider-secret");
    expect(result).not.toContain("54.81.73.203");
    expect(result).not.toContain("a0611dc9caa93928");

    expect(console.error).toHaveBeenCalledWith(
      "Web search tool error:",
      expect.objectContaining({
        name: "PerplexityApiError",
        status: 400,
        retryable: false,
      }),
    );
    const loggedPayload = (console.error as jest.Mock).mock.calls[0][1] as {
      bodySummary: string;
    };
    expect(loggedPayload.bodySummary).toContain('api_key="[Redacted]"');
    expect(loggedPayload.bodySummary).toContain("[Redacted IP]");
    expect(loggedPayload.bodySummary).toContain("Ray ID: [Redacted]");
    expect(loggedPayload.bodySummary).not.toContain(esc);
    expect(loggedPayload.bodySummary).not.toContain(bell);
    expect(loggedPayload.bodySummary).not.toContain("provider-secret");
    expect(loggedPayload.bodySummary).not.toContain("54.81.73.203");
  });
});
