import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type {
  UIMessage,
  UIMessageStreamWriter,
  LanguageModel,
  ModelMessage,
  ToolSet,
} from "ai";
import type { ChatMode, SubscriptionTier, Todo } from "@/types";
import type { ProviderPromptPressure } from "../provider-pressure";
import {
  getSummarizationThresholdTokens,
  SUMMARIZATION_RESERVED_MAX_TOKENS,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_TODO_BLOCK_MAX_TOKENS,
  SUMMARY_TODO_MAX_ITEMS,
} from "../constants";
import { MAX_TOKENS_PAID, safeCountTokens } from "@/lib/token-utils";

const mockGenerateText = jest.fn<() => Promise<any>>();
const mockSaveChatSummary = jest.fn<() => Promise<void>>();
const mockProviderLanguageModel = jest.fn(
  (modelName: string) => ({ modelId: modelName }) as unknown as LanguageModel,
);

jest.doMock("server-only", () => ({}));
jest.doMock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: mockGenerateText,
}));
jest.doMock("@/lib/db/actions", () => ({
  saveChatSummary: mockSaveChatSummary,
}));
jest.doMock("@/lib/ai/providers", () => ({
  GROK_4_3_SLUG: "x-ai/grok-4.3",
  KIMI_K2_7_CODE_SLUG: "moonshotai/kimi-k2.7-code:exacto",
  myProvider: {
    languageModel: mockProviderLanguageModel,
  },
}));

const { checkAndSummarizeIfNeeded, compactModelMessagesInRun } =
  require("../index") as typeof import("../index");
const {
  isSummaryMessage,
  extractSummaryText,
  buildSummaryMessage,
  boundModelMessagesForSummarization,
  compactModelMessagesForSummarization,
  estimateSummaryInputTokens,
} = require("../helpers") as typeof import("../helpers");

const THRESHOLD = Math.floor(getSummarizationThresholdTokens(MAX_TOKENS_PAID));

const TOKENS_PER_ABOVE_MSG = Math.ceil(THRESHOLD / 4) + 500;

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

const mockLanguageModel = { modelId: "test-model" } as unknown as LanguageModel;

const checkAndSummarizeForTest = (
  uiMessages: UIMessage[],
  subscription: SubscriptionTier,
  languageModel: LanguageModel,
  mode: ChatMode,
  writer: UIMessageStreamWriter,
  chatId: string | null,
  fileTokens: Record<string, number> = {},
  todos: Todo[] = [],
  abortSignal?: AbortSignal,
  ensureSandbox?: () => Promise<any>,
  systemPromptTokens: number = 0,
  providerInputTokens: number = 0,
  chatSystemPrompt: string = "",
  tools?: ToolSet,
  providerOptions?: Record<string, Record<string, unknown>>,
  modelMessages?: ModelMessage[],
  transcriptMessages?: UIMessage[],
  maxTokensOverride?: number,
  providerPromptPressure?: ProviderPromptPressure | null,
) =>
  checkAndSummarizeIfNeeded({
    uiMessages,
    subscription,
    languageModel,
    mode,
    writer,
    chatId,
    fileTokens: fileTokens as any,
    todos,
    abortSignal,
    ensureSandbox,
    systemPromptTokens,
    providerInputTokens,
    chatSystemPrompt,
    tools,
    providerOptions,
    modelMessages,
    transcriptMessages,
    maxTokensOverride,
    providerPromptPressure,
  });

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
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockSaveChatSummary.mockResolvedValue(undefined);
    mockWriter = createMockWriter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should cap reserved summarization headroom at 20k tokens", () => {
    expect(getSummarizationThresholdTokens(128_000)).toBe(115_200);
    expect(getSummarizationThresholdTokens(400_000)).toBe(
      400_000 - SUMMARIZATION_RESERVED_MAX_TOKENS,
    );
  });

  it("compacts live model history without persisting an in-flight cutoff", async () => {
    mockGenerateText.mockResolvedValue({
      text: "Runtime summary",
      usage: { inputTokens: 120, outputTokens: 20 },
    });
    const modelMessages: ModelMessage[] = [
      { role: "user", content: "durable user request" },
      { role: "assistant", content: "new in-flight tool work" },
    ];

    const result = await compactModelMessagesInRun({
      modelMessages,
      transcriptModelMessages: modelMessages,
      subscription: "pro",
      languageModel: mockLanguageModel,
      mode: "agent",
      writer: mockWriter,
      chatId: "chat-runtime-compaction",
      maxTokens: 128_000,
      compactionIndex: 2,
      hasExistingSummary: true,
    });

    expect(result?.summaryText).toBe("Runtime summary");
    expect(mockSaveChatSummary).not.toHaveBeenCalled();
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining(modelMessages),
      }),
    );
    expect((mockWriter.write as jest.Mock).mock.calls).toEqual([
      [
        expect.objectContaining({
          type: "data-summarization",
          id: "summarization-status-2",
          data: expect.objectContaining({ status: "started" }),
        }),
      ],
    ]);
  });

  it("clears the transient in-run status when summary generation fails", async () => {
    mockGenerateText.mockRejectedValue(new Error("provider failed"));
    const modelMessages: ModelMessage[] = [
      { role: "user", content: "live context" },
    ];

    const result = await compactModelMessagesInRun({
      modelMessages,
      transcriptModelMessages: modelMessages,
      subscription: "pro",
      languageModel: mockLanguageModel,
      mode: "agent",
      writer: mockWriter,
      chatId: "chat-runtime-failure",
      maxTokens: 128_000,
      compactionIndex: 3,
      hasExistingSummary: false,
    });

    expect(result).toBeNull();
    expect((mockWriter.write as jest.Mock).mock.calls).toEqual([
      [
        expect.objectContaining({
          id: "summarization-status-3",
          data: expect.objectContaining({ status: "started" }),
        }),
      ],
      [
        expect.objectContaining({
          id: "summarization-status-3",
          data: { status: "completed", message: "" },
          transient: true,
        }),
      ],
    ]);
    expect(mockSaveChatSummary).not.toHaveBeenCalled();
  });

  it("should allow a lower summarization threshold in development", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDevThreshold =
      process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS;

    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS = "12000";

    try {
      expect(getSummarizationThresholdTokens(128_000)).toBe(12_000);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalDevThreshold === undefined) {
        delete process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS;
      } else {
        process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS =
          originalDevThreshold;
      }
    }
  });

  it("should ignore the development threshold outside development", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDevThreshold =
      process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS;

    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS = "12000";

    try {
      expect(getSummarizationThresholdTokens(128_000)).toBe(115_200);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalDevThreshold === undefined) {
        delete process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS;
      } else {
        process.env.NEXT_PUBLIC_DEV_SUMMARIZATION_THRESHOLD_TOKENS =
          originalDevThreshold;
      }
    }
  });

  it("should skip summarization when message count is insufficient", async () => {
    const messages = [createMessage("msg-1", "user")];

    const result = await checkAndSummarizeForTest(
      messages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.summarizationAttempted).toBe(false);
    expect(result.needsSummarization).toBe(false);
    expect(result.summarizedMessages).toBe(messages);
    expect(result.cutoffMessageId).toBeNull();
    expect(result.summaryText).toBeNull();
  });

  it("should skip summarization when tokens are below threshold", async () => {
    const result = await checkAndSummarizeForTest(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.summarizationAttempted).toBe(false);
    expect(result.needsSummarization).toBe(false);
    expect(result.summarizedMessages).toBe(fourMessages);
  });

  it("should summarize below-token prompts when provider pressure is high", async () => {
    mockGenerateText.mockResolvedValue({ text: "Pressure summary" });

    const result = await checkAndSummarizeIfNeeded({
      uiMessages: fourMessages,
      subscription: "pro",
      languageModel: mockLanguageModel,
      mode: "ask",
      writer: mockWriter,
      chatId: "chat-pressure",
      chatSystemPrompt: "test-system-prompt",
      providerPromptPressure: {
        reason: "tool_result_count",
        reasons: ["tool_result_count"],
        toolResultCount: 101,
        messageCount: 101,
        summarizationMaxTokensOverride: 128_000,
      },
    });

    expect(result.summarizationAttempted).toBe(true);
    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Pressure summary");
    expect(mockSaveChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-pressure",
        metadata: expect.objectContaining({
          reason: "provider_pressure",
          promptVersion: SUMMARY_PROMPT_VERSION,
        }),
      }),
    );
  });

  it("logs compact compaction diagnostics without file contents", async () => {
    mockGenerateText.mockResolvedValue({ text: "Pressure summary" });

    await checkAndSummarizeIfNeeded({
      uiMessages: [
        {
          id: "msg-pdf",
          role: "user",
          parts: [
            { type: "text", text: "tell me about this pdf" },
            {
              type: "file",
              fileId: "file_large_pdf" as any,
              mediaType: "application/pdf",
              name: "sensitive-report.pdf",
            },
          ],
        },
      ],
      subscription: "pro",
      languageModel: mockLanguageModel,
      mode: "ask",
      writer: mockWriter,
      chatId: "chat-pressure-log",
      fileTokens: {
        file_large_pdf: 42_000,
        file_small: 7,
      } as any,
      chatSystemPrompt: "test-system-prompt",
      providerPromptPressure: {
        reason: "serialized_message_bytes",
        reasons: ["serialized_message_bytes"],
        serializedMessageBytes: 500_000,
        toolResultCount: 0,
        messageCount: 1,
        summarizationMaxTokensOverride: 128_000,
      },
    });

    const logCall = (console.info as jest.Mock).mock.calls.find((call) =>
      String(call[0]).includes('"event":"chat_context_compaction_started"'),
    );
    expect(logCall).toBeTruthy();

    const log = JSON.parse(String(logCall?.[0]));
    expect(log).toMatchObject({
      level: "info",
      event: "chat_context_compaction_started",
      service: "chat-handler",
      chat_id: "chat-pressure-log",
      mode: "ask",
      subscription: "pro",
      reason: "provider_pressure",
      provider_pressure_reason: "serialized_message_bytes",
      provider_pressure_reasons: ["serialized_message_bytes"],
      provider_pressure_serialized_message_bytes: 500_000,
      file_count: 2,
      total_file_tokens: 42_007,
      largest_file_tokens: 42_000,
      cutoff_message_id: "msg-pdf",
    });
    expect(JSON.stringify(log)).not.toContain("sensitive-report.pdf");
  });

  it("should ignore a zero max token override instead of summarizing every free ask message", async () => {
    const result = await checkAndSummarizeForTest(
      fourMessages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );

    expect(result.summarizationAttempted).toBe(false);
    expect(result.needsSummarization).toBe(false);
    expect(result.summarizedMessages).toBe(fourMessages);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("should summarize and return correct structure when threshold exceeded", async () => {
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Test summary content");
    expect(result.cutoffMessageId).toBe("msg-3");

    // summary message + projected retained tail
    expect(result.summarizedMessages).toHaveLength(2);
    expect(result.summarizedMessages[0].parts[0]).toEqual({
      type: "text",
      text: "<context_summary>\nTest summary content\n</context_summary>",
    });
    expect(result.summarizedMessages[1].id).toBe("msg-4");

    const serializedSummaryInput = JSON.stringify(
      mockGenerateText.mock.calls[0][0].messages,
    );
    expect(serializedSummaryInput).toContain("[msg-3]");
    expect(serializedSummaryInput).not.toContain("[msg-4]");
  });

  it("should not retain a placeholder for a tail-only oversized tool part", async () => {
    mockGenerateText.mockResolvedValue({ text: "Oversized tool summary" });

    const hugeOutput = Array.from(
      { length: 20_000 },
      (_, index) => `unique-projected-tail-line-${index}`,
    ).join("\n");
    const messages: UIMessage[] = [
      {
        id: "assistant-huge",
        role: "assistant",
        parts: [
          {
            type: "tool-run_terminal_cmd",
            state: "output-available",
            output: hugeOutput,
          } as any,
        ],
      },
    ];

    const result = await checkAndSummarizeForTest(
      messages,
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      "chat-tail-only",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        reason: "tool_result_count",
        reasons: ["tool_result_count"],
        toolResultCount: 1,
        messageCount: 1,
        summarizationMaxTokensOverride: 128_000,
      },
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.cutoffMessageId).toBe("assistant-huge");
    expect(result.summarizedMessages).toHaveLength(1);

    const serializedSummaryInput = JSON.stringify(
      mockGenerateText.mock.calls[0][0].messages,
    );
    expect(serializedSummaryInput).toContain(
      "[run_terminal_cmd output preview:",
    );
    expect(serializedSummaryInput).not.toContain("retained tail");
    expect(JSON.stringify(result.summarizedMessages)).not.toContain(hugeOutput);
    expect(JSON.stringify(result.summarizedMessages)).not.toContain(
      "retained tail",
    );
    expect(mockSaveChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-tail-only",
        summaryUpToMessageId: "assistant-huge",
        metadata: expect.not.objectContaining({
          retainedTail: expect.anything(),
        }),
      }),
    );
  });

  it("should use agent prompt when mode is agent", async () => {
    mockGenerateText.mockResolvedValue({ text: "Agent summary" });

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.needsSummarization).toBe(true);
    const callArgs = mockGenerateText.mock.calls[0][0];
    const messages = callArgs.messages as Array<{
      role: string;
      content: string;
    }>;
    const lastMessage = messages[messages.length - 1];
    const lastContent =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : (lastMessage.content as Array<{ text: string }>)
            .map((p: { text: string }) => p.text)
            .join("");
    expect(lastContent).toContain("security agent");
  });

  it("should compact huge tool outputs before sending modelMessages to the summarizer", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    const rawToolOutput = Array.from(
      { length: 12_000 },
      (_, i) => `unique-tool-line-${i}: ${"x".repeat(32)}`,
    ).join("\n");
    const modelMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-huge",
            toolName: "run_terminal_cmd",
            input: { command: "cat huge.log" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-huge",
            toolName: "run_terminal_cmd",
            output: {
              type: "text",
              value: rawToolOutput,
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const callMessages = compactModelMessagesForSummarization(
      modelMessages,
    ) as Array<{
      role: string;
      content: Array<{
        type: string;
        output?: { type: string; value: string };
      }>;
    }>;
    const toolMessage = callMessages.find((message) => message.role === "tool");
    const output = toolMessage?.content[0]?.output;

    expect(output).toEqual({
      type: "text",
      value: expect.stringContaining("run_terminal_cmd output preview"),
    });
    expect(output?.value.length).toBeLessThan(rawToolOutput.length);
    expect(output?.value).not.toContain("unique-tool-line-6000");
    expect(JSON.stringify(callMessages)).not.toContain(rawToolOutput);
  });

  it("should strip media-ish payloads from summarization modelMessages", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    const dataUri = `data:image/png;base64,${"a".repeat(10_000)}`;
    const rawSnapshot = `dom-node-${"b".repeat(10_000)}`;
    const modelMessages = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            filename: "upload.png",
            data: dataUri,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-media",
            toolName: "open_url",
            input: { url: "https://example.test" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-media",
            toolName: "open_url",
            output: {
              type: "json",
              value: {
                screenshot: {
                  mime: "image/png",
                  filename: "page.png",
                  url: dataUri,
                },
                rawSnapshot,
                title: "Example page",
              },
            },
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const serializedMessages = JSON.stringify(
      compactModelMessagesForSummarization(modelMessages),
    );

    expect(serializedMessages).toContain("[Attached image/png: page.png]");
    expect(serializedMessages).toContain("[Attached image/png: upload.png]");
    expect(serializedMessages).toContain("[rawSnapshot omitted for summary]");
    expect(serializedMessages).toContain("media payloads omitted");
    expect(serializedMessages).not.toContain(dataUri);
    expect(serializedMessages).not.toContain(rawSnapshot);
  });

  it("should convert native image and binary file parts to text placeholders", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            image: new Uint8Array([1, 2, 3, 4]),
          },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "report.pdf",
            data: new Uint8Array([5, 6, 7, 8]),
          },
        ],
      },
    ] as unknown as ModelMessage[];

    const compacted = compactModelMessagesForSummarization(messages);

    expect(compacted[0].content).toEqual([
      { type: "text", text: "[Attached image/png: file]" },
      { type: "text", text: "[Attached application/pdf: report.pdf]" },
    ]);
    expect(JSON.stringify(compacted)).not.toContain('"0":1');
  });

  it("should bound total summarization modelMessages input", () => {
    const hugeText = `keep-start ${"huge-text ".repeat(20_000)} keep-end`;
    const messages = [
      {
        role: "user",
        content: hugeText,
      },
    ] as unknown as ModelMessage[];

    const bounded = boundModelMessagesForSummarization(messages, {
      maxInputTokens: 512,
    });
    const serializedMessages = JSON.stringify(bounded);

    expect(estimateSummaryInputTokens(bounded)).toBeLessThanOrEqual(512);
    expect(serializedMessages).toContain("Summary input shortened");
    expect(serializedMessages).not.toContain(hugeText);
  });

  it("should persist summary when chatId is provided", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(mockSaveChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-123",
        summaryText: "Summary",
        summaryUpToMessageId: "msg-3",
        metadata: expect.objectContaining({
          reason: "token_threshold",
          promptVersion: SUMMARY_PROMPT_VERSION,
          model: "test-model",
          status: "completed",
          retainedTail: expect.objectContaining({
            start_message_id: "msg-4",
            start_part_index: 0,
            strategy: "token_budgeted_tail_v1",
          }),
        }),
      }),
    );
    const saveSummaryCall =
      mockSaveChatSummary.mock.calls[mockSaveChatSummary.mock.calls.length - 1];
    const persistedMetadata = saveSummaryCall?.[0].metadata as
      Record<string, unknown> | undefined;
    expect(persistedMetadata?.inputTokens).toBeUndefined();
    expect(persistedMetadata?.outputTokens).toBeUndefined();
    expect(persistedMetadata?.cacheReadTokens).toBeUndefined();
    expect(persistedMetadata?.cacheWriteTokens).toBeUndefined();
    expect(persistedMetadata?.cost).toBeUndefined();
    expect(persistedMetadata?.estimatedCompactedInputTokens).toBeUndefined();
  });

  it("should skip database persistence for temporary chats", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });

    await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(mockSaveChatSummary).not.toHaveBeenCalled();
  });

  it("should write summarization completed even when AI fails", async () => {
    mockGenerateText.mockRejectedValue(new Error("API error"));

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.needsSummarization).toBe(false);
    expect(result.summaryText).toBeNull();
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    const writeCalls = (mockWriter.write as jest.Mock).mock.calls;
    const completedWrite = writeCalls.find(
      (call) =>
        call[0]?.type === "data-summarization" &&
        call[0]?.data?.status === "completed",
    );
    expect(completedWrite).toBeDefined();
  });

  it("retries malformed provider JSON with the fallback summarization model", async () => {
    const malformedJsonError = Object.assign(
      new Error("Invalid JSON response"),
      {
        statusCode: 200,
        responseBody: "\n         \n\n",
        responseHeaders: {
          "x-generation-id": "gen-primary",
        },
      },
    );
    mockGenerateText
      .mockRejectedValueOnce(malformedJsonError)
      .mockResolvedValueOnce({
        text: "Fallback summary",
        usage: { inputTokens: 10, outputTokens: 3 },
      });

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-retry",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
      {
        runCommand: {
          description: "run a command",
          inputSchema: {} as any,
          execute: jest.fn(),
        },
      } as unknown as ToolSet,
      {
        openrouter: {
          user: "user_123",
          reasoning: { enabled: false },
          models: ["minimax/minimax-m3"],
        },
      },
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Fallback summary");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockProviderLanguageModel).toHaveBeenCalledWith(
      "fallback-ask-model",
    );

    const retryCall = mockGenerateText.mock.calls[1][0];
    expect(retryCall.model).toMatchObject({ modelId: "fallback-ask-model" });
    expect(retryCall.tools).toBeUndefined();
    expect(retryCall.providerOptions).toEqual({
      openrouter: {
        user: "user_123",
        reasoning: { enabled: false },
        models: ["moonshotai/kimi-k2.7-code:exacto", "x-ai/grok-4.3"],
      },
    });

    const retryLogCall = (console.warn as jest.Mock).mock.calls.find((call) =>
      String(call[0]).includes('"event":"chat_context_compaction_retrying"'),
    );
    expect(retryLogCall).toBeTruthy();

    const retryLog = JSON.parse(String(retryLogCall?.[0]));
    expect(retryLog).toMatchObject({
      level: "warn",
      event: "chat_context_compaction_retrying",
      service: "chat-handler",
      chat_id: "chat-retry",
      mode: "ask",
      subscription: "free",
      summarization_attempt: "primary",
      retry_model_name: "fallback-ask-model",
      retry_without_tools: true,
      provider_status_code: 200,
      openrouter_generation_id: "gen-primary",
      response_body_empty: true,
    });

    expect(mockSaveChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-retry",
        metadata: expect.objectContaining({
          model: "fallback-ask-model",
        }),
      }),
    );
  });

  it("retries malformed provider JSON nested in retry wrapper errors", async () => {
    const malformedJsonError = Object.assign(
      new Error("JSON parsing failed: Unexpected end of JSON input"),
      {
        statusCode: 200,
        responseBody: "   \n\n",
      },
    );
    const retryWrapperError = Object.assign(
      new Error("AI retry attempts exhausted"),
      {
        errors: [malformedJsonError],
      },
    );
    mockGenerateText
      .mockRejectedValueOnce(retryWrapperError)
      .mockResolvedValueOnce({
        text: "Nested fallback summary",
        usage: { inputTokens: 10, outputTokens: 3 },
      });

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-nested-retry",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.summaryText).toBe("Nested fallback summary");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockProviderLanguageModel).toHaveBeenCalledWith(
      "fallback-ask-model",
    );
  });

  it("logs structured compaction failure when malformed JSON retry also fails", async () => {
    const malformedJsonError = Object.assign(
      new Error("Invalid JSON response"),
      {
        statusCode: 200,
        responseBody: "\n\n",
      },
    );
    mockGenerateText
      .mockRejectedValueOnce(malformedJsonError)
      .mockRejectedValueOnce(new Error("Fallback provider unavailable"));

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-retry-failed",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.summarizationAttempted).toBe(true);
    expect(result.needsSummarization).toBe(false);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);

    const failedLogCall = (console.error as jest.Mock).mock.calls.find((call) =>
      String(call[0]).includes('"event":"chat_context_compaction_failed"'),
    );
    expect(failedLogCall).toBeTruthy();

    const failedLog = JSON.parse(String(failedLogCall?.[0]));
    expect(failedLog).toMatchObject({
      level: "error",
      event: "chat_context_compaction_failed",
      service: "chat-handler",
      chat_id: "chat-retry-failed",
      mode: "ask",
      subscription: "free",
      summarization_attempt: "fallback",
      model_id: "fallback-ask-model",
      fallback_result: "no_summarization",
      error_message: "Fallback provider unavailable",
    });
  });

  it("should write summarization completed even when database save fails", async () => {
    mockGenerateText.mockResolvedValue({ text: "Summary" });
    mockSaveChatSummary.mockRejectedValue(new Error("DB error"));

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
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

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      todos,
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
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

  it("should bound todo content in summary messages", () => {
    const todos: Todo[] = Array.from(
      { length: SUMMARY_TODO_MAX_ITEMS + 25 },
      (_, index) => ({
        id: `todo-${index}`,
        content: `todo-${index} ${"large todo content ".repeat(1000)}`,
        status: "pending",
      }),
    );

    const summaryMessage = buildSummaryMessage("Bounded summary", todos);
    const summaryText = summaryMessage.parts[0];

    expect(summaryText).toEqual({
      type: "text",
      text: expect.stringContaining("<current_todos>"),
    });
    expect(summaryText).toEqual({
      type: "text",
      text: expect.stringContaining("[... current_todos truncated ...]"),
    });

    if (summaryText.type !== "text") {
      throw new Error("Expected summary message to contain text");
    }

    expect(summaryText.text).not.toContain("todo-124");
    expect(safeCountTokens(summaryText.text)).toBeLessThanOrEqual(
      SUMMARY_TODO_BLOCK_MAX_TOKENS + 32,
    );
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
      checkAndSummarizeForTest(
        fourMessagesAboveThreshold,
        "free",
        mockLanguageModel,
        "ask",
        mockWriter,
        "chat-123",
        {},
        [],
        abortController.signal,
        undefined,
        0,
        0,
        "test-system-prompt",
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

    await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      abortController.signal,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });

  it("should not include todo block in summary when todos are empty", async () => {
    mockGenerateText.mockResolvedValue({ text: "Test summary content" });

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      null,
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
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

    const result = await checkAndSummarizeForTest(
      [summaryMsg, ...realMessages],
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.cutoffMessageId).toBe("real-3");
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
    const result = await checkAndSummarizeForTest(
      input,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
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

    await checkAndSummarizeForTest(
      [summaryMsg, ...realMessages],
      "free",
      mockLanguageModel,
      "agent",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    const callArgs = mockGenerateText.mock.calls[0][0];
    // System should be the chat system prompt, not the summarization prompt
    expect(callArgs.system).toBe("test-system-prompt");
    // The last message should contain incremental instructions
    const messages = callArgs.messages as Array<{
      role: string;
      content: string | Array<{ text: string }>;
    }>;
    const lastMessage = messages[messages.length - 1];
    const lastContent =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : (lastMessage.content as Array<{ text: string }>)
            .map((p: { text: string }) => p.text)
            .join("");
    expect(lastContent).toContain("INCREMENTAL summarization");
    // The summary message should be in the messages (not stripped)
    const hasContextSummary = messages.some((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content as Array<{ text: string }>)
              .map((p: { text: string }) => p.text)
              .join("");
      return text.includes("<context_summary>");
    });
    expect(hasContextSummary).toBe(true);
  });

  it("should produce 2 summaries when threshold is triggered twice", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "First summary" });
    mockGenerateText.mockResolvedValueOnce({ text: "Second summary" });

    const result1 = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result1.needsSummarization).toBe(true);
    expect(result1.cutoffMessageId).toBe("msg-3");

    const newMessages = [
      createMessageWithTokens("msg-5", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-6", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-7", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-8", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const secondInput = [...result1.summarizedMessages, ...newMessages];

    const result2 = await checkAndSummarizeForTest(
      secondInput,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result2.needsSummarization).toBe(true);
    expect(mockSaveChatSummary).toHaveBeenCalledTimes(2);
    expect(mockSaveChatSummary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ summaryUpToMessageId: "msg-3" }),
    );
    expect(mockSaveChatSummary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        summaryUpToMessageId: "msg-7",
      }),
    );

    const secondCallArgs = mockGenerateText.mock.calls[1][0];
    // System should be the chat system prompt, not the summarization prompt
    expect(secondCallArgs.system).toBe("test-system-prompt");

    // The summary message should now be in the second call messages (we pass uiMessages which includes it)
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
    expect(hasContextSummary).toBe(true);

    // The last message of the second call should contain incremental instructions
    const secondLastMessage = secondCallMessages[secondCallMessages.length - 1];
    const secondLastContent =
      typeof secondLastMessage.content === "string"
        ? secondLastMessage.content
        : (secondLastMessage.content as Array<{ text: string }>)
            .map((p: { text: string }) => p.text)
            .join("");
    expect(secondLastContent).toContain("INCREMENTAL summarization");

    // First call: msg-1..msg-3 converted + 1 summarization prompt = 4
    const firstCallMessages = mockGenerateText.mock.calls[0][0].messages;
    expect(firstCallMessages).toHaveLength(4);
    // Second call: 1 summary message + retained msg-4 + msg-5..msg-7 + 1 summarization prompt = 6
    expect(secondCallMessages).toHaveLength(6);

    expect(result2.summarizedMessages).toHaveLength(2);
    expect(isSummaryMessage(result2.summarizedMessages[0])).toBe(true);
    expect(extractSummaryText(result2.summarizedMessages[0])).toBe(
      "Second summary",
    );
    expect(result2.summarizedMessages[1].id).toBe("msg-8");
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

    const result1 = await checkAndSummarizeForTest(
      round1Messages,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );
    expect(result1.cutoffMessageId).toBe("msg-3");

    // Round 2: result1 + msg-5..msg-8
    const round2Input = [
      ...result1.summarizedMessages,
      createMessageWithTokens("msg-5", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-6", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-7", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-8", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const result2 = await checkAndSummarizeForTest(
      round2Input,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );
    expect(result2.cutoffMessageId).toBe("msg-7");

    // Round 3: result2 + msg-9..msg-12
    const round3Input = [
      ...result2.summarizedMessages,
      createMessageWithTokens("msg-9", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-10", "assistant", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-11", "user", TOKENS_PER_ABOVE_MSG),
      createMessageWithTokens("msg-12", "assistant", TOKENS_PER_ABOVE_MSG),
    ];

    const result3 = await checkAndSummarizeForTest(
      round3Input,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );
    expect(result3.cutoffMessageId).toBe("msg-11");

    // Collect all message IDs that were passed to generateText across all 3 calls
    const summarizedIds = collectMessageIdsFromGenerateCalls(mockGenerateText);

    // Every message up to the cutoff must have been summarized. The latest
    // retained-tail message remains unsummarized until the next compaction.
    for (let i = 1; i <= 11; i++) {
      expect(summarizedIds).toContain(`msg-${i}`);
    }
    expect(summarizedIds).not.toContain("msg-12");
  });

  it("should handle normal first-time summarization unchanged", async () => {
    mockGenerateText.mockResolvedValue({ text: "First summary" });

    const result = await checkAndSummarizeForTest(
      fourMessagesAboveThreshold,
      "free",
      mockLanguageModel,
      "ask",
      mockWriter,
      "chat-123",
      {},
      [],
      undefined,
      undefined,
      0,
      0,
      "test-system-prompt",
    );

    expect(result.needsSummarization).toBe(true);
    expect(result.cutoffMessageId).toBe("msg-3");

    const callArgs = mockGenerateText.mock.calls[0][0];
    // System should be the chat system prompt
    expect(callArgs.system).toBe("test-system-prompt");
    // Messages should NOT contain context_summary (first-time = no summary message)
    const messages = callArgs.messages as Array<{
      role: string;
      content: string | Array<{ text: string }>;
    }>;
    const hasContextSummary = messages.some((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content as Array<{ text: string }>)
              .map((p: { text: string }) => p.text)
              .join("");
      return text.includes("<context_summary>");
    });
    expect(hasContextSummary).toBe(false);
    // Last message should contain summarization prompt but NOT "INCREMENTAL"
    const lastMessage = messages[messages.length - 1];
    const lastContent =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : (lastMessage.content as Array<{ text: string }>)
            .map((p: { text: string }) => p.text)
            .join("");
    expect(lastContent).not.toContain("INCREMENTAL");
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

describe("splitMessages with MESSAGES_TO_KEEP_UNSUMMARIZED = 0", () => {
  const { splitMessages } =
    require("../helpers") as typeof import("../helpers");

  it("should return all messages as messagesToSummarize when constant is 0", () => {
    const messages: UIMessage[] = [
      createMessage("msg-1", "user"),
      createMessage("msg-2", "assistant"),
      createMessage("msg-3", "user"),
    ];

    const result = splitMessages(messages);
    expect(result.messagesToSummarize).toEqual(messages);
    expect(result.lastMessages).toEqual([]);
  });

  it("should handle empty array", () => {
    const result = splitMessages([]);
    expect(result.messagesToSummarize).toEqual([]);
    expect(result.lastMessages).toEqual([]);
  });

  it("should handle single message", () => {
    const messages: UIMessage[] = [createMessage("msg-1", "user")];
    const result = splitMessages(messages);
    expect(result.messagesToSummarize).toEqual(messages);
    expect(result.lastMessages).toEqual([]);
  });
});
