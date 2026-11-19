import {
  SummarizationTracker,
  createAgentCompactionReporter,
  type AgentCompactionTallyOutcome,
} from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const makeUsageTracker = () => {
  const tracker = {
    inputTokens: 0,
    summarizationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    summarizationOutputTokens: 0,
    cacheReadTokens: 0,
    summarizationCacheReadTokens: 0,
    cacheWriteTokens: 0,
    summarizationCacheWriteTokens: 0,
    providerCost: 0,
  };
  Object.defineProperty(tracker, "accumulateSummarization", {
    enumerable: false,
    value: (usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number;
    }) => {
      tracker.inputTokens += usage.inputTokens;
      tracker.summarizationInputTokens += usage.inputTokens;
      tracker.outputTokens += usage.outputTokens;
      tracker.summarizationOutputTokens += usage.outputTokens;
      tracker.totalTokens += usage.inputTokens + usage.outputTokens;
      tracker.cacheReadTokens += usage.cacheReadTokens ?? 0;
      tracker.summarizationCacheReadTokens += usage.cacheReadTokens ?? 0;
      tracker.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      tracker.summarizationCacheWriteTokens += usage.cacheWriteTokens ?? 0;
      tracker.providerCost += usage.cost ?? 0;
    },
  });
  return tracker;
};

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
      summarizationInputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      summarizationOutputTokens: 30,
      cacheReadTokens: 16,
      summarizationCacheReadTokens: 16,
      cacheWriteTokens: 7,
      summarizationCacheWriteTokens: 7,
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
    expect(usageTracker.summarizationInputTokens).toBe(50);
    expect(usageTracker.outputTokens).toBe(5);
    expect(usageTracker.totalTokens).toBe(55);
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

  it("reports the running count only for accepted compactions", () => {
    const observed: number[] = [];
    const tracker = new SummarizationTracker((count) => observed.push(count));
    const usageTracker = makeUsageTracker();

    tracker.recordSummarizationUsage(
      { inputTokens: 50, outputTokens: 5 },
      usageTracker as any,
    );
    tracker.recordSummarization(1, undefined, usageTracker as any);
    tracker.recordSummarization(2, undefined, usageTracker as any);

    expect(observed).toEqual([1, 2]);
  });

  it("keeps recording and billing when the observer fails", () => {
    const tracker = new SummarizationTracker(() => {
      throw new Error("reporting unavailable");
    });
    const usageTracker = makeUsageTracker();

    tracker.recordSummarization(
      1,
      { inputTokens: 100, outputTokens: 10 },
      usageTracker as any,
    );

    expect(tracker.summarizationCount).toBe(1);
    expect(usageTracker.summarizationInputTokens).toBe(100);
  });
});

describe("createAgentCompactionReporter", () => {
  const setup = (
    outcomes: Array<AgentCompactionTallyOutcome | Error> = [],
    signal = new AbortController().signal,
  ) => {
    const sent: number[] = [];
    const work: Promise<void>[] = [];
    const onError = jest.fn();
    const reporter = createAgentCompactionReporter({
      send: async (count) => {
        sent.push(count);
        const outcome = outcomes.shift() ?? "recorded";
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      registerBackgroundWork: (promise) => work.push(promise),
      signal,
      onError,
    });
    const settled = () => Promise.all(work);
    return { reporter, sent, work, onError, settled };
  };

  it("sends absolute snapshots in order and coalesces queued reports", async () => {
    const { reporter, sent, work, settled } = setup();

    reporter.report(0);
    await settled();
    reporter.report(1);
    reporter.report(2);
    await settled();

    // Reports queued together send only the latest absolute count.
    expect(sent).toEqual([0, 2]);
    expect(work).toHaveLength(3);
  });

  it("does not report a compaction completed after the run stopped", async () => {
    const run = new AbortController();
    const { reporter, sent, work, settled } = setup([], run.signal);

    reporter.report(0);
    await settled();
    run.abort();
    reporter.report(1);
    reporter.flush();
    await settled();

    expect(sent).toEqual([0]);
    expect(work).toHaveLength(1);
  });

  it("retries the latest unconfirmed snapshot once before the run drains", async () => {
    const { reporter, sent, onError, settled } = setup([
      "stale",
      new Error("transport failed"),
    ]);

    reporter.report(0); // races the run's chat association
    await settled();
    reporter.report(1); // transport failure
    await settled();
    expect(onError).toHaveBeenCalledTimes(1);

    reporter.flush();
    await settled();
    reporter.flush(); // already confirmed
    await settled();

    expect(sent).toEqual([0, 1, 1]);
  });

  it("stops reporting once the chat is gone", async () => {
    const { reporter, sent, settled } = setup(["deleting"]);

    reporter.report(0);
    await settled();
    reporter.report(1);
    reporter.flush();
    await settled();

    expect(sent).toEqual([0]);
  });
});
