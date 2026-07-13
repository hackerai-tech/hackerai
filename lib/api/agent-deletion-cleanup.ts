import {
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";

const AGENT_RESOURCE_CLEANUP_CONCURRENCY = 4;

export type ActiveAgentResource = {
  chatId: string;
  triggerRunId?: string;
  approvalSessionId?: string;
};

export async function closeAndCancelAgentResources(
  resources: ActiveAgentResource[],
  reason: string,
): Promise<{ canceledTriggerRuns: number; closedApprovalSessions: number }> {
  const triggerRunIds = [
    ...new Set(
      resources.flatMap(({ triggerRunId }) =>
        triggerRunId ? [triggerRunId] : [],
      ),
    ),
  ];
  const approvalSessionIds = [
    ...new Set(
      resources.flatMap(({ approvalSessionId }) =>
        approvalSessionId ? [approvalSessionId] : [],
      ),
    ),
  ];
  const operations = [
    ...approvalSessionIds.map(
      (approvalSessionId) => () =>
        closeAgentApprovalSession(approvalSessionId, reason),
    ),
    ...triggerRunIds.map(
      (triggerRunId) => () => cancelAgentTriggerRun(triggerRunId),
    ),
  ];

  for (
    let index = 0;
    index < operations.length;
    index += AGENT_RESOURCE_CLEANUP_CONCURRENCY
  ) {
    await Promise.all(
      operations
        .slice(index, index + AGENT_RESOURCE_CLEANUP_CONCURRENCY)
        .map((operation) => operation()),
    );
  }

  return {
    canceledTriggerRuns: triggerRunIds.length,
    closedApprovalSessions: approvalSessionIds.length,
  };
}
