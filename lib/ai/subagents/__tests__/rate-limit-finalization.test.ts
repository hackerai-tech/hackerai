import {
  finalizeHandledSubagentRateLimit,
  type HandledRateLimitFinalizationDependencies,
  type HandledRateLimitFinishInput,
} from "@/lib/ai/subagents/rate-limit-finalization";

const finishInput: HandledRateLimitFinishInput = {
  subagentId: "subagent-1",
  triggerRunId: "run-1",
  status: "failed",
  summary: "Usage limit reached.",
  failureCode: "rate_limit",
  failureReason: "You have no weighted tokens left",
  costDollars: 0.02,
  stepCount: 3,
};

const telemetry = {
  environment: "development",
  userId: "user-1",
  subagentId: "subagent-1",
  parentTriggerRunId: "parent-run-1",
  triggerRunId: "run-1",
};

const createDependencies = (): HandledRateLimitFinalizationDependencies => ({
  finishSubagent: jest.fn(async () => "updated" as const),
  loadPersistedTerminalOutput: jest.fn(async () => null),
  captureTerminalOutcome: jest.fn(),
  logError: jest.fn(),
  recordFinalizationFailureMetadata: jest.fn(),
});

describe("finalizeHandledSubagentRateLimit", () => {
  it("persists the handled quota failure and returns the terminal result", async () => {
    const dependencies = createDependencies();

    await expect(
      finalizeHandledSubagentRateLimit(finishInput, telemetry, dependencies),
    ).resolves.toEqual({
      output: { subagentId: "subagent-1", status: "failed" },
      updated: true,
    });

    expect(dependencies.finishSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failureCode: "rate_limit",
        failureReason: "You have no weighted tokens left",
      }),
    );
    expect(dependencies.captureTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(dependencies.loadPersistedTerminalOutput).not.toHaveBeenCalled();
    expect(dependencies.logError).not.toHaveBeenCalled();
  });

  it("returns an existing terminal result when another writer won the race", async () => {
    const dependencies = createDependencies();
    jest.mocked(dependencies.finishSubagent).mockResolvedValueOnce("stale");
    jest
      .mocked(dependencies.loadPersistedTerminalOutput)
      .mockResolvedValueOnce({
        subagentId: "subagent-1",
        status: "canceled",
      });

    await expect(
      finalizeHandledSubagentRateLimit(finishInput, telemetry, dependencies),
    ).resolves.toEqual({
      output: { subagentId: "subagent-1", status: "canceled" },
      updated: false,
    });

    expect(dependencies.captureTerminalOutcome).not.toHaveBeenCalled();
    expect(dependencies.logError).not.toHaveBeenCalled();
  });

  it("reports and throws when no durable terminal state can be confirmed", async () => {
    const dependencies = createDependencies();
    const persistenceError = new Error("Convex unavailable");
    jest
      .mocked(dependencies.finishSubagent)
      .mockRejectedValueOnce(persistenceError);

    await expect(
      finalizeHandledSubagentRateLimit(finishInput, telemetry, dependencies),
    ).rejects.toBe(persistenceError);

    expect(dependencies.logError).toHaveBeenCalledWith(
      "[subagent] rate-limit finalization failed",
      expect.objectContaining({
        event: "subagent_rate_limit_finalization_failed",
        subagent_id: "subagent-1",
        finish_outcome: "error",
        error_message: "Convex unavailable",
      }),
    );
    expect(
      dependencies.recordFinalizationFailureMetadata,
    ).toHaveBeenCalledTimes(1);
  });
});
