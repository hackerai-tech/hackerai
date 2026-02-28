import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { ModelMessage } from "ai";

const mockGenerateText = jest.fn<() => Promise<{ text: string }>>();

jest.doMock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: mockGenerateText,
}));
jest.doMock("@/lib/ai/providers", () => ({
  myProvider: {
    languageModel: () =>
      ({}) as ReturnType<
        (typeof import("@/lib/ai/providers"))["myProvider"]["languageModel"]
      >,
  },
}));

const {
  splitStepMessages,
  generateStepSummaryText,
  buildStepSummaryModelMessage,
  summarizeSteps,
  extractLastToolCallId,
  injectPersistedStepSummary,
} = require("../step-helpers") as typeof import("../step-helpers");

const makeAssistantMsg = (id: number): ModelMessage => ({
  role: "assistant",
  content: [{ type: "text", text: `step ${id} response` }],
});

const makeToolMsg = (id: number): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: `call-${id}`,
      toolName: `tool-${id}`,
      result: `result ${id}`,
    },
  ],
});

const makeUserMsg = (id: number): ModelMessage => ({
  role: "user",
  content: [{ type: "text", text: `user message ${id}` }],
});

const makeSystemMsg = (): ModelMessage => ({
  role: "system",
  content: "system prompt",
});

describe("splitStepMessages", () => {
  it.each([
    {
      name: "no response messages returns all as initial",
      messages: (): ModelMessage[] => [makeSystemMsg(), makeUserMsg(1)],
      initialMsgCount: 2,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 0,
      expectedKeepLen: 0,
    },
    {
      name: "fewer steps than stepsToKeep returns nothing to summarize",
      messages: (): ModelMessage[] => [
        makeSystemMsg(),
        makeUserMsg(1),
        makeAssistantMsg(1),
        makeToolMsg(1),
        makeAssistantMsg(2),
        makeToolMsg(2),
        makeAssistantMsg(3),
        makeToolMsg(3),
      ],
      initialMsgCount: 2,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 0,
      expectedKeepLen: 6,
    },
    {
      name: "normal split with 10 steps (keep 5) splits at correct boundary",
      messages: (): ModelMessage[] => {
        const msgs: ModelMessage[] = [makeSystemMsg(), makeUserMsg(1)];
        for (let i = 1; i <= 10; i++) {
          msgs.push(makeAssistantMsg(i));
          msgs.push(makeToolMsg(i));
        }
        return msgs;
      },
      initialMsgCount: 2,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 10,
      expectedKeepLen: 10,
    },
    {
      name: "initialMsgCount exceeds array length returns all as initial",
      messages: (): ModelMessage[] => [makeUserMsg(1)],
      initialMsgCount: 3,
      stepsToKeep: 5,
      expectedInitialLen: 1,
      expectedSummarizeLen: 0,
      expectedKeepLen: 0,
    },
    {
      name: "text-only assistant messages (no tool) still counted as step boundaries",
      messages: (): ModelMessage[] => {
        const msgs: ModelMessage[] = [makeSystemMsg(), makeUserMsg(1)];
        for (let i = 1; i <= 10; i++) {
          msgs.push(makeAssistantMsg(i));
        }
        return msgs;
      },
      initialMsgCount: 2,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 5,
      expectedKeepLen: 5,
    },
    {
      name: "stepsToKeep=0 puts all response messages in stepsToSummarize",
      messages: (): ModelMessage[] => [
        makeSystemMsg(),
        makeUserMsg(1),
        makeAssistantMsg(1),
        makeToolMsg(1),
        makeAssistantMsg(2),
        makeToolMsg(2),
      ],
      initialMsgCount: 2,
      stepsToKeep: 0,
      expectedInitialLen: 2,
      expectedSummarizeLen: 4,
      expectedKeepLen: 0,
    },
    {
      name: "interleaved user messages in response section are grouped with adjacent steps",
      messages: (): ModelMessage[] => [
        makeSystemMsg(),
        makeUserMsg(1),
        makeAssistantMsg(1),
        makeToolMsg(1),
        makeUserMsg(2),
        makeAssistantMsg(2),
        makeToolMsg(2),
        makeAssistantMsg(3),
        makeToolMsg(3),
      ],
      initialMsgCount: 2,
      stepsToKeep: 1,
      expectedInitialLen: 2,
      expectedSummarizeLen: 5,
      expectedKeepLen: 2,
    },
  ])(
    "$name",
    ({
      messages,
      initialMsgCount,
      stepsToKeep,
      expectedInitialLen,
      expectedSummarizeLen,
      expectedKeepLen,
    }) => {
      const msgs = messages();
      const result = splitStepMessages(msgs, initialMsgCount, stepsToKeep);

      expect(result.initialMessages).toHaveLength(expectedInitialLen);
      expect(result.stepsToSummarizeMessages).toHaveLength(
        expectedSummarizeLen,
      );
      expect(result.stepsToKeepMessages).toHaveLength(expectedKeepLen);

      const reconstructed = [
        ...result.initialMessages,
        ...result.stepsToSummarizeMessages,
        ...result.stepsToKeepMessages,
      ];
      expect(reconstructed).toEqual(msgs);
    },
  );

  it("keeps correct messages in each partition for 10 steps keeping 5 with tool messages", () => {
    const msgs: ModelMessage[] = [makeSystemMsg(), makeUserMsg(1)];
    for (let i = 1; i <= 10; i++) {
      msgs.push(makeAssistantMsg(i));
      msgs.push(makeToolMsg(i));
    }

    const result = splitStepMessages(msgs, 2, 5);

    expect(result.initialMessages[0]).toEqual(makeSystemMsg());
    expect(result.initialMessages[1]).toEqual(makeUserMsg(1));

    const firstKeptMsg = result.stepsToKeepMessages[0] as {
      role: string;
      content: Array<{ text: string }>;
    };
    expect(firstKeptMsg.role).toBe("assistant");
    expect(firstKeptMsg.content[0].text).toBe("step 6 response");

    const lastSummarizedMsg = result.stepsToSummarizeMessages[
      result.stepsToSummarizeMessages.length - 1
    ] as {
      role: string;
      content: Array<{ toolName: string }>;
    };
    expect(lastSummarizedMsg.role).toBe("tool");
    expect(lastSummarizedMsg.content[0].toolName).toBe("tool-5");
  });

  it("handles few assistant messages gracefully (fewer than stepsToKeep)", () => {
    const msgs: ModelMessage[] = [
      makeSystemMsg(),
      makeUserMsg(1),
      makeAssistantMsg(7),
      makeToolMsg(7),
      makeAssistantMsg(8),
      makeToolMsg(8),
      makeAssistantMsg(9),
      makeToolMsg(9),
      makeAssistantMsg(10),
      makeToolMsg(10),
    ];

    const result = splitStepMessages(msgs, 2, 5);

    expect(result.stepsToSummarizeMessages).toHaveLength(0);
    expect(result.stepsToKeepMessages).toHaveLength(8);

    const reconstructed = [
      ...result.initialMessages,
      ...result.stepsToSummarizeMessages,
      ...result.stepsToKeepMessages,
    ];
    expect(reconstructed).toEqual(msgs);
  });
});

describe("generateStepSummaryText", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls generateText and returns the summary text", async () => {
    mockGenerateText.mockResolvedValue({ text: "summary" });

    const messages: ModelMessage[] = [makeAssistantMsg(1), makeToolMsg(1)];
    const result = await generateStepSummaryText(messages);

    expect(result).toBe("summary");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining(
          "step-level context condensation engine",
        ),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant" }),
        ]),
      }),
    );
  });

  it("includes previous_step_summary in system prompt when existingSummary is provided", async () => {
    mockGenerateText.mockResolvedValue({ text: "merged summary" });

    const messages: ModelMessage[] = [makeAssistantMsg(1)];
    const result = await generateStepSummaryText(messages, "previous context");

    expect(result).toBe("merged summary");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("<previous_step_summary>"),
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("previous context"),
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("INCREMENTAL summarization"),
      }),
    );
  });

  it("returns existing summary without calling generateText when messages are empty and existingSummary is provided", async () => {
    const result = await generateStepSummaryText([], "existing summary");

    expect(result).toBe("existing summary");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns empty string without calling generateText when messages are empty and no existingSummary", async () => {
    const result = await generateStepSummaryText([]);

    expect(result).toBe("");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("passes abortSignal to generateText", async () => {
    mockGenerateText.mockResolvedValue({ text: "summary" });
    const controller = new AbortController();

    await generateStepSummaryText(
      [makeAssistantMsg(1)],
      undefined,
      controller.signal,
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      }),
    );
  });

  it("propagates errors from generateText to the caller", async () => {
    mockGenerateText.mockRejectedValue(new Error("Rate limit exceeded"));

    const messages: ModelMessage[] = [makeAssistantMsg(1)];
    await expect(generateStepSummaryText(messages)).rejects.toThrow(
      "Rate limit exceeded",
    );
  });
});

describe("buildStepSummaryModelMessage", () => {
  it("returns a user ModelMessage with step_summary tags wrapping the summary", () => {
    const result = buildStepSummaryModelMessage("test summary content");

    expect(result.role).toBe("user");
    expect(result.content).toEqual([
      {
        type: "text",
        text: "<step_summary>\ntest summary content\n</step_summary>",
      },
    ]);
  });

  it("wraps content properly with newlines inside tags", () => {
    const multilineSummary = "line one\nline two\nline three";
    const result = buildStepSummaryModelMessage(multilineSummary);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe(
      `<step_summary>\n${multilineSummary}\n</step_summary>`,
    );
    expect(content[0].text).toContain("line one");
    expect(content[0].text).toContain("line three");
    expect(content[0].text.startsWith("<step_summary>")).toBe(true);
    expect(content[0].text.endsWith("</step_summary>")).toBe(true);
  });
});

describe("summarizeSteps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildMessages = (
    stepCount: number,
  ): { messages: ModelMessage[]; initialMsgCount: number } => {
    const messages: ModelMessage[] = [makeSystemMsg(), makeUserMsg(1)];
    for (let i = 1; i <= stepCount; i++) {
      messages.push(makeAssistantMsg(i));
      messages.push(makeToolMsg(i));
    }
    return { messages, initialMsgCount: 2 };
  };

  it("returns summarized=false when stepsLength <= stepsToKeep", async () => {
    const { messages, initialMsgCount } = buildMessages(3);
    const result = await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 3,
      stepsToKeep: 5,
      lastSummarizedStepCount: 0,
      existingStepSummary: null,
    });

    expect(result.summarized).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns summarized=false when stepsLength <= lastSummarizedStepCount (dedup guard)", async () => {
    const { messages, initialMsgCount } = buildMessages(10);
    const result = await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 10,
      existingStepSummary: "already summarized",
    });

    expect(result.summarized).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("generates summary and returns reconstituted messages when enough steps exist", async () => {
    mockGenerateText.mockResolvedValue({ text: "step summary" });
    const { messages, initialMsgCount } = buildMessages(10);

    const result = await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 0,
      existingStepSummary: null,
    });

    expect(result.summarized).toBe(true);
    if (!result.summarized) return;

    expect(result.stepSummaryText).toBe("step summary");
    expect(result.lastSummarizedStepCount).toBe(10);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    // Output should be: initial msgs + summary msg + kept step msgs
    // 2 initial + 1 summary + 10 kept (5 steps * 2 msgs each) = 13
    expect(result.messages).toHaveLength(13);
    expect(result.messages[0]).toEqual(makeSystemMsg());
    expect(result.messages[1]).toEqual(makeUserMsg(1));
    expect(result.messages[2].role).toBe("user");
    const summaryContent = result.messages[2].content as Array<{
      text: string;
    }>;
    expect(summaryContent[0].text).toContain("<step_summary>");
  });

  it("uses summarizedInitialMessages when provided (combined path)", async () => {
    mockGenerateText.mockResolvedValue({ text: "combined summary" });
    const { messages, initialMsgCount } = buildMessages(10);
    const overrideInitial: ModelMessage[] = [makeUserMsg(99)];

    const result = await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 0,
      existingStepSummary: null,
      summarizedInitialMessages: overrideInitial,
    });

    expect(result.summarized).toBe(true);
    if (!result.summarized) return;

    // First message should be the override, not the original system msg
    expect(result.messages[0]).toEqual(makeUserMsg(99));
  });

  it("passes existingStepSummary to generateStepSummaryText for incremental merge", async () => {
    mockGenerateText.mockResolvedValue({ text: "merged" });
    const { messages, initialMsgCount } = buildMessages(10);

    await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 5,
      existingStepSummary: "prior summary",
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("prior summary"),
      }),
    );
  });

  it("passes abortSignal through to generateStepSummaryText", async () => {
    mockGenerateText.mockResolvedValue({ text: "summary" });
    const { messages, initialMsgCount } = buildMessages(10);
    const controller = new AbortController();

    await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 0,
      existingStepSummary: null,
      abortSignal: controller.signal,
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      }),
    );
  });

  it("propagates errors from generateText to the caller", async () => {
    mockGenerateText.mockRejectedValue(new Error("LLM failure"));
    const { messages, initialMsgCount } = buildMessages(10);

    await expect(
      summarizeSteps({
        messages,
        initialModelMessageCount: initialMsgCount,
        stepsLength: 10,
        stepsToKeep: 5,
        lastSummarizedStepCount: 0,
        existingStepSummary: null,
      }),
    ).rejects.toThrow("LLM failure");
  });

  it("returns summarized=false when splitStepMessages finds nothing to summarize", async () => {
    // Only 3 steps but stepsToKeep=5 → splitStepMessages returns empty stepsToSummarize
    const { messages, initialMsgCount } = buildMessages(3);

    const result = await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 0,
      existingStepSummary: null,
    });

    expect(result.summarized).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("includes lastToolCallId in result when summarized", async () => {
    mockGenerateText.mockResolvedValue({ text: "step summary" });
    const { messages, initialMsgCount } = buildMessages(10);

    const result = await summarizeSteps({
      messages,
      initialModelMessageCount: initialMsgCount,
      stepsLength: 10,
      stepsToKeep: 5,
      lastSummarizedStepCount: 0,
      existingStepSummary: null,
    });

    expect(result.summarized).toBe(true);
    if (!result.summarized) return;

    expect(result.lastToolCallId).toBe("call-5");
  });
});

const makeAssistantWithToolCall = (id: number): ModelMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: `call-${id}`,
      toolName: `tool-${id}`,
      args: {},
    },
  ],
});

describe("extractLastToolCallId", () => {
  it.each([
    {
      name: "returns correct toolCallId from last tool message in array",
      messages: (): ModelMessage[] => [
        makeAssistantMsg(1),
        makeToolMsg(1),
        makeAssistantMsg(2),
        makeToolMsg(2),
      ],
      expected: "call-2",
    },
    {
      name: "returns null for empty array",
      messages: (): ModelMessage[] => [],
      expected: null,
    },
    {
      name: "returns null for messages with no tool results",
      messages: (): ModelMessage[] => [makeUserMsg(1), makeAssistantMsg(1)],
      expected: null,
    },
    {
      name: "returns toolCallId from single tool message",
      messages: (): ModelMessage[] => [makeAssistantMsg(1), makeToolMsg(5)],
      expected: "call-5",
    },
    {
      name: "handles mixed messages correctly, picks last tool-result",
      messages: (): ModelMessage[] => [
        makeSystemMsg(),
        makeUserMsg(1),
        makeAssistantMsg(1),
        makeToolMsg(1),
        makeUserMsg(2),
        makeAssistantMsg(2),
        makeToolMsg(3),
      ],
      expected: "call-3",
    },
  ])("$name", ({ messages, expected }) => {
    expect(extractLastToolCallId(messages())).toBe(expected);
  });
});

describe("injectPersistedStepSummary", () => {
  it("replaces tool messages correctly when cutoff found", () => {
    const messages: ModelMessage[] = [
      makeSystemMsg(),
      makeUserMsg(1),
      makeAssistantWithToolCall(1),
      makeToolMsg(1),
      makeAssistantWithToolCall(2),
      makeToolMsg(2),
      makeAssistantWithToolCall(3),
      makeToolMsg(3),
    ];

    const result = injectPersistedStepSummary(
      messages,
      "persisted summary",
      "call-2",
    );

    expect(result).not.toBeNull();
    if (!result) return;

    // Should contain: initial msgs + summary msg + remaining after cutoff
    // initial: [system, user] (2)
    // summary: 1
    // remaining after cutoff (tool-result call-2): [assistantToolCall(3), toolMsg(3)] (2)
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(makeSystemMsg());
    expect(result[1]).toEqual(makeUserMsg(1));
    expect(result[2].role).toBe("user");
    const summaryContent = result[2].content as Array<{ text: string }>;
    expect(summaryContent[0].text).toContain("<step_summary>");
    expect(summaryContent[0].text).toContain("persisted summary");
    expect(result[3]).toEqual(makeAssistantWithToolCall(3));
    expect(result[4]).toEqual(makeToolMsg(3));
  });

  it("returns null when upToToolCallId not found in messages", () => {
    const messages: ModelMessage[] = [
      makeSystemMsg(),
      makeUserMsg(1),
      makeAssistantWithToolCall(1),
      makeToolMsg(1),
    ];

    const result = injectPersistedStepSummary(
      messages,
      "summary text",
      "call-999",
    );

    expect(result).toBeNull();
  });

  it("returns null when messages have no tool-call content", () => {
    const messages: ModelMessage[] = [
      makeSystemMsg(),
      makeUserMsg(1),
      makeAssistantMsg(1),
      makeUserMsg(2),
    ];

    const result = injectPersistedStepSummary(
      messages,
      "summary text",
      "call-1",
    );

    expect(result).toBeNull();
  });

  it("preserves messages before first tool call and after cutoff", () => {
    const messages: ModelMessage[] = [
      makeSystemMsg(),
      makeUserMsg(1),
      makeAssistantWithToolCall(1),
      makeToolMsg(1),
      makeAssistantWithToolCall(2),
      makeToolMsg(2),
      makeAssistantWithToolCall(3),
      makeToolMsg(3),
      makeAssistantWithToolCall(4),
      makeToolMsg(4),
    ];

    const result = injectPersistedStepSummary(
      messages,
      "mid summary",
      "call-2",
    );

    expect(result).not.toBeNull();
    if (!result) return;

    // initial msgs preserved
    expect(result[0]).toEqual(makeSystemMsg());
    expect(result[1]).toEqual(makeUserMsg(1));

    // summary msg injected
    const summaryContent = result[2].content as Array<{ text: string }>;
    expect(summaryContent[0].text).toContain("mid summary");

    // after cutoff preserved: assistantToolCall(3), toolMsg(3), assistantToolCall(4), toolMsg(4)
    expect(result[3]).toEqual(makeAssistantWithToolCall(3));
    expect(result[4]).toEqual(makeToolMsg(3));
    expect(result[5]).toEqual(makeAssistantWithToolCall(4));
    expect(result[6]).toEqual(makeToolMsg(4));
    expect(result).toHaveLength(7);
  });

  it("handles edge case: cutoff is at the very last tool result message", () => {
    const messages: ModelMessage[] = [
      makeSystemMsg(),
      makeUserMsg(1),
      makeAssistantWithToolCall(1),
      makeToolMsg(1),
      makeAssistantWithToolCall(2),
      makeToolMsg(2),
    ];

    const result = injectPersistedStepSummary(
      messages,
      "final summary",
      "call-2",
    );

    expect(result).not.toBeNull();
    if (!result) return;

    // initial: [system, user], summary: 1, remaining after last cutoff: nothing
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(makeSystemMsg());
    expect(result[1]).toEqual(makeUserMsg(1));
    expect(result[2].role).toBe("user");
    const summaryContent = result[2].content as Array<{ text: string }>;
    expect(summaryContent[0].text).toContain("final summary");
  });
});
