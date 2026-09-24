import { deserialize, serialize } from "node:v8";
const originalClone = globalThis.structuredClone;
beforeAll(() => {
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
});
afterAll(() => {
  globalThis.structuredClone = originalClone;
});
import { MockLanguageModelV3 } from "ai/test";
import { jsonSchema, type ModelMessage } from "ai";
import { generateSummaryText } from "../helpers";
jest.mock("server-only", () => ({}));
jest.mock("@/lib/db/actions", () => ({}));

const prefix: ModelMessage[] = [
  { role: "user", content: "Keep the original scope and correction verbatim." },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "lookup-1",
        toolName: "lookup",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "lookup-1",
        toolName: "lookup",
        output: { type: "text", value: "unchanged evidence\n".repeat(6000) },
      },
    ],
  },
];
const completion = (reason: "stop" | "length" = "stop") => ({
  content: [
    {
      type: "text" as const,
      text: "Checkpoint retaining scope and correction.",
    },
  ],
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: {
      total: 100,
      noCache: 10,
      cacheRead: 90,
      cacheWrite: undefined,
    },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  },
  warnings: [],
});
const execute = jest.fn();
const tools = {
  lookup: {
    description: "Stable schema",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute,
  },
};
const run = (
  model: MockLanguageModelV3,
  budget = 100_000,
  signal?: AbortSignal,
) =>
  generateSummaryText(
    [],
    model,
    "agent",
    "Frozen original system",
    false,
    tools,
    { openrouter: { session_id: "synthetic-session" } },
    signal,
    prefix,
    budget,
    { preservePrefix: true, maxRetries: 0, maxOutputTokens: 8192 },
  );
describe("cache-aligned summary at the real SDK boundary", () => {
  it("keeps original system, tool schemas and long tool output before the final instruction", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => completion(),
    });
    const result = await run(model);
    const sent = model.doGenerateCalls[0];
    expect(sent.prompt[0]).toMatchObject({
      role: "system",
      content: "Frozen original system",
    });
    expect(sent.prompt[3]).toEqual(prefix[2]);
    expect(sent.prompt.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(sent.prompt.at(-1))).toContain(
      "Summarize the above conversation",
    );
    expect(sent.tools).toEqual([
      expect.objectContaining({
        name: "lookup",
        description: "Stable schema",
        inputSchema: { type: "object", properties: {} },
      }),
    ]);
    expect(sent.providerOptions).toEqual({
      openrouter: { session_id: "synthetic-session" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.usage.cacheReadTokens).toBe(90);
  });
  it("rejects an over-budget prefix without silently rewriting it or calling a model", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => completion(),
    });
    await expect(run(model, 10)).rejects.toThrow("input budget");
    expect(model.doGenerateCalls).toHaveLength(0);
  });
  it("rejects a truncated summary and respects cancellation", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => completion("length"),
    });
    await expect(run(model)).rejects.toThrow("incomplete summary");
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(run(model, 100_000, controller.signal)).rejects.toThrow(
      "stopped",
    );
  });
});
