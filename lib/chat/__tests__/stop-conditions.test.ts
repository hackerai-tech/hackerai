import { describe, it, expect, jest } from "@jest/globals";
import { tokenExhaustedAfterSummarization } from "../stop-conditions";

function makeState(overrides: {
  threshold: number;
  lastStepInputTokens: number;
  hasSummarized: boolean;
}) {
  const onFired = jest.fn();
  return {
    state: {
      threshold: overrides.threshold,
      getLastStepInputTokens: () => overrides.lastStepInputTokens,
      getHasSummarized: () => overrides.hasSummarized,
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
