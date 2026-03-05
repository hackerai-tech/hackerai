/**
 * Tests for context usage emission helpers in chat-stream-helpers.
 *
 * Covers:
 * - writeContextUsage (writes correct data format to writer)
 * - computeContextUsage (separates summary tokens from message tokens)
 * - runSummarizationStep (emits writeContextUsage when summarization happens)
 * - contextUsageEnabled flag behavior
 */

import type { LanguageModel, UIMessage, UIMessageStreamWriter } from "ai";
import type { ContextUsageData } from "@/app/components/ContextUsageIndicator";
import {
  writeContextUsage,
  computeContextUsage,
  buildStepContextUsage,
  runSummarizationStep,
} from "@/lib/api/chat-stream-helpers";

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockCheckAndSummarizeIfNeeded = jest.fn();
jest.mock("@/lib/chat/summarization", () => ({
  checkAndSummarizeIfNeeded: (...args: unknown[]) =>
    mockCheckAndSummarizeIfNeeded(...args),
}));

const mockCountMessagesTokens = jest.fn();
jest.mock("@/lib/token-utils", () => ({
  countMessagesTokens: (...args: unknown[]) => mockCountMessagesTokens(...args),
}));

jest.mock("@/lib/utils/stream-writer-utils", () => ({
  writeRateLimitWarning: jest.fn(),
  writeStepSummarizationStarted: jest.fn(),
  writeStepSummarizationCompleted: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/chat/summarization/step-summary", () => ({
  generateStepSummaryText: jest.fn(),
  extractStepsToSummarize: jest.fn(),
  getSecondToLastToolCallId: jest.fn(),
  countCompletedToolSteps: jest.fn(),
  isStepSummaryMessage: jest.fn(),
  injectStepSummary: jest.fn(),
  MIN_STEPS_TO_SUMMARIZE: 2,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockWriter(): UIMessageStreamWriter & { write: jest.Mock } {
  return { write: jest.fn() } as unknown as UIMessageStreamWriter & {
    write: jest.Mock;
  };
}

function buildSummaryMessage(): UIMessage {
  return {
    id: "msg-summary",
    role: "assistant",
    parts: [
      {
        type: "text" as const,
        text: "<context_summary>This is a summary of earlier conversation.</context_summary>",
      },
    ],
    content:
      "<context_summary>This is a summary of earlier conversation.</context_summary>",
    createdAt: new Date(),
  };
}

function buildUserMessage(text: string = "Hello"): UIMessage {
  return {
    id: "msg-user-1",
    role: "user",
    parts: [{ type: "text" as const, text }],
    content: text,
    createdAt: new Date(),
  };
}

function buildAssistantMessage(text: string = "Hi there"): UIMessage {
  return {
    id: "msg-assistant-1",
    role: "assistant",
    parts: [{ type: "text" as const, text }],
    content: text,
    createdAt: new Date(),
  };
}

const mockLanguageModel = {} as LanguageModel;

// ── writeContextUsage ────────────────────────────────────────────────────────

describe("writeContextUsage", () => {
  it.each([
    {
      name: "typical usage values",
      usage: {
        systemTokens: 500,
        summaryTokens: 200,
        messagesTokens: 1000,
        maxTokens: 4096,
      },
    },
    {
      name: "zero values",
      usage: {
        systemTokens: 0,
        summaryTokens: 0,
        messagesTokens: 0,
        maxTokens: 0,
      },
    },
    {
      name: "large token values",
      usage: {
        systemTokens: 10000,
        summaryTokens: 50000,
        messagesTokens: 100000,
        maxTokens: 200000,
      },
    },
  ])("writes correct data-context-usage format with $name", ({ usage }) => {
    const writer = createMockWriter();

    writeContextUsage(writer as UIMessageStreamWriter, usage);

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith({
      type: "data-context-usage",
      data: usage,
    });
  });

  it("passes the exact usage object reference as data", () => {
    const writer = createMockWriter();
    const usage: ContextUsageData = {
      systemTokens: 100,
      summaryTokens: 200,
      messagesTokens: 300,
      maxTokens: 1000,
    };

    writeContextUsage(writer as UIMessageStreamWriter, usage);

    const writtenData = writer.write.mock.calls[0][0];
    expect(writtenData.data).toBe(usage);
  });
});

// ── buildStepContextUsage ────────────────────────────────────────────────────

describe("buildStepContextUsage", () => {
  const base: ContextUsageData = {
    systemTokens: 500,
    summaryTokens: 200,
    messagesTokens: 3000,
    maxTokens: 128000,
  };

  it.each([
    {
      name: "uses provider tokens when available",
      providerInput: 10000,
      accOutput: 500,
      expected: 10000 - 500 - 200, // 9300
    },
    {
      name: "falls back to base + accumulated when provider reports 0",
      providerInput: 0,
      accOutput: 1200,
      expected: 3000 + 1200, // 4200
    },
    {
      name: "clamps to 0 when provider tokens < system + summary",
      providerInput: 400,
      accOutput: 0,
      expected: 0,
    },
  ])("$name", ({ providerInput, accOutput, expected }) => {
    const result = buildStepContextUsage(base, providerInput, accOutput);
    expect(result.messagesTokens).toBe(expected);
    expect(result.systemTokens).toBe(base.systemTokens);
    expect(result.summaryTokens).toBe(base.summaryTokens);
    expect(result.maxTokens).toBe(base.maxTokens);
  });

  it("does not mutate the base object", () => {
    const original = { ...base };
    buildStepContextUsage(base, 5000, 100);
    expect(base).toEqual(original);
  });
});

// ── computeContextUsage ──────────────────────────────────────────────────────

describe("computeContextUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("separates summary tokens from message tokens when a summary message exists", () => {
    const summaryMsg = buildSummaryMessage();
    const userMsg = buildUserMessage("Hello");
    const assistantMsg = buildAssistantMessage("Hi there");
    const messages = [summaryMsg, userMsg, assistantMsg];
    const fileTokens = {};

    mockCountMessagesTokens
      .mockReturnValueOnce(300) // summary message alone
      .mockReturnValueOnce(500); // non-summary messages

    const result = computeContextUsage(messages, fileTokens, 200, 4096);

    expect(result).toEqual({
      systemTokens: 200,
      summaryTokens: 300,
      messagesTokens: 500,
      maxTokens: 4096,
    });

    // First call: summary message only
    expect(mockCountMessagesTokens).toHaveBeenNthCalledWith(
      1,
      [summaryMsg],
      fileTokens,
    );
    // Second call: non-summary messages
    expect(mockCountMessagesTokens).toHaveBeenNthCalledWith(
      2,
      [userMsg, assistantMsg],
      fileTokens,
    );
  });

  it("returns zero summaryTokens when no summary message exists", () => {
    const userMsg = buildUserMessage("Hello");
    const assistantMsg = buildAssistantMessage("Hi there");
    const messages = [userMsg, assistantMsg];
    const fileTokens = {};

    mockCountMessagesTokens.mockReturnValueOnce(800); // all messages counted once

    const result = computeContextUsage(messages, fileTokens, 150, 8192);

    expect(result).toEqual({
      systemTokens: 150,
      summaryTokens: 0,
      messagesTokens: 800,
      maxTokens: 8192,
    });

    // Only one call for non-summary messages (all messages)
    expect(mockCountMessagesTokens).toHaveBeenCalledTimes(1);
    expect(mockCountMessagesTokens).toHaveBeenCalledWith(messages, fileTokens);
  });

  it("passes systemTokens and maxTokens through unchanged", () => {
    const messages = [buildUserMessage()];
    mockCountMessagesTokens.mockReturnValue(100);

    const result = computeContextUsage(messages, {}, 999, 128000);

    expect(result.systemTokens).toBe(999);
    expect(result.maxTokens).toBe(128000);
  });

  it("passes fileTokens to countMessagesTokens", () => {
    const messages = [buildUserMessage()];
    const fileTokens = { file1: 250, file2: 750 } as any;
    mockCountMessagesTokens.mockReturnValue(1000);

    computeContextUsage(messages, fileTokens, 100, 4096);

    expect(mockCountMessagesTokens).toHaveBeenCalledWith(
      expect.any(Array),
      fileTokens,
    );
  });

  it("identifies summary message by <context_summary> prefix in text part", () => {
    const notASummary: UIMessage = {
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text" as const, text: "Some summary-like text" }],
      content: "Some summary-like text",
      createdAt: new Date(),
    };
    const messages = [notASummary, buildUserMessage()];
    mockCountMessagesTokens.mockReturnValue(400);

    const result = computeContextUsage(messages, {}, 100, 4096);

    // No message starts with <context_summary>, so summaryTokens should be 0
    expect(result.summaryTokens).toBe(0);
    // countMessagesTokens called once with all messages
    expect(mockCountMessagesTokens).toHaveBeenCalledTimes(1);
  });
});

// ── runSummarizationStep context usage emission ──────────────────────────────

describe("runSummarizationStep context usage emission", () => {
  const originalEnv = process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE;
    } else {
      process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE = originalEnv;
    }
    jest.resetModules();
  });

  function baseRunSummarizationOptions(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      messages: [buildUserMessage(), buildAssistantMessage()] as UIMessage[],
      subscription: "pro" as const,
      languageModel: mockLanguageModel,
      mode: "chat" as const,
      writer: createMockWriter() as unknown as UIMessageStreamWriter,
      chatId: "chat-1",
      fileTokens: {} as Record<string, number>,
      todos: [],
      systemPromptTokens: 500,
      ctxSystemTokens: 500,
      ctxMaxTokens: 128000,
      ...overrides,
    };
  }

  describe("when summarization is needed", () => {
    it("calls writeContextUsage on the writer when contextUsageEnabled and summarization occurs", async () => {
      const summarizedMessages = [
        buildSummaryMessage(),
        buildUserMessage(),
      ] as UIMessage[];

      mockCheckAndSummarizeIfNeeded.mockResolvedValue({
        needsSummarization: true,
        summarizedMessages,
      });

      // Mock token counts for computeContextUsage: summary msg, then non-summary msgs
      mockCountMessagesTokens
        .mockReturnValueOnce(1000) // summary message tokens
        .mockReturnValueOnce(2000); // non-summary message tokens

      const writer = createMockWriter();
      const opts = baseRunSummarizationOptions({ writer });

      // We need contextUsageEnabled to be true.
      // Since it's a module-level const, we test via the function's behavior:
      // runSummarizationStep checks `contextUsageEnabled` (module const).
      // We import the already-evaluated module, so we test both paths
      // by checking what the function does. If contextUsageEnabled is false
      // in the test env, the function won't call writeContextUsage even
      // with summarization. We test the logic structure instead.

      const result = await runSummarizationStep(
        opts as Parameters<typeof runSummarizationStep>[0],
      );

      expect(result.needsSummarization).toBe(true);
      expect(result.summarizedMessages).toBe(summarizedMessages);

      // contextUsageEnabled is a module-level const. If it's true, verify emission.
      // If false, verify no emission. Either way, no vacuous pass.
      if (process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE === "true") {
        expect(result.contextUsage).toBeDefined();
        expect(writer.write).toHaveBeenCalledWith({
          type: "data-context-usage",
          data: result.contextUsage,
        });
      } else {
        expect(result.contextUsage).toBeUndefined();
        expect(writer.write).not.toHaveBeenCalled();
      }
    });

    it("returns contextUsage in the result when contextUsageEnabled is true and summarization occurs", async () => {
      const summarizedMessages = [
        buildSummaryMessage(),
        buildUserMessage(),
      ] as UIMessage[];

      mockCheckAndSummarizeIfNeeded.mockResolvedValue({
        needsSummarization: true,
        summarizedMessages,
      });

      mockCountMessagesTokens
        .mockReturnValueOnce(800) // summary tokens
        .mockReturnValueOnce(1500); // message tokens

      const opts = baseRunSummarizationOptions();
      const result = await runSummarizationStep(
        opts as Parameters<typeof runSummarizationStep>[0],
      );

      expect(result.needsSummarization).toBe(true);

      if (process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE === "true") {
        expect(result.contextUsage).toEqual(
          expect.objectContaining({
            systemTokens: expect.any(Number),
            summaryTokens: expect.any(Number),
            messagesTokens: expect.any(Number),
            maxTokens: expect.any(Number),
          }),
        );
      } else {
        expect(result.contextUsage).toBeUndefined();
      }
    });
  });

  describe("when summarization is NOT needed", () => {
    it("does NOT call writeContextUsage and returns no contextUsage", async () => {
      mockCheckAndSummarizeIfNeeded.mockResolvedValue({
        needsSummarization: false,
        summarizedMessages: undefined,
      });

      const writer = createMockWriter();
      const opts = baseRunSummarizationOptions({ writer });
      const result = await runSummarizationStep(
        opts as Parameters<typeof runSummarizationStep>[0],
      );

      expect(result.needsSummarization).toBe(false);
      expect(result.contextUsage).toBeUndefined();
      expect(writer.write).not.toHaveBeenCalled();
    });

    it("does not compute context usage when summarization is not needed", async () => {
      mockCheckAndSummarizeIfNeeded.mockResolvedValue({
        needsSummarization: false,
        summarizedMessages: undefined,
      });

      const opts = baseRunSummarizationOptions();
      await runSummarizationStep(
        opts as Parameters<typeof runSummarizationStep>[0],
      );

      // countMessagesTokens should not be called if summarization is not needed
      expect(mockCountMessagesTokens).not.toHaveBeenCalled();
    });
  });
});

// ── Integration: contextUsageEnabled flag ────────────────────────────────────

describe("contextUsageEnabled module constant", () => {
  it("is controlled by NEXT_PUBLIC_ENABLE_CONTEXT_USAGE env var", async () => {
    // We test the exported constant from the already-loaded module.
    // The value was resolved at import time based on process.env.
    const { contextUsageEnabled } =
      await import("@/lib/api/chat-stream-helpers");
    const expected = process.env.NEXT_PUBLIC_ENABLE_CONTEXT_USAGE === "true";
    expect(contextUsageEnabled).toBe(expected);
  });
});

// ── runSummarizationStep result shape ────────────────────────────────────────

describe("runSummarizationStep result shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    {
      scenario: "summarization not needed",
      mockReturn: { needsSummarization: false, summarizedMessages: undefined },
      expectNeedsSummarization: false,
      expectHasSummarizedMessages: false,
    },
    {
      scenario: "summarization needed",
      mockReturn: {
        needsSummarization: true,
        summarizedMessages: [buildUserMessage()],
      },
      expectNeedsSummarization: true,
      expectHasSummarizedMessages: true,
    },
  ])(
    "returns correct shape when $scenario",
    async ({
      mockReturn,
      expectNeedsSummarization,
      expectHasSummarizedMessages,
    }) => {
      mockCheckAndSummarizeIfNeeded.mockResolvedValue(mockReturn);
      mockCountMessagesTokens.mockReturnValue(500);

      const opts = {
        messages: [buildUserMessage()] as UIMessage[],
        subscription: "pro" as const,
        languageModel: mockLanguageModel,
        mode: "chat" as const,
        writer: createMockWriter() as unknown as UIMessageStreamWriter,
        chatId: "chat-1",
        fileTokens: {} as Record<string, number>,
        todos: [],
        systemPromptTokens: 500,
        ctxSystemTokens: 500,
        ctxMaxTokens: 128000,
      };

      const result = await runSummarizationStep(
        opts as Parameters<typeof runSummarizationStep>[0],
      );

      expect(result.needsSummarization).toBe(expectNeedsSummarization);
      if (expectHasSummarizedMessages) {
        expect(result.summarizedMessages).toBeDefined();
      } else {
        expect(result.summarizedMessages).toBeUndefined();
      }
    },
  );
});
