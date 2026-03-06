/**
 * Tests for runStepSummarizationCheck writer integration.
 *
 * Verifies that when a writer is provided:
 * - writeStepSummarizationStarted is called before summarization
 * - writeStepSummarizationCompleted is called after summarization (in finally)
 * - completed is still called when summarization fails (unless abortSignal aborted)
 * - no errors occur when writer is not provided
 */

import { runStepSummarizationCheck } from "@/lib/api/chat-stream-helpers";

// ── Mock step-summary utilities ─────────────────────────────────────────────

const mockGenerateStepSummaryText = jest.fn();
const mockExtractStepsToSummarize = jest.fn();
const mockGetSecondToLastToolCallId = jest.fn();
const mockCountCompletedToolSteps = jest.fn();
const mockIsStepSummaryMessage = jest.fn();
const mockInjectStepSummary = jest.fn();

jest.mock("@/lib/chat/summarization/step-summary", () => ({
  generateStepSummaryText: (...args: unknown[]) =>
    mockGenerateStepSummaryText(...args),
  extractStepsToSummarize: (...args: unknown[]) =>
    mockExtractStepsToSummarize(...args),
  getSecondToLastToolCallId: (...args: unknown[]) =>
    mockGetSecondToLastToolCallId(...args),
  countCompletedToolSteps: (...args: unknown[]) =>
    mockCountCompletedToolSteps(...args),
  isStepSummaryMessage: (...args: unknown[]) =>
    mockIsStepSummaryMessage(...args),
  injectStepSummary: (...args: unknown[]) => mockInjectStepSummary(...args),
  MIN_STEPS_TO_SUMMARIZE: 2,
}));

// ── Mock writer utilities ───────────────────────────────────────────────────

const mockWriteStepSummarizationStarted = jest.fn();
const mockWriteStepSummarizationCompleted = jest.fn();

jest.mock("@/lib/utils/stream-writer-utils", () => ({
  writeRateLimitWarning: jest.fn(),
  writeStepSummarizationStarted: (...args: unknown[]) =>
    mockWriteStepSummarizationStarted(...args),
  writeStepSummarizationCompleted: (...args: unknown[]) =>
    mockWriteStepSummarizationCompleted(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildMessages() {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Do something" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "tool_a",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "tool_a",
          output: "ok",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "tool_b",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "tool_b",
          output: "ok",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_3",
          toolName: "tool_c",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_3",
          toolName: "tool_c",
          output: "ok",
        },
      ],
    },
  ];
}

const mockLanguageModel = {} as any;

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    messages: buildMessages(),
    languageModel: mockLanguageModel,
    existingSummary: null,
    lastStepInputTokens: 50000,
    lastStepOutputTokens: 0,
    maxTokens: 60000,
    thresholdPercentage: 0.7,
    abortSignal: undefined,
    ...overrides,
  };
}

/** Set up mocks so summarization WILL be triggered. */
function setupSummarizationWillHappen() {
  mockIsStepSummaryMessage.mockReturnValue(false);
  mockCountCompletedToolSteps.mockReturnValue(3);
  mockGetSecondToLastToolCallId.mockReturnValue("call_2");
  mockExtractStepsToSummarize.mockReturnValue([
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1" }],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_2" }],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_2" }] },
  ]);
  mockGenerateStepSummaryText.mockResolvedValue("Summary of steps 1-2");
  mockInjectStepSummary.mockReturnValue([
    { role: "user", content: [{ type: "text", text: "Do something" }] },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<step_summary>\nSummary of steps 1-2\n</step_summary>",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_3",
          toolName: "tool_c",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_3",
          toolName: "tool_c",
          output: "ok",
        },
      ],
    },
  ]);
}

/** Set up mocks so summarization will NOT be needed (below threshold). */
function setupBelowThreshold() {
  // lastStepInputTokens <= threshold means no summarization
  // We achieve this by passing low lastStepInputTokens in options
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runStepSummarizationCheck writer integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  describe("when writer is provided and summarization happens", () => {
    it("calls writeStepSummarizationStarted before generateStepSummaryText", async () => {
      setupSummarizationWillHappen();

      const callOrder: string[] = [];
      mockWriteStepSummarizationStarted.mockImplementation(() => {
        callOrder.push("started");
      });
      mockGenerateStepSummaryText.mockImplementation(async () => {
        callOrder.push("generate");
        return "Summary of steps 1-2";
      });
      mockWriteStepSummarizationCompleted.mockImplementation(() => {
        callOrder.push("completed");
      });

      const mockWriter = { write: jest.fn() };
      await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(callOrder).toEqual(["started", "generate", "completed"]);
    });

    it("calls writeStepSummarizationStarted with the writer", async () => {
      setupSummarizationWillHappen();

      const mockWriter = { write: jest.fn() };
      await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(mockWriteStepSummarizationStarted).toHaveBeenCalledWith(
        mockWriter,
      );
    });

    it("calls writeStepSummarizationCompleted with the writer", async () => {
      setupSummarizationWillHappen();

      const mockWriter = { write: jest.fn() };
      await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(mockWriteStepSummarizationCompleted).toHaveBeenCalledWith(
        mockWriter,
      );
    });
  });

  describe("when writer is provided but summarization is NOT needed", () => {
    it.each([
      {
        scenario: "below threshold (low input tokens)",
        overrides: { lastStepInputTokens: 1000 },
      },
    ])(
      "does not call writer functions when $scenario",
      async ({ overrides }) => {
        setupBelowThreshold();

        const mockWriter = { write: jest.fn() };
        await runStepSummarizationCheck({
          ...baseOptions(overrides),
          writer: mockWriter as any,
        });

        expect(mockWriteStepSummarizationStarted).not.toHaveBeenCalled();
        expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
      },
    );

    it("does not call writer functions when not enough completed steps", async () => {
      mockIsStepSummaryMessage.mockReturnValue(false);
      mockCountCompletedToolSteps.mockReturnValue(1); // Below MIN_STEPS_TO_SUMMARIZE

      const mockWriter = { write: jest.fn() };
      await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(mockWriteStepSummarizationStarted).not.toHaveBeenCalled();
      expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
    });

    it("does not call writer functions when no cutoff toolCallId found", async () => {
      mockIsStepSummaryMessage.mockReturnValue(false);
      mockCountCompletedToolSteps.mockReturnValue(3);
      mockGetSecondToLastToolCallId.mockReturnValue(null);

      const mockWriter = { write: jest.fn() };
      await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(mockWriteStepSummarizationStarted).not.toHaveBeenCalled();
      expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
    });

    it("does not call writer functions when extractStepsToSummarize returns empty", async () => {
      mockIsStepSummaryMessage.mockReturnValue(false);
      mockCountCompletedToolSteps.mockReturnValue(3);
      mockGetSecondToLastToolCallId.mockReturnValue("call_2");
      mockExtractStepsToSummarize.mockReturnValue([]);

      const mockWriter = { write: jest.fn() };
      await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(mockWriteStepSummarizationStarted).not.toHaveBeenCalled();
      expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
    });
  });

  describe("when writer is provided but summarization fails", () => {
    it("still calls writeStepSummarizationCompleted on error (finally block)", async () => {
      mockIsStepSummaryMessage.mockReturnValue(false);
      mockCountCompletedToolSteps.mockReturnValue(3);
      mockGetSecondToLastToolCallId.mockReturnValue("call_2");
      mockExtractStepsToSummarize.mockReturnValue([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1" }],
        },
      ]);
      mockGenerateStepSummaryText.mockRejectedValue(
        new Error("LLM generation failed"),
      );

      const mockWriter = { write: jest.fn() };
      const result = await runStepSummarizationCheck({
        ...baseOptions(),
        writer: mockWriter as any,
      });

      expect(mockWriteStepSummarizationStarted).toHaveBeenCalledWith(
        mockWriter,
      );
      expect(mockWriteStepSummarizationCompleted).toHaveBeenCalledWith(
        mockWriter,
      );
      // Should still return gracefully (non-summarized result)
      expect(result.needsSummarization).toBe(false);
    });

    it("does NOT call writeStepSummarizationCompleted when abortSignal is aborted", async () => {
      mockIsStepSummaryMessage.mockReturnValue(false);
      mockCountCompletedToolSteps.mockReturnValue(3);
      mockGetSecondToLastToolCallId.mockReturnValue("call_2");
      mockExtractStepsToSummarize.mockReturnValue([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1" }],
        },
      ]);

      const abortController = new AbortController();
      abortController.abort();

      const abortError = new DOMException("Aborted", "AbortError");
      mockGenerateStepSummaryText.mockRejectedValue(abortError);

      const mockWriter = { write: jest.fn() };

      await expect(
        runStepSummarizationCheck({
          ...baseOptions({
            abortSignal: abortController.signal,
          }),
          writer: mockWriter as any,
        }),
      ).rejects.toThrow();

      expect(mockWriteStepSummarizationStarted).toHaveBeenCalledWith(
        mockWriter,
      );
      expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
    });
  });

  describe("when writer is NOT provided", () => {
    it("does not crash when summarization happens without writer", async () => {
      setupSummarizationWillHappen();

      const result = await runStepSummarizationCheck(baseOptions());

      expect(result.needsSummarization).toBe(true);
      expect(mockWriteStepSummarizationStarted).not.toHaveBeenCalled();
      expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
    });

    it("does not crash when summarization is not needed without writer", async () => {
      const result = await runStepSummarizationCheck(
        baseOptions({ lastStepInputTokens: 1000 }),
      );

      expect(result.needsSummarization).toBe(false);
      expect(mockWriteStepSummarizationStarted).not.toHaveBeenCalled();
      expect(mockWriteStepSummarizationCompleted).not.toHaveBeenCalled();
    });

    it("does not crash when summarization fails without writer", async () => {
      mockIsStepSummaryMessage.mockReturnValue(false);
      mockCountCompletedToolSteps.mockReturnValue(3);
      mockGetSecondToLastToolCallId.mockReturnValue("call_2");
      mockExtractStepsToSummarize.mockReturnValue([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1" }],
        },
      ]);
      mockGenerateStepSummaryText.mockRejectedValue(
        new Error("LLM generation failed"),
      );

      const result = await runStepSummarizationCheck(baseOptions());

      expect(result.needsSummarization).toBe(false);
    });
  });
});
