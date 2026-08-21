import {
  settleParentSubagents,
  summarizeParentSubagentSettlement,
} from "@/lib/ai/subagents/parent-settlement";

describe("summarizeParentSubagentSettlement", () => {
  it("separates active, terminal, and undelivered child results", () => {
    expect(
      summarizeParentSubagentSettlement([
        { status: "running" },
        { status: "completed", parent_result_consumed_at: 123 },
        { status: "completed", parent_notified_at: 456 },
        { status: "failed" },
        { status: "canceled" },
      ]),
    ).toEqual({
      totalCount: 5,
      activeCount: 1,
      terminalCount: 4,
      undeliveredCount: 2,
    });
  });
});

const createDependencies = () => ({
  listActiveSubagents: jest.fn(
    async (): Promise<Array<{ trigger_run_id?: string }>> => [],
  ),
  cancelPersistedSubagents: jest.fn(async () => 0),
  cancelTriggerRun: jest.fn(async () => undefined),
  warn: jest.fn(),
});

describe("settleParentSubagents", () => {
  it("durably settles active children and cancels their Trigger runs", async () => {
    const dependencies = createDependencies();
    dependencies.listActiveSubagents.mockResolvedValue([
      { trigger_run_id: "child-run-1" },
      {},
      { trigger_run_id: "child-run-2" },
    ]);

    await settleParentSubagents(
      {
        parentTriggerRunId: "parent-run",
        reason: "parent_run_ended",
      },
      dependencies,
    );

    expect(dependencies.cancelPersistedSubagents).toHaveBeenCalledWith(
      "parent-run",
      "parent_run_ended",
    );
    expect(dependencies.cancelTriggerRun).toHaveBeenCalledTimes(2);
    expect(dependencies.cancelTriggerRun).toHaveBeenNthCalledWith(
      1,
      "child-run-1",
    );
    expect(dependencies.cancelTriggerRun).toHaveBeenNthCalledWith(
      2,
      "child-run-2",
    );
    expect(dependencies.warn).not.toHaveBeenCalled();
  });

  it("leaves terminal children untouched while keeping persistence idempotent", async () => {
    const dependencies = createDependencies();

    await settleParentSubagents(
      {
        parentTriggerRunId: "parent-run",
        reason: "parent_run_ended",
      },
      dependencies,
    );
    await settleParentSubagents(
      {
        parentTriggerRunId: "parent-run",
        reason: "parent_run_ended",
      },
      dependencies,
    );

    expect(dependencies.cancelPersistedSubagents).toHaveBeenCalledTimes(2);
    expect(dependencies.cancelTriggerRun).not.toHaveBeenCalled();
    expect(dependencies.warn).not.toHaveBeenCalled();
  });

  it("still settles persisted state when the active-child lookup fails", async () => {
    const dependencies = createDependencies();
    dependencies.listActiveSubagents.mockRejectedValue(new Error("offline"));

    await settleParentSubagents(
      {
        parentTriggerRunId: "parent-run",
        reason: "parent_run_failed",
      },
      dependencies,
    );

    expect(dependencies.cancelPersistedSubagents).toHaveBeenCalledWith(
      "parent-run",
      "parent_run_failed",
    );
    expect(dependencies.cancelTriggerRun).not.toHaveBeenCalled();
    expect(dependencies.warn).toHaveBeenCalledWith(
      "[agent-long] child settlement lookup failed",
      expect.objectContaining({
        parentTriggerRunId: "parent-run",
        reason: "parent_run_failed",
      }),
    );
  });

  it("reports partial cancellation failures without rejecting cleanup", async () => {
    const dependencies = createDependencies();
    dependencies.listActiveSubagents.mockResolvedValue([
      { trigger_run_id: "child-run" },
    ]);
    dependencies.cancelPersistedSubagents.mockRejectedValue(
      new Error("convex unavailable"),
    );
    dependencies.cancelTriggerRun.mockRejectedValue(
      new Error("trigger unavailable"),
    );

    await expect(
      settleParentSubagents(
        {
          parentTriggerRunId: "parent-run",
          reason: "parent_run_ended",
        },
        dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(dependencies.warn).toHaveBeenCalledWith(
      "[agent-long] child settlement partially failed",
      expect.objectContaining({
        persistenceFailed: true,
        failedTriggerCancellations: 1,
      }),
    );
  });

  it("contains synchronous dependency failures during parent teardown", async () => {
    const dependencies = createDependencies();
    dependencies.listActiveSubagents.mockResolvedValue([
      { trigger_run_id: "child-run" },
    ]);
    dependencies.cancelPersistedSubagents.mockImplementation(() => {
      throw new Error("synchronous convex failure");
    });
    dependencies.cancelTriggerRun.mockImplementation(() => {
      throw new Error("synchronous trigger failure");
    });

    await expect(
      settleParentSubagents(
        {
          parentTriggerRunId: "parent-run",
          reason: "parent_run_ended",
        },
        dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(dependencies.warn).toHaveBeenCalledWith(
      "[agent-long] child settlement partially failed",
      expect.objectContaining({
        persistenceFailed: true,
        failedTriggerCancellations: 1,
      }),
    );
  });

  it("bounds cleanup and reports a timeout", async () => {
    const dependencies = createDependencies();
    dependencies.cancelPersistedSubagents.mockImplementation(
      async () => await new Promise(() => undefined),
    );

    await settleParentSubagents(
      {
        parentTriggerRunId: "parent-run",
        reason: "parent_run_ended",
        timeoutMs: 1,
      },
      dependencies,
    );

    expect(dependencies.warn).toHaveBeenCalledWith(
      "[agent-long] child settlement timed out",
      expect.objectContaining({
        parentTriggerRunId: "parent-run",
        reason: "parent_run_ended",
      }),
    );
  });
});
