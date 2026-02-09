import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { UIMessage, UIMessageStreamWriter, LanguageModel } from "ai";
import type { Todo } from "@/types";

describe("checkAndSummarizeIfNeeded", () => {
  const mockGenerateText = jest.fn<() => Promise<any>>();

  const mockConvertToModelMessages = jest.fn<() => Promise<any[]>>();
  const mockCountMessagesTokens = jest.fn<() => number>();
  const mockGetMaxTokensForSubscription = jest.fn<() => number>();
  const mockWriteSummarizationStarted = jest.fn<() => void>();
  const mockWriteSummarizationCompleted = jest.fn<() => void>();
  const mockSaveChatSummary = jest.fn<() => Promise<void>>();
  const mockUuid = jest.fn<() => string>();

  const mockWriter = {} as UIMessageStreamWriter;
  const mockLanguageModel = {} as LanguageModel;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockUuid.mockReturnValue("test-uuid-123");
    mockConvertToModelMessages.mockResolvedValue([]);
    mockSaveChatSummary.mockResolvedValue(undefined);
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../index");

    jest.isolateModules(() => {
      jest.doMock("server-only", () => ({}));

      jest.doMock("ai", () => ({
        generateText: mockGenerateText,
        convertToModelMessages: mockConvertToModelMessages,
      }));

      jest.doMock("uuid", () => ({
        v4: mockUuid,
      }));

      jest.doMock("@/lib/token-utils", () => ({
        countMessagesTokens: mockCountMessagesTokens,
        getMaxTokensForSubscription: mockGetMaxTokensForSubscription,
      }));

      jest.doMock("@/lib/utils/stream-writer-utils", () => ({
        writeSummarizationStarted: mockWriteSummarizationStarted,
        writeSummarizationCompleted: mockWriteSummarizationCompleted,
      }));

      jest.doMock("@/lib/db/actions", () => ({
        saveChatSummary: mockSaveChatSummary,
      }));

      isolatedModule = require("../index");
    });

    return isolatedModule!;
  };

  const createMessage = (
    id: string,
    role: "user" | "assistant",
  ): UIMessage => ({
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

  const setupAboveThreshold = () => {
    mockCountMessagesTokens.mockReturnValue(9500);
    mockGetMaxTokensForSubscription.mockReturnValue(10000);
  };

  it("should skip summarization when message count is insufficient", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    mockCountMessagesTokens.mockReturnValue(1000);
    mockGetMaxTokensForSubscription.mockReturnValue(10000);

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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
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
    expect(result.summarizedMessages.slice(1)).toEqual(fourMessages.slice(-2));
  });

  it("should use agent prompt when mode is agent", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Agent summary" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    await checkAndSummarizeIfNeeded(
      fourMessages,
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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    await checkAndSummarizeIfNeeded(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(mockSaveChatSummary).not.toHaveBeenCalled();
  });

  it("should use fallback summary and complete UI flow when AI fails", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockRejectedValue(new Error("API error"));

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toContain("Summary of");
    expect(result.summaryText).toContain("2 messages");
    expect(mockWriteSummarizationCompleted).toHaveBeenCalled();
  });

  it("should complete UI flow even when database save fails", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Summary" });
    mockSaveChatSummary.mockRejectedValue(new Error("DB error"));

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Summary");
    expect(mockWriteSummarizationCompleted).toHaveBeenCalled();
  });

  it("should include todo list in summary message when todos exist", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const todos: Todo[] = [
      { id: "1", content: "Run nmap scan on target", status: "in_progress" },
      { id: "2", content: "Test for SQL injection", status: "pending" },
      { id: "3", content: "Enumerate subdomains", status: "completed" },
    ];

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
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

  it("should abort summarization and skip persist/completion when signal is aborted", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();

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
        fourMessages,
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

    expect(mockWriteSummarizationStarted).toHaveBeenCalled();
    expect(mockSaveChatSummary).not.toHaveBeenCalled();
    expect(mockWriteSummarizationCompleted).not.toHaveBeenCalled();
  });

  it("should pass abortSignal to generateText", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    const abortController = new AbortController();

    await checkAndSummarizeIfNeeded(
      fourMessages,
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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
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
      createMessage("real-1", "user"),
      createMessage("real-2", "assistant"),
      createMessage("real-3", "user"),
      createMessage("real-4", "assistant"),
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
    // Cutoff must be a real message ID, NOT the synthetic summary's ID
    expect(result.cutoffMessageId).toBe("real-2");
    expect(result.cutoffMessageId).not.toBe("synthetic-uuid-not-in-db");
  });

  it("should skip re-summarization when only summary + 2 real messages", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();

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
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
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
      createMessage("real-1", "user"),
      createMessage("real-2", "assistant"),
      createMessage("real-3", "user"),
      createMessage("real-4", "assistant"),
    ];

    await checkAndSummarizeIfNeeded(
      [summaryMsg, ...realMessages],
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      "chat-123",
    );

    // Verify generateText was called with system prompt containing previous_summary
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

  it("should handle normal first-time summarization unchanged", async () => {
    const { checkAndSummarizeIfNeeded } = getIsolatedModule();

    setupAboveThreshold();
    mockGenerateText.mockResolvedValue({ text: "First summary" });

    const result = await checkAndSummarizeIfNeeded(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.cutoffMessageId).toBe("msg-2");
    // System prompt should NOT contain previous_summary
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.not.stringContaining("<previous_summary>"),
      }),
    );
  });
});

describe("isSummaryMessage and extractSummaryText", () => {
  let helpers: typeof import("../helpers");

  beforeEach(() => {
    jest.resetModules();
    jest.isolateModules(() => {
      jest.doMock("ai", () => ({
        generateText: jest.fn(),
        convertToModelMessages: jest.fn(),
      }));
      jest.doMock("uuid", () => ({ v4: jest.fn() }));
      jest.doMock("@/lib/token-utils", () => ({
        countMessagesTokens: jest.fn(),
        getMaxTokensForSubscription: jest.fn(),
      }));
      jest.doMock("@/lib/db/actions", () => ({
        saveChatSummary: jest.fn(),
      }));
      helpers = require("../helpers");
    });
  });

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

    expect(helpers.isSummaryMessage(summaryMsg)).toBe(true);
    expect(helpers.isSummaryMessage(normalMsg)).toBe(false);
    expect(helpers.isSummaryMessage(emptyMsg)).toBe(false);
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

    expect(helpers.extractSummaryText(summaryMsg)).toBe(
      "Extracted content here",
    );
    expect(helpers.extractSummaryText(normalMsg)).toBeNull();
  });
});
