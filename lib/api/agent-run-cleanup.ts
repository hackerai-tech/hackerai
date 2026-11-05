import { setActiveTriggerRun } from "@/lib/db/actions";

export const clearFinishedAgentRun = async ({
  chatId,
  triggerRunId,
  approvalSessionId,
  approvalSessionClosed,
}: {
  chatId: string;
  triggerRunId: string;
  approvalSessionId?: string;
  approvalSessionClosed: boolean;
}) => {
  // Keep the persisted cleanup handle until closure succeeds. Cancel/status
  // retries can then recover even after the worker has exited.
  if (approvalSessionId && !approvalSessionClosed) return "pending" as const;

  return await setActiveTriggerRun({
    chatId,
    triggerRunId: null,
    approvalSessionId: null,
    expectedRunId: triggerRunId,
    ...(approvalSessionId
      ? { expectedApprovalSessionId: approvalSessionId }
      : {}),
    clearApprovalPending: true,
  });
};
