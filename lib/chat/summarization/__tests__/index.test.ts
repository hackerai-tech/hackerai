import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { UIMessage, UIMessageStreamWriter, LanguageModel } from "ai";
import type { Todo } from "@/types";
import { SUMMARIZATION_THRESHOLD_PERCENTAGE } from "../constants";
import { MAX_TOKENS_FREE } from "@/lib/token-utils";

const mockGenerateText = jest.fn<() => Promise<any>>();
const mockSaveChatSummary = jest.fn<() => Promise<void>>();

jest.doMock("server-only", () => ({}));
jest.doMock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: mockGenerateText,
}));
jest.doMock("@/lib/db/actions", () => ({
  saveChatSummary: mockSaveChatSummary,
}));
jest.doMock("@/lib/ai/providers", () => ({
  myProvider: {
    languageModel: () => ({}) as LanguageModel,
  },
}));

const { checkAndSummarizeIfNeeded } =
  require("../index") as typeof import("../index");
const { isSummaryMessage, extractSummaryText } =
  require("../helpers") as typeof import("../helpers");

const FREE_THRESHOLD = Math.floor(
  MAX_TOKENS_FREE * SUMMARIZATION_THRESHOLD_PERCENTAGE,
);

const TOKENS_PER_ABOVE_MSG = Math.ceil(FREE_THRESHOLD / 4) + 500;

const createMessageWithTokens = (
  id: string,
  role: "user" | "assistant",
  targetTokens: number,
): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: `[${id}] ${"a ".repeat(targetTokens)}` }],
});

const createMessage = (id: string, role: "user" | "assistant"): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: `Message ${id}` }],
});

const fourMessages: UIMessage[] = [
  createMessage("msg-1", "user"),
  createMessage("msg-2", "assistant"),
  createMessage("msg-3", "user"),
  createMessage("msg-4", "assistant"),
];

const fourMessagesAboveThreshold: UIMessage[] = [
  createMessageWithTokens("msg-1", "user", TOKENS_PER_ABOVE_MSG),
  createMessageWithTokens("msg-2", "assistant", TOKENS_PER_ABOVE_MSG),
  createMessageWithTokens("msg-3", "user", TOKENS_PER_ABOVE_MSG),
  createMessageWithTokens("msg-4", "assistant", TOKENS_PER_ABOVE_MSG),
];

const createMockWriter = (): UIMessageStreamWriter =>
  ({ write: jest.fn() }) as unknown as UIMessageStreamWriter;

const mockLanguageModel = {} as LanguageModel;

/**
 * Extract all `[msg-N]` IDs from every generateText call's messages.
 * Used to verify which messages were included in summarization prompts.
 */
const collectMessageIdsFromGenerateCalls = (
  generateTextMock: jest.Mock,
): Set<string> => {
  const ids = new Set<string>();
  for (const call of generateTextMock.mock.calls) {
    const msgs = call[0].messages as Array<{
      role: string;
      content: string | Array<{ type: string; text: string }>;
    }>;
    for (const msg of msgs) {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((p) => p.text).join("");
      const matches = text.match(/\[msg-(\d+)\]/g);
      if (matches) {
        for (const m of matches) {
          ids.add(m.slice(1, -1));
        }
      }
    }
  }
  return ids;
};

describe("checkAndSummarizeIfNeeded", () => {
  let mockWriter: UIMessageStreamWriter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveChatSummary.mockResolvedValue(undefined);
    mockWriter = createMockWriter();
  });

  it("should skip summarization when message count is insufficient", async () => {
    const messages = [createMessage("msg-1", "user")];

    const result = await checkAndSummarizeIfNeeded(
      messages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(result.needsSummarization).toBe(false);
    expect(result.summarizedMessages).toBe(messages);
    expect(result.cutoffMessageId).toBeNull();
    expect(result.summaryText).toBeNull();
  });

  it("should skip summarization when tokens are below threshold", async () => {
    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(result.needsSummarization).toBe(false);
    expect(result.summarizedMessages).toBe(fourMessages);
  });

  it("should summarize and return correct structure when threshold exceeded", async () => {
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Test summary content");
    expect(result.cutoffMessageId).toBe("msg-2");

    // summary message + last 2 kept messages
    expect(result.summarizedMessages).toHaveLength(3);
    expect(result.summarizedMessages[0].parts[0]).toEqual({
      type: "text",
      text: "<context_summary>\nTest summary content\n</context_summary>",
    });
    expect(result.summarizedMessages.slice(1)).toEqual(
      fourMessagesAboveThreshold.slice(-2),
    );
  });

  it("should use agent prompt when mode is agent", async () => {
    mockGenerateText.mockResolvedValue({ text: "Agent summary" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      null,
    );

    expect(result.needsSummarization).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("security agent"),
      }),
    );
  });

  it("should persist summary when chatId is provided", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(mockSaveChatSummary).toHaveBeenCalledWith({
      chatId: "chat-123",
      summaryText: "Summary",
      summaryUpToMessageId: "msg-2",
    });
  });

  it("should skip database persistence for temporary chats", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(mockSaveChatSummary).not.toHaveBeenCalled();
  });

  it("should write summarization completed even when AI fails", async () => {
    mockGenerateText.mockRejectedValue(new Error("API error"));

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(result.needsSummarization).toBe(false);
    expect(result.summaryText).toBeNull();

    const writeCalls = (mockWriter.write as jest.Mock).mock.calls;
    const completedWrite = writeCalls.find(
      (call) =>
        call[0]?.type === "data-summarization" &&
        call[0]?.data?.status === "completed",
    );
    expect(completedWrite).toBeDefined();
  });

  it("should write summarization completed even when database save fails", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });
    mockSaveChatSummary.mockRejectedValue(new Error("DB error"));

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Summary");

    const writeCalls = (mockWriter.write as jest.Mock).mock.calls;
    const completedWrite = writeCalls.find(
      (call) =>
        call[0]?.type === "data-summarization" &&
        call[0]?.data?.status === "completed",
    );
    expect(completedWrite).toBeDefined();
  });

  it("should include todo list in summary message when todos exist", async () => {
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const todos: Todo[] = [
      { id: "1", content: "Run nmap scan on target", status: "in_progress" },
      { id: "2", content: "Test for SQL injection", status: "pending" },
      { id: "3", content: "Enumerate subdomains", status: "completed" },
    ];

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      todos,
    );

    expect(result.needsSummarization).toBe(true);

    const summaryMessageText = result.summarizedMessages[0].parts[0];
    expect(summaryMessageText).toEqual({
      type: "text",
      text: expect.stringContaining("<context_summary>"),
    });
    expect(summaryMessageText).toEqual({
      type: "text",
      text: expect.stringContaining("<current_todos>"),
    });
    expect(summaryMessageText).toEqual({
      type: "text",
      text: expect.stringContaining("[in_progress] Run nmap scan on target"),
    });
    expect(summaryMessageText).toEqual({
      type: "text",
      text: expect.stringContaining("[pending] Test for SQL injection"),
    });
    expect(summaryMessageText).toEqual({
      type: "text",
      text: expect.stringContaining("[completed] Enumerate subdomains"),
    });
  });

  it("should abort summarization and not write completed when signal is aborted", async () => {
    const abortController = new AbortController();
    const abortError = new DOMException(
      "The operation was aborted",
      "AbortError",
    );
    mockGenerateText.mockImplementation(async () => {
      abortController.abort();
      throw abortError;
    });

    await expect(
      checkAndSummarizeIfNeeded(
        fourMessagesAboveThreshold,
        "free",
        mockLanguageModel,
        "ask",
        mockWriter,
        "chat-123",
        {},
        [],
        abortController.signal,
      ),
    ).rejects.toThrow(abortError);

    const writeCalls = (mockWriter.write as jest.Mock).mock.calls;
    const startedWrite = writeCalls.find(
      (call) =>
        call[0]?.type === "data-summarization" &&
        call[0]?.data?.status === "started",
    );
    const completedWrite = writeCalls.find(
      (call) =>
        call[0]?.type === "data-summarization" &&
        call[0]?.data?.status === "completed",
    );
    expect(startedWrite).toBeDefined();
    expect(mockSaveChatSummary).not.toHaveBeenCalled();
    expect(completedWrite).toBeUndefined();
  });

  it("should pass abortSignal to generateText", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    const abortController = new AbortController();

    await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      abortController.signal,
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });

  it("should not include todo block in summary when todos are empty", async () => {
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
    );

    expect(result.needsSummarization).toBe(true);

    const summaryMessageText = (
      result.summarizedMessages[0].parts[0] as { type: string; text: string }
    ).text;
    expect(summaryMessageText).toContain("<context_summary>");
    expect(summaryMessageText).not.toContain("<current_todos>");
  });

  it("should use real message ID as cutoff when input starts with summary message", async () => {
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });

    const summaryMsg: UIMessage = {
      id: "synthetic-uuid-not-in-db",
      role: "user",
      parts: [
        {
          type: "text",
          text: "<context_summary>\nOld summary text\n</context_summary>",
        },
      ],
    };

    const realMessages = [
      createMessageWithTokens("real-1", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("real-2", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("real-3", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("real-4", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const result = await checkAndSummarizeIfNeeded(
      [summaryMsg, ...realMessages],
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      "chat-123",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.cutoffMessageId).toBe("real-2");
    expect(result.cutoffMessageId).not.toBe("synthetic-uuid-not-in-db");
  });

  it("should skip re-summarization when only summary + 2 real messages", async () => {
    const summaryMsg: UIMessage = {
      id: "synthetic-uuid",
      role: "user",
      parts: [
        {
          type: "text",
          text: "<context_summary>\nSome summary\n</context_summary>",
        },
      ],
    };

    const realMessages = [
      createMessage("real-1", "user"),
      createMessage("real-2", "assistant"),
    ];

    const input = [summaryMsg, ...realMessages];
    const result = await checkAndSummarizeIfNeeded(
      input,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    // Only 2 real messages = not enough to split (MESSAGES_TO_KEEP_UNSUMMARIZED = 2)
    expect(result.needsSummarization).toBe(false);
    expect(result.summarizedMessages).toBe(input);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("should pass existing summary text for incremental summarization", async () => {
    mockGenerateText.mockResolvedValue({ text: "Merged summary" });

    const summaryMsg: UIMessage = {
      id: "synthetic-uuid",
      role: "user",
      parts: [
        {
          type: "text",
          text: "<context_summary>\nPrevious summary content\n</context_summary>",
        },
      ],
    };

    const realMessages = [
      createMessageWithTokens("real-1", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("real-2", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("real-3", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("real-4", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    await checkAndSummarizeIfNeeded(
      [summaryMsg, ...realMessages],
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      "chat-123",
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("<previous_summary>"),
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("Previous summary content"),
      }),
    );
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("INCREMENTAL summarization"),
      }),
    );
  });

  it("should produce 2 summaries when threshold is triggered twice", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "First summary" });
    mockGenerateText.mockResolvedValueOnce({ text: "Second summary" });

    const result1 = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(result1.needsSummarization).toBe(true);
    expect(result1.cutoffMessageId).toBe("msg-2");

    const newMessages = [
      createMessageWithTokens("msg-5", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-6", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-7", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-8", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const secondInput = [...result1.summarizedMessages, ...newMessages];

    const result2 = await checkAndSummarizeIfNeeded(
      secondInput,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(result2.needsSummarization).toBe(true);
    expect(mockSaveChatSummary).toHaveBeenCalledTimes(2);
    expect(mockSaveChatSummary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ summaryUpToMessageId: "msg-2" }),
    );
    expect(mockSaveChatSummary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        summaryUpToMessageId: expect.not.stringMatching(/^msg-2$/),
      }),
    );

    const secondCallArgs = mockGenerateText.mock.calls[1][0];
    expect(secondCallArgs.system).toContain("<previous_summary>");
    expect(secondCallArgs.system).toContain("First summary");

    // Verify only messages between cutoffs are sent (not the summary message)
    const secondCallMessages = secondCallArgs.messages as Array<{
      role: string;
      content: string | Array<{ type: string; text: string }>;
    }>;
    const hasContextSummary = secondCallMessages.some((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => p.text).join("");
      return text.includes("<context_summary>");
    });
    expect(hasContextSummary).toBe(false);

    // First call: msg-1, msg-2 converted + 1 summarization prompt
    const firstCallMessages = mockGenerateText.mock.calls[0][0].messages;
    expect(firstCallMessages).toHaveLength(3);
    // Second call: msg-3..msg-6 converted + 1 summarization prompt
    expect(secondCallMessages).toHaveLength(5);

    expect(result2.summarizedMessages).toHaveLength(3);
    expect(isSummaryMessage(result2.summarizedMessages[0])).toBe(true);
    expect(extractSummaryText(result2.summarizedMessages[0])).toBe(
      "Second summary",
    );
  });

  it("should pass every message up to the last cutoff through generateText at least once", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "First summary" });
    mockGenerateText.mockResolvedValueOnce({ text: "Second summary" });
    mockGenerateText.mockResolvedValueOnce({ text: "Third summary" });

    // Round 1: msg-1..msg-4
    const round1Messages = [
      createMessageWithTokens("msg-1", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-2", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-3", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-4", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const result1 = await checkAndSummarizeIfNeeded(
      round1Messages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );
    expect(result1.cutoffMessageId).toBe("msg-2");

    // Round 2: result1 + msg-5..msg-8
    const round2Input = [
      ...result1.summarizedMessages,
      createMessageWithTokens("msg-5", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-6", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-7", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-8", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const result2 = await checkAndSummarizeIfNeeded(
      round2Input,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );
    expect(result2.cutoffMessageId).toBe("msg-6");

    // Round 3: result2 + msg-9..msg-12
    const round3Input = [
      ...result2.summarizedMessages,
      createMessageWithTokens("msg-9", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-10", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-11", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-12", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const result3 = await checkAndSummarizeIfNeeded(
      round3Input,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );
    expect(result3.cutoffMessageId).toBe("msg-10");

    // Collect all message IDs that were passed to generateText across all 3 calls
    const summarizedIds = collectMessageIdsFromGenerateCalls(mockGenerateText);

    // Every message up to the last cutoff (msg-10) must have been summarized
    for (let i = 1; i <= 10; i++) {
      expect(summarizedIds).toContain(`msg-${i}`);
    }

    // Messages after the last cutoff should NOT have been summarized
    expect(summarizedIds).not.toContain("msg-11");
    expect(summarizedIds).not.toContain("msg-12");
  });

  it("should handle normal first-time summarization unchanged", async () => {
    mockGenerateText.mockResolvedValue({ text: "First summary" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.cutoffMessageId).toBe("msg-2");
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.not.stringContaining("<previous_summary>"),
      }),
    );
  });
});

describe("isSummaryMessage and extractSummaryText", () => {
  it("should detect summary messages correctly", () => {
    const summaryMsg: UIMessage = {
      id: "test",
      role: "user",
      parts: [
        {
          type: "text",
          text: "<context_summary>\nSome summary\n</context_summary>",
        },
      ],
    };

    const normalMsg: UIMessage = {
      id: "test2",
      role: "user",
      parts: [{ type: "text", text: "Hello world" }],
    };

    const emptyMsg: UIMessage = {
      id: "test3",
      role: "user",
      parts: [],
    };

    expect(isSummaryMessage(summaryMsg)).toBe(true);
    expect(isSummaryMessage(normalMsg)).toBe(false);
    expect(isSummaryMessage(emptyMsg)).toBe(false);
  });

  it("should extract summary text from summary messages", () => {
    const summaryMsg: UIMessage = {
      id: "test",
      role: "user",
      parts: [
        {
          type: "text",
          text: "<context_summary>\nExtracted content here\n</context_summary>",
        },
      ],
    };

    const normalMsg: UIMessage = {
      id: "test2",
      role: "user",
      parts: [{ type: "text", text: "Not a summary" }],
    };

    expect(extractSummaryText(summaryMsg)).toBe("Extracted content here");
    expect(extractSummaryText(normalMsg)).toBeNull();
  });
});
