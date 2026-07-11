import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  tokenExhaustedAfterSummarization,
  elapsedTimeExceeds,
  getAgentAutoContinueStopSource,
} from "../stop-conditions";

function makeState(overrides: {
  threshold: number;
  lastStepInputTokens: number;
  hasSummarized: boolean;
  canSummarizeAgain?: boolean;
}) {
  const onFired = jest.fn();
  return {
    state: {
      threshold: overrides.threshold,
      getLastStepInputTokens: () => overrides.lastStepInputTokens,
      getHasSummarized: () => overrides.hasSummarized,
      ...(overrides.canSummarizeAgain !== undefined
        ? { getCanSummarizeAgain: () => overrides.canSummarizeAgain! }
        : {}),
      onFired,
    },
    onFired,
  };
}

describe("tokenExhaustedAfterSummarization", () => {
  describe("returns false when conditions are not met", () => {
    it.each([
      {
        scenario: "hasSummarized=false, tokens well above threshold",
        threshold: 14400,
        tokens: 20000,
        hasSummarized: false,
      },
      {
        scenario: "hasSummarized=false, tokens below threshold",
        threshold: 14400,
        tokens: 100,
        hasSummarized: false,
      },
      {
        scenario: "hasSummarized=true, tokens below threshold",
        threshold: 14400,
        tokens: 10000,
        hasSummarized: true,
      },
      {
        scenario: "hasSummarized=true, tokens exactly at threshold (> not >=)",
        threshold: 14400,
        tokens: 14400,
        hasSummarized: true,
      },
      {
        scenario: "hasSummarized=false, tokens exactly at threshold",
        threshold: 115200,
        tokens: 115200,
        hasSummarized: false,
      },
    ])("$scenario", ({ threshold, tokens, hasSummarized }) => {
      const { state, onFired } = makeState({
        threshold,
        lastStepInputTokens: tokens,
        hasSummarized,
      });
      const condition = tokenExhaustedAfterSummarization(state);
      expect(condition()).toBe(false);
      expect(onFired).not.toHaveBeenCalled();
    });
  });

  describe("returns true and fires callback when threshold exceeded after summarization", () => {
    it.each([
      {
        scenario: "tokens 1 above threshold",
        threshold: 14400,
        tokens: 14401,
      },
      {
        scenario: "tokens well above threshold",
        threshold: 14400,
        tokens: 20000,
      },
      {
        scenario: "free-tier: threshold=floor(16000*0.9)=14400, tokens=14401",
        threshold: Math.floor(16000 * 0.9),
        tokens: 14401,
      },
      {
        scenario:
          "paid-tier: threshold=floor(128000*0.9)=115200, tokens=115201",
        threshold: Math.floor(128000 * 0.9),
        tokens: 115201,
      },
    ])("$scenario", ({ threshold, tokens }) => {
      const { state, onFired } = makeState({
        threshold,
        lastStepInputTokens: tokens,
        hasSummarized: true,
      });
      const condition = tokenExhaustedAfterSummarization(state);
      expect(condition()).toBe(true);
      expect(onFired).toHaveBeenCalledTimes(1);
    });
  });

  it("returns false when another in-run compaction is available", () => {
    const { state, onFired } = makeState({
      threshold: 14400,
      lastStepInputTokens: 20000,
      hasSummarized: true,
      canSummarizeAgain: true,
    });

    const condition = tokenExhaustedAfterSummarization(state);

    expect(condition()).toBe(false);
    expect(onFired).not.toHaveBeenCalled();
  });

  it("returns true when the repeated-compaction budget is exhausted", () => {
    const { state, onFired } = makeState({
      threshold: 14400,
      lastStepInputTokens: 20000,
      hasSummarized: true,
      canSummarizeAgain: false,
    });

    const condition = tokenExhaustedAfterSummarization(state);

    expect(condition()).toBe(true);
    expect(onFired).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates repeated-compaction availability on every invocation", () => {
    let canSummarizeAgain = true;
    const onFired = jest.fn();
    const condition = tokenExhaustedAfterSummarization({
      threshold: 14400,
      getLastStepInputTokens: () => 20000,
      getHasSummarized: () => true,
      getCanSummarizeAgain: () => canSummarizeAgain,
      onFired,
    });

    expect(condition()).toBe(false);
    canSummarizeAgain = false;
    expect(condition()).toBe(true);
    expect(onFired).toHaveBeenCalledTimes(1);
  });

  it("does not call onFired on repeated invocations that return false", () => {
    const { state, onFired } = makeState({
      threshold: 14400,
      lastStepInputTokens: 10000,
      hasSummarized: true,
    });
    const condition = tokenExhaustedAfterSummarization(state);
    condition();
    condition();
    condition();
    expect(onFired).not.toHaveBeenCalled();
  });

  it("calls onFired on every invocation that returns true", () => {
    const { state, onFired } = makeState({
      threshold: 14400,
      lastStepInputTokens: 20000,
      hasSummarized: true,
    });
    const condition = tokenExhaustedAfterSummarization(state);
    condition();
    condition();
    expect(onFired).toHaveBeenCalledTimes(2);
  });
});

describe("getAgentAutoContinueStopSource", () => {
  const baseState = {
    finishReason: "stop",
    stoppedDueToTokenExhaustion: false,
    stoppedDueToElapsedTimeout: false,
    stoppedDueToPostSummarizationIncomplete: false,
  };

  it.each([
    {
      scenario: "post-summarization token exhaustion",
      overrides: { stoppedDueToTokenExhaustion: true },
      expected: "post_summarization_token_exhaustion",
    },
    {
      scenario: "elapsed timeout when enabled by the caller",
      overrides: { stoppedDueToElapsedTimeout: true },
      expected: "elapsed_timeout",
    },
    {
      scenario: "incomplete post-summarization continuation",
      overrides: { stoppedDueToPostSummarizationIncomplete: true },
      expected: "post_summarization_incomplete",
    },
    {
      scenario: "provider-direct context-limit finish reason",
      overrides: { finishReason: "context-limit" },
      expected: "context_limit_finish_reason",
    },
    {
      scenario: "provider output-limit finish reason",
      overrides: { finishReason: "length" },
      expected: "output_limit_finish_reason",
    },
    {
      scenario: "tool-call step limit",
      overrides: { finishReason: "tool-calls" },
      expected: "tool_calls_finish_reason",
    },
  ])("returns the stop source for $scenario", ({ overrides, expected }) => {
    expect(getAgentAutoContinueStopSource({ ...baseState, ...overrides })).toBe(
      expected,
    );
  });

  it("does not auto-continue unrelated finish reasons", () => {
    expect(getAgentAutoContinueStopSource(baseState)).toBeNull();
  });
});

describe("elapsedTimeExceeds", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("returns false when elapsed time is below threshold", () => {
    it.each([
      {
        scenario: "0ms elapsed, 5000ms threshold",
        startOffset: 0,
        maxDurationMs: 5000,
      },
      {
        scenario: "1000ms elapsed, 5000ms threshold",
        startOffset: 1000,
        maxDurationMs: 5000,
      },
      {
        scenario: "4999ms elapsed, 5000ms threshold",
        startOffset: 4999,
        maxDurationMs: 5000,
      },
    ])("$scenario", ({ startOffset, maxDurationMs }) => {
      const now = Date.now();
      const onFired = jest.fn();
      const condition = elapsedTimeExceeds({
        maxDurationMs,
        getStartTime: () => now - startOffset,
        onFired,
      });
      expect(condition()).toBe(false);
    });
  });

  it("returns true when elapsed time equals threshold", () => {
    const now = Date.now();
    const onFired = jest.fn();
    const condition = elapsedTimeExceeds({
      maxDurationMs: 5000,
      getStartTime: () => now - 5000,
      onFired,
    });
    expect(condition()).toBe(true);
  });

  describe("returns true when elapsed time exceeds threshold", () => {
    it.each([
      {
        scenario: "5001ms elapsed, 5000ms threshold",
        startOffset: 5001,
        maxDurationMs: 5000,
      },
      {
        scenario: "10000ms elapsed, 5000ms threshold",
        startOffset: 10000,
        maxDurationMs: 5000,
      },
      {
        scenario: "60001ms elapsed, 60000ms threshold",
        startOffset: 60001,
        maxDurationMs: 60000,
      },
    ])("$scenario", ({ startOffset, maxDurationMs }) => {
      const now = Date.now();
      const onFired = jest.fn();
      const condition = elapsedTimeExceeds({
        maxDurationMs,
        getStartTime: () => now - startOffset,
        onFired,
      });
      expect(condition()).toBe(true);
    });
  });

  it("calls onFired when it fires", () => {
    const now = Date.now();
    const onFired = jest.fn();
    const condition = elapsedTimeExceeds({
      maxDurationMs: 5000,
      getStartTime: () => now - 6000,
      onFired,
    });
    condition();
    expect(onFired).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onFired when below threshold", () => {
    const now = Date.now();
    const onFired = jest.fn();
    const condition = elapsedTimeExceeds({
      maxDurationMs: 5000,
      getStartTime: () => now - 1000,
      onFired,
    });
    condition();
    condition();
    condition();
    expect(onFired).not.toHaveBeenCalled();
  });

  it("uses dynamic getStartTime() value (not cached)", () => {
    const onFired = jest.fn();
    let startTime = Date.now();
    const condition = elapsedTimeExceeds({
      maxDurationMs: 5000,
      getStartTime: () => startTime,
      onFired,
    });

    expect(condition()).toBe(false);

    startTime = Date.now() - 6000;
    expect(condition()).toBe(true);
    expect(onFired).toHaveBeenCalledTimes(1);
  });
});
