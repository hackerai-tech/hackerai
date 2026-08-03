import { describe, expect, it } from "@jest/globals";

import {
  buildMissingSubagentResultRecoveryMessage,
  canRecoverMissingSubagentResult,
  getSubagentProviderRetryDecision,
} from "../runtime-recovery";

describe("subagent runtime recovery", () => {
  const healthyRuntime = {
    aborted: false,
    spendCapExceeded: false,
    hasStepsRemaining: true,
  };

  it("retries transient provider failures with bounded backoff", () => {
    const error = Object.assign(new Error("upstream unavailable"), {
      statusCode: 503,
    });

    expect(getSubagentProviderRetryDecision(error, 0, healthyRuntime)).toEqual({
      category: "provider_5xx",
      shouldRetry: true,
      delayMs: 750,
    });
    expect(
      getSubagentProviderRetryDecision(error, 2, healthyRuntime).shouldRetry,
    ).toBe(false);
  });

  it("does not retry permanent, canceled, spent, or step-exhausted failures", () => {
    const badRequest = Object.assign(new Error("bad request"), {
      statusCode: 400,
    });
    expect(
      getSubagentProviderRetryDecision(badRequest, 0, healthyRuntime),
    ).toMatchObject({ category: "provider_4xx", shouldRetry: false });
    expect(
      getSubagentProviderRetryDecision(new Error("connection reset"), 0, {
        ...healthyRuntime,
        aborted: true,
      }).shouldRetry,
    ).toBe(false);
    expect(
      getSubagentProviderRetryDecision(new Error("connection reset"), 0, {
        ...healthyRuntime,
        spendCapExceeded: true,
      }).shouldRetry,
    ).toBe(false);
    expect(
      getSubagentProviderRetryDecision(new Error("connection reset"), 0, {
        ...healthyRuntime,
        hasStepsRemaining: false,
      }).shouldRetry,
    ).toBe(false);
  });

  it("allows one bounded missing-result recovery with a tool-specific nudge", () => {
    expect(canRecoverMissingSubagentResult(0, healthyRuntime)).toBe(true);
    expect(canRecoverMissingSubagentResult(1, healthyRuntime)).toBe(false);
    expect(buildMissingSubagentResultRecoveryMessage()).toContain(
      "submit_validation_result exactly once",
    );
    expect(buildMissingSubagentResultRecoveryMessage()).toContain(
      "Do not repeat completed checks",
    );
  });
});
