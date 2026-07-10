import { SummarizationTracker } from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const makeUsageTracker = () => ({
  inputTokens: 0,
  outputTokens: 0,
  summarizationOutputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  providerCost: 0,
});

describe("SummarizationTracker", () => {
  it("tracks and bills every summarization round", () => {
    const tracker = new SummarizationTracker();
    const usageTracker = makeUsageTracker();

    tracker.recordSummarization(
      1,
      {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        cost: 0.001,
      },
      usageTracker as any,
    );
    tracker.recordSummarization(
      3,
      {
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 9,
        cacheWriteTokens: 4,
        cost: 0.002,
      },
      usageTracker as any,
    );

    expect(tracker.hasSummarized).toBe(true);
    expect(tracker.summarizationCount).toBe(2);
    expect(usageTracker).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      summarizationOutputTokens: 30,
      cacheReadTokens: 16,
      cacheWriteTokens: 7,
      providerCost: 0.003,
    });
  });

  it("accounts for rejected summary usage without recording a compaction", () => {
    const tracker = new SummarizationTracker();
    const usageTracker = makeUsageTracker();

    tracker.recordSummarizationUsage(
      { inputTokens: 50, outputTokens: 5, cost: 0.001 },
      usageTracker as any,
    );

    expect(tracker.hasSummarized).toBe(false);
    expect(tracker.summarizationCount).toBe(0);
    expect(usageTracker.inputTokens).toBe(50);
    expect(usageTracker.outputTokens).toBe(5);
    expect(usageTracker.summarizationOutputTokens).toBe(5);
    expect(usageTracker.providerCost).toBe(0.001);
  });

  it("inserts each completed badge at its own step boundary", () => {
    const tracker = new SummarizationTracker();
    const usageTracker = makeUsageTracker();

    tracker.recordSummarization(1, undefined, usageTracker as any);
    tracker.recordSummarization(3, undefined, usageTracker as any);

    const message = {
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "step 0" },
        { type: "step-start" },
        { type: "text", text: "step 1" },
        { type: "step-start" },
        { type: "text", text: "step 2" },
        { type: "step-start" },
        { type: "text", text: "step 3" },
      ],
    };

    const processed = tracker.processMessageForSave(message);

    expect(processed.parts.map((part) => part.type)).toEqual([
      "step-start",
      "text",
      "data-summarization",
      "step-start",
      "text",
      "step-start",
      "text",
      "data-summarization",
      "step-start",
      "text",
    ]);
    expect(
      processed.parts
        .filter((part) => part.type === "data-summarization")
        .map((part) => part.id),
    ).toEqual(["summarization-status-1", "summarization-status-2"]);
    expect(
      processed.parts
        .filter((part) => part.type === "data-summarization")
        .map((part) => part.data),
    ).toEqual([
      {
        status: "completed",
        message: "Context automatically compacted",
      },
      {
        status: "completed",
        message: "Context automatically compacted",
      },
    ]);
  });

  it("preserves record order for multiple summaries at one step", () => {
    const tracker = new SummarizationTracker();
    const usageTracker = makeUsageTracker();

    tracker.recordSummarization(1, undefined, usageTracker as any);
    tracker.recordSummarization(1, undefined, usageTracker as any);

    const processed = tracker.processMessageForSave({
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "step 0" },
        { type: "step-start" },
      ],
    });

    expect(
      processed.parts
        .filter((part) => part.type === "data-summarization")
        .map((part) => part.id),
    ).toEqual(["summarization-status-1", "summarization-status-2"]);
  });

  it("leaves non-assistant messages unchanged", () => {
    const tracker = new SummarizationTracker();
    tracker.recordSummarization(1, undefined, makeUsageTracker() as any);
    const message = {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };

    expect(tracker.processMessageForSave(message)).toBe(message);
  });
});
