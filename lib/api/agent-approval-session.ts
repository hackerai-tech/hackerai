import { sessions } from "@trigger.dev/sdk";

export const AGENT_APPROVAL_TOKEN_EXPIRATION = "15m";

export const closeAgentApprovalSession = async (
  approvalSessionId: string | undefined,
  reason: string,
): Promise<void> => {
  if (!approvalSessionId) return;
  try {
    await sessions.close(approvalSessionId, { reason });
  } catch {
    // The session may already be closed or unavailable during cleanup.
  }
};
