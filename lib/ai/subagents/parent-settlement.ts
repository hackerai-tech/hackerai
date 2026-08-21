import {
  SUBAGENT_ACTIVE_STATUSES,
  SUBAGENT_TERMINAL_STATUSES,
  type SubagentStatus,
} from "@/lib/ai/subagents/contracts";

type ActiveSubagentRun = {
  trigger_run_id?: string;
};

type ParentSubagentSettlementRow = {
  status: SubagentStatus;
  parent_result_consumed_at?: number;
  /** Compatibility with rows created before acknowledged delivery. */
  parent_notified_at?: number;
};

export const summarizeParentSubagentSettlement = (
  rows: ParentSubagentSettlementRow[],
) => {
  const activeCount = rows.filter((row) =>
    SUBAGENT_ACTIVE_STATUSES.has(row.status),
  ).length;
  const terminalRows = rows.filter((row) =>
    SUBAGENT_TERMINAL_STATUSES.has(row.status),
  );
  return {
    totalCount: rows.length,
    activeCount,
    terminalCount: terminalRows.length,
    undeliveredCount: terminalRows.filter(
      (row) => !row.parent_result_consumed_at && !row.parent_notified_at,
    ).length,
  };
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
  const warn = (message: string, details: Record<string, unknown>) => {
    try {
      dependencies.warn(message, details);
    } catch {
      // Parent teardown must not fail because diagnostics could not be emitted.
    }
  };
  const settle = async () => {
    let activeChildren: ActiveSubagentRun[] = [];
    try {
      activeChildren =
        await dependencies.listActiveSubagents(parentTriggerRunId);
    } catch {
      warn("[agent-long] child settlement lookup failed", {
        parentTriggerRunId,
        reason,
      });
    }

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        dependencies.cancelPersistedSubagents(parentTriggerRunId, reason),
      ),
      ...activeChildren.flatMap((child) => {
        const triggerRunId = child.trigger_run_id;
        return triggerRunId
          ? [
              Promise.resolve().then(() =>
                dependencies.cancelTriggerRun(triggerRunId),
              ),
            ]
          : [];
      }),
    ]);
    const persistenceFailed = results[0]?.status === "rejected";
    const failedTriggerCancellations = results
      .slice(1)
      .filter((result) => result.status === "rejected").length;

    if (persistenceFailed || failedTriggerCancellations > 0) {
      warn("[agent-long] child settlement partially failed", {
        parentTriggerRunId,
        reason,
        persistenceFailed,
        failedTriggerCancellations,
      });
    }
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settlement = settle().catch(() => {
    warn("[agent-long] child settlement failed", {
      parentTriggerRunId,
      reason,
    });
  });
  const completed = await Promise.race([
    settlement.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (!completed) {
    warn("[agent-long] child settlement timed out", {
      parentTriggerRunId,
      reason,
    });
  }
};
