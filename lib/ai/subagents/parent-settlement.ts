type ActiveSubagentRun = {
  trigger_run_id?: string;
};

type ParentSubagentSettlementDependencies = {
  listActiveSubagents: (
    parentTriggerRunId: string,
  ) => Promise<ActiveSubagentRun[]>;
  cancelPersistedSubagents: (
    parentTriggerRunId: string,
    reason: string,
  ) => Promise<unknown>;
  cancelTriggerRun: (triggerRunId: string) => Promise<unknown>;
  warn: (message: string, details: Record<string, unknown>) => void;
};

type SettleParentSubagentsInput = {
  parentTriggerRunId: string;
  reason: string;
  timeoutMs?: number;
};

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 2_000;

export const settleParentSubagents = async (
  {
    parentTriggerRunId,
    reason,
    timeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
  }: SettleParentSubagentsInput,
  dependencies: ParentSubagentSettlementDependencies,
): Promise<void> => {
  const settle = async () => {
    let activeChildren: ActiveSubagentRun[] = [];
    try {
      activeChildren =
        await dependencies.listActiveSubagents(parentTriggerRunId);
    } catch {
      dependencies.warn("[agent-long] child settlement lookup failed", {
        parentTriggerRunId,
        reason,
      });
    }

    const results = await Promise.allSettled([
      dependencies.cancelPersistedSubagents(parentTriggerRunId, reason),
      ...activeChildren.flatMap((child) =>
        child.trigger_run_id
          ? [dependencies.cancelTriggerRun(child.trigger_run_id)]
          : [],
      ),
    ]);
    const persistenceFailed = results[0]?.status === "rejected";
    const failedTriggerCancellations = results
      .slice(1)
      .filter((result) => result.status === "rejected").length;

    if (persistenceFailed || failedTriggerCancellations > 0) {
      dependencies.warn("[agent-long] child settlement partially failed", {
        parentTriggerRunId,
        reason,
        persistenceFailed,
        failedTriggerCancellations,
      });
    }
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    settle().then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (!completed) {
    dependencies.warn("[agent-long] child settlement timed out", {
      parentTriggerRunId,
      reason,
    });
  }
};
