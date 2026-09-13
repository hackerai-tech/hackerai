import { streamText, tool, type LanguageModel } from "ai";
import { WritableStream as NodeWritableStream } from "node:stream/web";
import { z } from "zod";
import {
  guardLanguageModelProviderResponse,
  MAX_PROVIDER_TOOL_CALLS_PER_RESPONSE,
  type LanguageModelStreamPart,
} from "../provider-response-guard";
import { namespaceLanguageModelToolCalls } from "../tool-call-id-namespace";
import {
  getProviderErrorCategory,
  getUserFriendlyProviderError,
  PROVIDER_CONTENT_BLOCKED_USER_MESSAGE,
  extractErrorDetails,
} from "@/lib/utils/error-utils";

const originalWritableStream = globalThis.WritableStream;

beforeAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: NodeWritableStream,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "WritableStream", {
    configurable: true,
    value: originalWritableStream,
  });
});

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const finish = (
  unified:
    "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other",
) => ({
  type: "finish" as const,
  finishReason: { unified, raw: unified },
  usage,
});

const toolCall = (toolCallId: string, toolName = "run_terminal_cmd") => ({
  type: "tool-call" as const,
  toolCallId,
  toolName,
  input: "{}",
});

const createModel = ({
  streamParts = [finish("stop")],
  content = [],
}: {
  streamParts?: LanguageModelStreamPart[];
  content?: Array<Record<string, unknown>>;
} = {}): LanguageModel =>
  ({
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: jest.fn(async () => ({
      content,
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    })),
    doStream: jest.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          streamParts.forEach((part) => controller.enqueue(part));
          controller.close();
        },
      }),
    })),
  }) as unknown as LanguageModel;

const readProviderStream = async (model: LanguageModel) => {
  if (typeof model === "string") throw new Error("Expected model object");
  const result = await model.doStream({} as never);
  const parts: LanguageModelStreamPart[] = [];
  const reader = result.stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts;
};

const consumeFullStream = async (
  result: ReturnType<typeof streamText>,
): Promise<unknown[]> => {
  const parts: unknown[] = [];
  for await (const part of result.fullStream) parts.push(part);
  return parts;
};

describe("provider response tool-call guard", () => {
  it("preserves non-streamed responses below and at the configured limit", async () => {
    for (const callCount of [2, 3]) {
      const content = Array.from({ length: callCount }, (_, index) =>
        toolCall(`call-${index}`),
      );
      const model = guardLanguageModelProviderResponse(
        createModel({ content }),
        { maxToolCalls: 3 },
      );
      if (typeof model === "string") throw new Error("Expected model object");

      const result = await model.doGenerate({} as never);

      expect(result.content).toEqual(content);
    }
  });

  it("bounds runaway non-streamed calls while preserving mixed content", async () => {
    const report = jest.fn();
    const content = [
      { type: "text", text: "visible" },
      toolCall("call-1"),
      { type: "reasoning", text: "private reasoning" },
      toolCall("call-2"),
      toolCall("call-3"),
      {
        type: "tool-result",
        toolCallId: "call-3",
        toolName: "run_terminal_cmd",
        result: { ok: true },
      },
    ];
    const model = guardLanguageModelProviderResponse(createModel({ content }), {
      maxToolCalls: 2,
      onToolCallsDropped: report,
    });
    if (typeof model === "string") throw new Error("Expected model object");

    const result = await model.doGenerate({} as never);

    expect(result.content).toEqual(content.slice(0, 4));
    expect(report).toHaveBeenCalledWith({
      droppedToolCallCount: 1,
      maxToolCalls: 2,
    });
  });

  it("counts repeated provider IDs as separate calls", async () => {
    const repeated = [toolCall("provider-id"), toolCall("provider-id")];
    const model = guardLanguageModelProviderResponse(
      createModel({ content: repeated }),
      { maxToolCalls: 1 },
    );
    if (typeof model === "string") throw new Error("Expected model object");

    const result = await model.doGenerate({} as never);

    expect(result.content).toEqual([repeated[0]]);
  });

  it("keeps streamed input start/delta/end correlated for retained calls", async () => {
    const parts = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "working" },
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "thinking" },
      { type: "reasoning-end", id: "reasoning-1" },
      ...["call-1", "call-2", "call-3"].flatMap((id) => [
        {
          type: "tool-input-start" as const,
          id,
          toolName: "run_terminal_cmd",
        },
        { type: "tool-input-delta" as const, id, delta: "{}" },
        { type: "tool-input-end" as const, id },
        toolCall(id),
      ]),
      { type: "text-end", id: "text-1" },
      finish("tool-calls"),
    ] as LanguageModelStreamPart[];
    const model = guardLanguageModelProviderResponse(
      createModel({ streamParts: parts }),
      { maxToolCalls: 2 },
    );

    const guarded = await readProviderStream(model);
    const serialized = JSON.stringify(guarded);

    expect(serialized).toContain("call-1");
    expect(serialized).toContain("call-2");
    expect(serialized).not.toContain("call-3");
    expect(guarded.filter((part) => part.type === "tool-call")).toHaveLength(2);
    expect(guarded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text-delta", delta: "working" }),
        expect.objectContaining({
          type: "reasoning-delta",
          delta: "thinking",
        }),
        expect.objectContaining({ type: "finish" }),
      ]),
    );
  });

  it("preserves compaction namespaces and retained tool-result matching", async () => {
    const model = namespaceLanguageModelToolCalls(
      guardLanguageModelProviderResponse(
        createModel({
          streamParts: [
            {
              type: "tool-input-start",
              id: "call-1",
              toolName: "run_terminal_cmd",
            },
            { type: "tool-input-delta", id: "call-1", delta: "{}" },
            { type: "tool-input-end", id: "call-1" },
            toolCall("call-1"),
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "run_terminal_cmd",
              result: { ok: true },
            },
            toolCall("call-2"),
            finish("tool-calls"),
          ],
        }),
        { maxToolCalls: 1 },
      ),
      "rrun1c2s3",
    );

    const guarded = await readProviderStream(model);
    const toolParts = guarded.filter((part) => part.type.startsWith("tool-"));

    expect(toolParts).toEqual([
      expect.objectContaining({
        type: "tool-input-start",
        id: "rrun1c2s3_call-1",
      }),
      expect.objectContaining({
        type: "tool-input-delta",
        id: "rrun1c2s3_call-1",
      }),
      expect.objectContaining({
        type: "tool-input-end",
        id: "rrun1c2s3_call-1",
      }),
      expect.objectContaining({
        type: "tool-call",
        toolCallId: "rrun1c2s3_call-1",
      }),
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "rrun1c2s3_call-1",
      }),
    ]);
  });

  it("deduplicates wait_for_agents within one provider response", async () => {
    const content = [
      toolCall("wait-1", "wait_for_agents"),
      toolCall("work-1"),
      toolCall("wait-2", "wait_for_agents"),
    ];
    const model = guardLanguageModelProviderResponse(createModel({ content }), {
      maxToolCalls: 10,
    });
    if (typeof model === "string") throw new Error("Expected model object");

    const result = await model.doGenerate({} as never);

    expect(result.content).toEqual(content.slice(0, 2));
  });

  it("filters calls before the AI SDK launches tool executions", async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const model = guardLanguageModelProviderResponse(
      createModel({
        streamParts: [
          toolCall("call-1"),
          toolCall("call-2"),
          toolCall("call-3"),
          finish("tool-calls"),
        ],
      }),
      { maxToolCalls: 2 },
    );

    const result = streamText({
      model,
      prompt: "test",
      tools: {
        run_terminal_cmd: tool({
          inputSchema: z.object({}),
          execute,
        }),
      },
    });
    await consumeFullStream(result);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("executes only one streamed wait_for_agents call per model turn", async () => {
    const waitForAgents = jest.fn(async () => ({ status: "complete" }));
    const runTerminal = jest.fn(async () => ({ ok: true }));
    const model = guardLanguageModelProviderResponse(
      createModel({
        streamParts: [
          toolCall("wait-1", "wait_for_agents"),
          toolCall("work-1"),
          toolCall("wait-2", "wait_for_agents"),
          finish("tool-calls"),
        ],
      }),
      { maxToolCalls: 10 },
    );

    const result = streamText({
      model,
      prompt: "test",
      tools: {
        wait_for_agents: tool({
          inputSchema: z.object({}),
          execute: waitForAgents,
        }),
        run_terminal_cmd: tool({
          inputSchema: z.object({}),
          execute: runTerminal,
        }),
      },
    });
    await consumeFullStream(result);

    expect(waitForAgents).toHaveBeenCalledTimes(1);
    expect(runTerminal).toHaveBeenCalledTimes(1);
  });

  it("uses 32 as the explicit production ceiling", () => {
    expect(MAX_PROVIDER_TOOL_CALLS_PER_RESPONSE).toBe(32);
  });
});

describe("content-filter finish handling", () => {
  it.each([
    { label: "no output", outputParts: [] },
    {
      label: "partial output",
      outputParts: [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "partial answer" },
        { type: "text-end", id: "text-1" },
      ],
    },
  ])(
    "surfaces $label as a terminal provider content block",
    async ({ outputParts }) => {
      const errors: unknown[] = [];
      const finishes: Array<{ finishReason: string; text: string }> = [];
      const model = guardLanguageModelProviderResponse(
        createModel({
          streamParts: [
            ...(outputParts as LanguageModelStreamPart[]),
            finish("content-filter"),
          ],
        }),
      );
      const result = streamText({
        model,
        prompt: "test",
        onError: ({ error }) => {
          errors.push(error);
        },
        onFinish: ({ finishReason, text }) => {
          finishes.push({ finishReason, text });
        },
      });

      await consumeFullStream(result);

      expect(errors).toHaveLength(1);
      expect(getProviderErrorCategory(extractErrorDetails(errors[0]))).toBe(
        "content_blocked",
      );
      expect(getUserFriendlyProviderError(errors[0])).toBe(
        PROVIDER_CONTENT_BLOCKED_USER_MESSAGE,
      );
      expect(finishes).toEqual([
        {
          finishReason: "content-filter",
          text: outputParts.length === 0 ? "" : "partial answer",
        },
      ]);
    },
  );

  it.each(["stop", "error", "other"] as const)(
    "passes through the normal %s finish reason without synthesis",
    async (finishReason) => {
      const model = guardLanguageModelProviderResponse(
        createModel({ streamParts: [finish(finishReason)] }),
      );

      const parts = await readProviderStream(model);

      expect(parts).toEqual([finish(finishReason)]);
    },
  );
});
