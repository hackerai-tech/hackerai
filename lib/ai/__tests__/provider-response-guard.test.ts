import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { WritableStream as NodeWritableStream } from "node:stream/web";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
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

describe("nameless provider prompt tool-call repair", () => {
  const history = (name = "", count = 1): UIMessage[] =>
    [
      {
        id: "history",
        role: "assistant",
        parts: [
          { type: "text", text: "Keep this assistant content" },
          ...Array.from({ length: count }, (_, index) => ({
            type: `tool-${name}`,
            toolCallId: `bad-${index}`,
            state: "output-error",
            input: { value: "PRIVATE_ARGUMENT_CANARY" },
            errorText: "PRIVATE_ERROR_CANARY",
          })),
          {
            type: "tool-run_terminal_cmd",
            toolCallId: "valid-history",
            state: "output-available",
            input: {},
            output: "Keep this tool output",
          },
        ],
      },
      { id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] },
    ] as unknown as UIMessage[];

  it.each(["generate", "stream"])(
    "repairs the installed SDK's empty-name serialization before %s",
    async (method) => {
      const canonical = history();
      const snapshot = JSON.parse(JSON.stringify(canonical));
      const messages = await convertToModelMessages(canonical);
      const base = createModel();
      if (typeof base === "string") throw new Error("Expected model object");
      const report = jest.fn();
      const model = guardLanguageModelProviderResponse(base, {
        onPromptRepaired: report,
      });
      const result = streamText({
        model: method === "generate" ? base : model,
        messages,
      });
      await consumeFullStream(result);
      // Exercise non-streamed requests with the same normalized SDK prompt too.
      let streamPrompt = jest.mocked(base.doStream).mock.calls[0][0].prompt;
      if (method === "generate") {
        if (typeof model === "string") throw new Error("Expected model object");
        await model.doGenerate({ prompt: streamPrompt } as never);
        streamPrompt = jest.mocked(base.doGenerate).mock.calls[0][0].prompt;
      }
      expect(
        streamPrompt
          .flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          )
          .filter((part) => part.type === "tool-call")
          .map((part) => part.toolName),
      ).toEqual(["run_terminal_cmd"]);
      expect(JSON.stringify(streamPrompt)).toContain(
        "Keep this assistant content",
      );
      expect(JSON.stringify(streamPrompt)).toContain("Keep this tool output");
      expect(JSON.stringify(streamPrompt)).not.toContain("PRIVATE_");
      expect(report).toHaveBeenCalledWith({
        removedToolCallCount: 1,
        removedToolResultCount: 1,
        repairedToolInputCount: 0,
      });
      expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE_");
      expect(canonical).toEqual(snapshot);
    },
  );

  it("repairs every malformed call in primary and fallback projections without consuming the valid history limit", async () => {
    const messages = await convertToModelMessages(history(" ", 40));
    const snapshot = JSON.parse(JSON.stringify(messages));
    for (const base of [createModel(), createModel()]) {
      if (typeof base === "string") throw new Error("Expected model object");
      const report = jest.fn();
      const model = guardLanguageModelProviderResponse(base, {
        maxToolCalls: 1,
        onPromptRepaired: report,
      });
      if (typeof model === "string") throw new Error("Expected model object");
      // This fixture uses the SDK conversion directly to retain all40 invalid calls.
      const prompt = messages.map((message) =>
        message.role === "assistant" || message.role === "tool"
          ? { ...message, content: message.content }
          : message,
      );
      await model.doGenerate({ prompt } as never);
      expect(report).toHaveBeenCalledWith({
        removedToolCallCount: 40,
        removedToolResultCount: 40,
        repairedToolInputCount: 0,
      });
      expect(
        JSON.stringify(jest.mocked(base.doGenerate).mock.calls[0][0].prompt),
      ).toContain("valid-history");
      expect(
        JSON.stringify(jest.mocked(base.doGenerate).mock.calls[0][0].prompt),
      ).not.toContain("bad-");
      expect(messages).toEqual(snapshot);
    }
  });

  it("removes empty assistant/tool messages and keeps named calls, denial and unrelated results", async () => {
    const base = createModel();
    if (typeof base === "string") throw new Error("Expected model object");
    const report = jest.fn();
    const model = guardLanguageModelProviderResponse(base, {
      onPromptRepaired: report,
    });
    if (typeof model === "string") throw new Error("Expected model object");
    const prompt = [
      { role: "system", content: "Authorization remains" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "bad", toolName: "", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bad",
            toolName: "",
            output: { type: "error-text", value: "PRIVATE_ERROR_CANARY" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "named",
            toolName: "unknown_named_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "named",
            toolName: "unknown_named_tool",
            output: { type: "execution-denied", reason: "Denied" },
          },
          {
            type: "tool-approval-response",
            approvalId: "approval",
            approved: false,
          },
          {
            type: "tool-result",
            toolCallId: "unrelated",
            toolName: "other",
            output: { type: "text", value: "Other output" },
          },
        ],
      },
    ];
    const original = JSON.parse(JSON.stringify(prompt));
    const toolChoice = { type: "tool", toolName: "run_terminal_cmd" };
    await model.doGenerate({
      prompt,
      toolChoice,
      maxOutputTokens: 200,
    } as never);
    expect(jest.mocked(base.doGenerate).mock.calls[0][0].toolChoice).toBe(
      toolChoice,
    );
    expect(jest.mocked(base.doGenerate).mock.calls[0][0].maxOutputTokens).toBe(
      200,
    );
    expect(jest.mocked(base.doGenerate).mock.calls[0][0].prompt).toEqual([
      prompt[0],
      prompt[3],
      prompt[4],
    ]);
    expect(prompt).toEqual(original);
    expect(report).toHaveBeenCalledWith({
      removedToolCallCount: 1,
      removedToolResultCount: 1,
      repairedToolInputCount: 0,
    });
  });

  it("keeps valid calls/results sharing an ID with a malformed call", async () => {
    const base = createModel();
    if (typeof base === "string") throw new Error("Expected model object");
    const model = guardLanguageModelProviderResponse(base);
    if (typeof model === "string") throw new Error("Expected model object");
    const validCall = {
      type: "tool-call",
      toolCallId: "shared",
      toolName: "run_terminal_cmd",
      input: {},
    };
    const validResult = {
      type: "tool-result",
      toolCallId: "shared",
      toolName: "run_terminal_cmd",
      output: { type: "text", value: "Keep" },
    };
    await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [validCall, { ...validCall, toolName: "" }],
        },
        {
          role: "tool",
          content: [validResult, { ...validResult, toolName: "" }],
        },
      ],
    } as never);
    expect(jest.mocked(base.doGenerate).mock.calls[0][0].prompt).toEqual([
      { role: "assistant", content: [validCall] },
      { role: "tool", content: [validResult] },
    ]);
  });

  it("does not associate a malformed result with an already completed or future reused ID", async () => {
    const base = createModel();
    if (typeof base === "string") throw new Error("Expected model object");
    const model = guardLanguageModelProviderResponse(base);
    if (typeof model === "string") throw new Error("Expected model object");
    const call = {
      type: "tool-call",
      toolCallId: "shared",
      toolName: "run_terminal_cmd",
      input: {},
    };
    const result = {
      type: "tool-result",
      toolCallId: "shared",
      toolName: "run_terminal_cmd",
      output: { type: "text", value: "Keep valid results" },
    };
    const validMessages = [
      { role: "assistant", content: [call] },
      { role: "tool", content: [result] },
    ];
    const malformedMessages = [
      { role: "assistant", content: [{ ...call, toolName: "" }] },
      { role: "tool", content: [result] },
    ];
    const prompt = [...validMessages, ...malformedMessages, ...validMessages];
    const snapshot = JSON.parse(JSON.stringify(prompt));
    await model.doGenerate({ prompt } as never);
    expect(jest.mocked(base.doGenerate).mock.calls[0][0].prompt).toEqual([
      ...validMessages,
      ...validMessages,
    ]);
    expect(prompt).toEqual(snapshot);
  });

  it("continues the real SDK tool loop with only the valid requested tool executed", async () => {
    const base = createModel({
      streamParts: [toolCall("fresh-call"), finish("tool-calls")],
    });
    if (typeof base === "string") throw new Error("Expected model object");
    const execute = jest.fn(async () => "ok");
    const first = base.doStream;
    base.doStream = jest
      .fn()
      .mockImplementationOnce(first)
      .mockResolvedValue({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "Completed",
            });
            controller.enqueue({ type: "text-end", id: "text" });
            controller.enqueue(finish("stop"));
            controller.close();
          },
        }),
      } as never) as typeof base.doStream;
    const result = streamText({
      model: guardLanguageModelProviderResponse(base),
      messages: await convertToModelMessages(history()),
      tools: { run_terminal_cmd: tool({ inputSchema: z.object({}), execute }) },
      stopWhen: stepCountIs(2),
    });
    await consumeFullStream(result);
    expect(await result.text).toBe("Completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(base.doStream).toHaveBeenCalledTimes(2);
    for (const [params] of jest.mocked(base.doStream).mock.calls)
      expect(JSON.stringify(params.prompt)).not.toContain("bad-0");
  });

  it("reproduces the OpenRouter empty-function-name400 and repairs the actual wire payload", async () => {
    const EdgeResponse =
      require("next/dist/compiled/@edge-runtime/primitives/fetch")
        .Response as typeof Response;
    const payloads: any[] = [];
    const fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      payloads.push(body);
      const invalid = body.messages.some((message: any) =>
        message.tool_calls?.some((call: any) => !call.function.name.trim()),
      );
      return new EdgeResponse(
        JSON.stringify(
          invalid
            ? {
                error: {
                  message:
                    "tool_calls[16].function.name must be a non-empty string (got empty string)",
                  code: 400,
                },
              }
            : {
                id: "gen-test",
                created: 0,
                model: "test/model",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Recovered" },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 2,
                  total_tokens: 12,
                },
              },
        ),
        {
          status: invalid ? 400 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const base = createOpenRouter({
      apiKey: "test-only-not-a-credential",
      fetch: fetch as typeof globalThis.fetch,
    })("test/model");
    const validCalls = Array.from({ length: 16 }, (_, index) => ({
      type: "tool-call",
      toolCallId: `valid-${index}`,
      toolName: "run_terminal_cmd",
      input: {},
    }));
    const prompt = [
      {
        role: "assistant",
        content: [
          ...validCalls,
          {
            type: "tool-call",
            toolCallId: "bad",
            toolName: "",
            input: { value: "PRIVATE_ARGUMENT_CANARY" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          ...validCalls.map((call) => ({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: "Valid output" },
          })),
          {
            type: "tool-result",
            toolCallId: "bad",
            toolName: "",
            output: { type: "error-text", value: "PRIVATE_ERROR_CANARY" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ];
    const original = JSON.parse(JSON.stringify(prompt));
    await expect(base.doGenerate({ prompt } as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    const report = jest.fn();
    const guarded = guardLanguageModelProviderResponse(base, {
      onPromptRepaired: report,
    });
    if (typeof guarded === "string") throw new Error("Expected model object");
    const result = await guarded.doGenerate({ prompt } as never);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Recovered" }),
      ]),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(payloads[0].messages[0].tool_calls[16].function.name).toBe("");
    expect(payloads[1].messages[0].tool_calls).toHaveLength(16);
    expect(
      payloads[1].messages.filter((message: any) => message.role === "tool"),
    ).toHaveLength(16);
    expect(JSON.stringify(payloads[1])).not.toContain("PRIVATE_");
    expect(prompt).toEqual(original);
    expect(report).toHaveBeenCalledWith({
      removedToolCallCount: 1,
      removedToolResultCount: 1,
      repairedToolInputCount: 0,
    });
  });

  it("preserves unchanged prompts by identity and does not let reporter failure block a repaired request", async () => {
    const base = createModel();
    if (typeof base === "string") throw new Error("Expected model object");
    const report = jest.fn(() => {
      throw new Error("PRIVATE_ERROR_CANARY");
    });
    const model = guardLanguageModelProviderResponse(base, {
      onPromptRepaired: report,
    });
    if (typeof model === "string") throw new Error("Expected model object");
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    await model.doGenerate({ prompt } as never);
    expect(jest.mocked(base.doGenerate).mock.calls[0][0].prompt).toBe(prompt);
    expect(report).not.toHaveBeenCalled();
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await consumeFullStream(
        streamText({
          model,
          messages: await convertToModelMessages(history()),
        }),
      );
      expect(report).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE_");
    } finally {
      warning.mockRestore();
    }
  });
});

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
