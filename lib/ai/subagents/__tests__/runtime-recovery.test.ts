import { describe, expect, it } from "@jest/globals";

import {
  buildMissingSubagentResultRecoveryMessage,
  canRecoverMissingSubagentResult,
  canStartSubagentResultRecoveryGeneration,
  getSubagentExplorationStepLimit,
  getSubagentProviderRetryDecision,
  getSubagentRecoveryErrorDiagnostics,
  getSubagentResultRecoveryRetryDecision,
  isRecoverableProviderCategory,
  isTransientProviderCategory,
  pipeSubagentUiMessageStream,
  shouldStartSubagentResultRecovery,
  SUBAGENT_RESULT_RECOVERY_STEP_RESERVE,
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

    const decision = getSubagentProviderRetryDecision(error, 0, healthyRuntime);
    expect(decision).toMatchObject({
      category: "provider_5xx",
      shouldRetry: true,
    });
    expect(decision.delayMs).toBeGreaterThanOrEqual(750);
    expect(decision.delayMs).toBeLessThanOrEqual(938);
    expect(isTransientProviderCategory(decision.category)).toBe(true);
    expect(isTransientProviderCategory("provider_4xx")).toBe(false);
    expect(
      getSubagentProviderRetryDecision(error, 2, healthyRuntime).shouldRetry,
    ).toBe(false);
  });

  it("retries content-filter failures within the same bounded retry budget", () => {
    const contentBlocked = Object.assign(
      new Error(
        "PROHIBITED_CONTENT: provider returned content-filter finish reason",
      ),
      {
        name: "ProviderContentBlockedFinishReasonError",
        statusCode: 403,
        finishReason: "content-filter",
      },
    );

    expect(
      getSubagentProviderRetryDecision(contentBlocked, 0, healthyRuntime),
    ).toMatchObject({ category: "content_blocked", shouldRetry: true });
    expect(isRecoverableProviderCategory("content_blocked")).toBe(true);
    expect(isTransientProviderCategory("content_blocked")).toBe(false);
    expect(
      getSubagentProviderRetryDecision(contentBlocked, 2, healthyRuntime)
        .shouldRetry,
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
    expect(buildMissingSubagentResultRecoveryMessage()).toContain(
      "confirmed result must include at least one reproduction step and one evidence reference",
    );
  });

  it("reserves the final steps for structured-result recovery", () => {
    expect(SUBAGENT_RESULT_RECOVERY_STEP_RESERVE).toBe(2);
    expect(getSubagentExplorationStepLimit(50)).toBe(48);
    expect(getSubagentExplorationStepLimit(2)).toBe(1);
    expect(
      shouldStartSubagentResultRecovery(0, {
        aborted: false,
        spendCapExceeded: false,
        remainingSteps: 2,
      }),
    ).toBe(true);
    expect(
      shouldStartSubagentResultRecovery(1, {
        aborted: false,
        spendCapExceeded: false,
        remainingSteps: 2,
      }),
    ).toBe(false);
  });

  it("retries a failed structured-result recovery exactly once", () => {
    const outputFailure = Object.assign(
      new Error("No object generated: response did not match schema"),
      {
        name: "AI_NoOutputGeneratedError",
        code: "AI_NoOutputGeneratedError",
      },
    );

    expect(
      getSubagentResultRecoveryRetryDecision(outputFailure, 0, healthyRuntime),
    ).toMatchObject({
      category: "unknown",
      errorName: "AI_NoOutputGeneratedError",
      errorCode: "AI_NoOutputGeneratedError",
      shouldRetry: true,
      delayMs: 750,
    });
    expect(
      getSubagentResultRecoveryRetryDecision(outputFailure, 1, healthyRuntime)
        .shouldRetry,
    ).toBe(false);
  });

  it("bounds every structured-result generation, including deferred submissions", () => {
    expect(canStartSubagentResultRecoveryGeneration(0)).toBe(true);
    expect(canStartSubagentResultRecoveryGeneration(1)).toBe(true);
    expect(canStartSubagentResultRecoveryGeneration(2)).toBe(false);
  });

  it("does not retry structured-result recovery after cancellation, spend, or step exhaustion", () => {
    const outputFailure = new Error("No object generated");
    for (const runtime of [
      { ...healthyRuntime, aborted: true },
      { ...healthyRuntime, spendCapExceeded: true },
      { ...healthyRuntime, hasStepsRemaining: false },
    ]) {
      expect(
        getSubagentResultRecoveryRetryDecision(outputFailure, 0, runtime)
          .shouldRetry,
      ).toBe(false);
    }
  });

  it("keeps recovery diagnostics bounded and excludes error messages", () => {
    const outputFailure = Object.assign(new Error("private prompt content"), {
      name: "secret_user_identifier",
      code: "unsafe code with spaces",
      statusCode: 503,
    });

    expect(getSubagentRecoveryErrorDiagnostics(outputFailure)).toEqual({
      category: "provider_5xx",
      statusCode: 503,
    });
  });

  it("cancels an unfinished source when writing a streamed chunk fails", async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("first");
      },
      cancel,
    });
    const writeFailure = new Error("writer disconnected");

    await expect(
      pipeSubagentUiMessageStream(stream, () => {
        throw writeFailure;
      }),
    ).rejects.toBe(writeFailure);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a normally completed streamed source", async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("first");
        controller.close();
      },
      cancel,
    });
    const chunks: string[] = [];

    await pipeSubagentUiMessageStream(stream, (chunk) => chunks.push(chunk));

    expect(chunks).toEqual(["first"]);
    expect(cancel).not.toHaveBeenCalled();
  });
});
