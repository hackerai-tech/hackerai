import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { ModelMessage } from "ai";

const mockGenerateText = jest.fn<() => Promise<any>>();

jest.doMock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: mockGenerateText,
}));
jest.doMock("@/lib/ai/providers", () => ({
  myProvider: {
    languageModel: () => ({}) as any,
  },
}));

const {
  splitStepMessages,
  generateStepSummaryText,
  buildStepSummaryModelMessage,
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
      name: "empty steps (stepsCompleted=0) returns all as initial, empty stepsToSummarize",
      messages: (): ModelMessage[] => [makeSystemMsg(), makeUserMsg(1)],
      initialMsgCount: 2,
      stepsCompleted: 0,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 0,
      expectedKeepLen: 0,
    },
    {
      name: "fewer steps than threshold returns nothing to summarize, all response messages in stepsToKeep",
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
      stepsCompleted: 3,
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
      stepsCompleted: 10,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 10,
      expectedKeepLen: 10,
    },
    {
      name: "initialMsgCount exceeds message array length returns all as initial with empty splits",
      messages: (): ModelMessage[] => [makeUserMsg(1)],
      initialMsgCount: 3,
      stepsCompleted: 10,
      stepsToKeep: 5,
      expectedInitialLen: 1,
      expectedSummarizeLen: 0,
      expectedKeepLen: 0,
    },
    {
      name: "steps without tool messages (text-only assistant) still counts 1 step per assistant message",
      messages: (): ModelMessage[] => {
        const msgs: ModelMessage[] = [makeSystemMsg(), makeUserMsg(1)];
        for (let i = 1; i <= 10; i++) {
          msgs.push(makeAssistantMsg(i));
        }
        return msgs;
      },
      initialMsgCount: 2,
      stepsCompleted: 10,
      stepsToKeep: 5,
      expectedInitialLen: 2,
      expectedSummarizeLen: 5,
      expectedKeepLen: 5,
    },
  ])(
    "$name",
    ({
      messages,
      initialMsgCount,
      stepsCompleted,
      stepsToKeep,
      expectedInitialLen,
      expectedSummarizeLen,
      expectedKeepLen,
    }) => {
      const msgs = messages();
      const result = splitStepMessages(
        msgs,
        initialMsgCount,
        stepsCompleted,
        stepsToKeep,
      );

      expect(result.initialMessages).toHaveLength(expectedInitialLen);
      expect(result.stepsToSummarizeMessages).toHaveLength(
        expectedSummarizeLen,
      );
      expect(result.stepsToKeepMessages).toHaveLength(expectedKeepLen);

      // All three slices should reconstruct the original messages array
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

    const result = splitStepMessages(msgs, 2, 10, 5);

    // Initial messages: system + user
    expect(result.initialMessages[0]).toEqual(makeSystemMsg());
    expect(result.initialMessages[1]).toEqual(makeUserMsg(1));

    // Last kept step should start with assistant msg 6 (steps 6-10 kept)
    const firstKeptMsg = result.stepsToKeepMessages[0] as {
      role: string;
      content: Array<{ text: string }>;
    };
    expect(firstKeptMsg.role).toBe("assistant");
    expect(firstKeptMsg.content[0].text).toBe("step 6 response");

    // Last summarized step should end with tool msg 5
    const lastSummarizedMsg = result.stepsToSummarizeMessages[
      result.stepsToSummarizeMessages.length - 1
    ] as {
      role: string;
      content: Array<{ toolName: string }>;
    };
    expect(lastSummarizedMsg.role).toBe("tool");
    expect(lastSummarizedMsg.content[0].toolName).toBe("tool-5");
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
        system: expect.stringContaining("step-level context condensation"),
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
