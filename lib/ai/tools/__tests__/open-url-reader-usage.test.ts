jest.mock("@/lib/posthog/server", () => ({
  phLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { createOpenUrlTool, parseReaderUsageTokens } from "../open-url";

const runTool = (
  context: Parameters<typeof createOpenUrlTool>[0],
  abortSignal?: AbortSignal,
) =>
  (
    createOpenUrlTool(context) as unknown as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    }
  ).execute(
    { url: "https://example.com/", brief: "open example page" },
    { toolCallId: "call-1", abortSignal, messages: [] },
  );

// jsdom lacks Response; keep the real Headers so parsing matches fetch.
const readerResponse = (
  body: string,
  headers: Record<string, string>,
  status = 200,
) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "",
  headers: new Headers(headers),
  text: jest.fn(async () => body),
});

describe("Jina Reader usage meter", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    ["1234", 1234],
    [" 42 ", 42],
    ["0", 0],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("accepts x-usage-tokens %j as %j", (header, expected) => {
    expect(
      parseReaderUsageTokens(new Headers({ "X-Usage-Tokens": header })),
    ).toBe(expected);
  });

  it.each([
    "",
    "-1",
    "1.5",
    "1e3",
    "0x10",
    "12, 13",
    "NaN",
    "9007199254740993",
  ])("treats x-usage-tokens %j as unreported", (header) => {
    expect(
      parseReaderUsageTokens(new Headers({ "x-usage-tokens": header })),
    ).toBeUndefined();
  });

  it("treats a missing header as unreported", () => {
    expect(parseReaderUsageTokens(new Headers())).toBeUndefined();
  });

  it("records the provider count once and returns the page unchanged", async () => {
    const onReaderUsage = jest.fn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        readerResponse("Example Domain", { "x-usage-tokens": "0" }),
      );

    await expect(runTool({ onReaderUsage })).resolves.toBe("Example Domain");
    expect(onReaderUsage.mock.calls).toEqual([[{ usageTokens: 0 }]]);
  });

  it("meters a non-OK response using whatever count it reported", async () => {
    const onReaderUsage = jest.fn();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        readerResponse("upstream down", { "x-usage-tokens": "3" }, 502),
      );

    await expect(runTool({ onReaderUsage })).resolves.toBe(
      "Error opening URL: The URL reader request failed (HTTP 502).",
    );
    expect(onReaderUsage.mock.calls).toEqual([[{ usageTokens: 3 }]]);
  });

  it("meters a sent request that fails in transport as unreported", async () => {
    const onReaderUsage = jest.fn();
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed"));

    await runTool({ onReaderUsage });
    expect(onReaderUsage.mock.calls).toEqual([[{ usageTokens: undefined }]]);
  });

  it("does not double-meter when the body fails after headers arrive", async () => {
    const onReaderUsage = jest.fn();
    const response = readerResponse("partial", { "x-usage-tokens": "77" });
    response.text.mockRejectedValue(new TypeError("terminated"));
    global.fetch = jest.fn().mockResolvedValue(response);

    await runTool({ onReaderUsage });
    expect(onReaderUsage.mock.calls).toEqual([[{ usageTokens: 77 }]]);
  });

  it("does not meter a call skipped because the run was already aborted", async () => {
    const onReaderUsage = jest.fn();
    const controller = new AbortController();
    controller.abort();
    global.fetch = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

    await expect(runTool({ onReaderUsage }, controller.signal)).resolves.toBe(
      "Error: Operation aborted",
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onReaderUsage).not.toHaveBeenCalled();
  });

  it("keeps the tool result when the measurement hook throws", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        readerResponse("Example Domain", { "x-usage-tokens": "5" }),
      );

    await expect(
      runTool({
        onReaderUsage: () => {
          throw new Error("meter unavailable");
        },
      }),
    ).resolves.toBe("Example Domain");
  });
});
