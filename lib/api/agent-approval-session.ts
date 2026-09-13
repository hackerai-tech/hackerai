import { ApiError, runs, sessions } from "@trigger.dev/sdk";
import { AGENT_TOOL_APPROVAL_PROTOCOL_VERSION } from "@/types";

const DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION = "15m";
const IDEMPOTENT_TRIGGER_CLEANUP_STATUSES = new Set([400, 404, 409, 410, 422]);

export const AGENT_APPROVAL_PROTOCOL_VERSION =
  AGENT_TOOL_APPROVAL_PROTOCOL_VERSION;

const normalizeTokenExpiration = (value: string | undefined): string => {
  if (!value) return DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION;
  return /^\d+[smhd]$/.test(value)
    ? value
    : DEFAULT_AGENT_APPROVAL_TOKEN_EXPIRATION;
};

export const AGENT_APPROVAL_TOKEN_EXPIRATION = normalizeTokenExpiration(
  process.env.AGENT_APPROVAL_TOKEN_EXPIRATION,
);

const isIdempotentTriggerCleanupError = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status !== undefined &&
  IDEMPOTENT_TRIGGER_CLEANUP_STATUSES.has(error.status);

export const cancelAgentTriggerRun = async (
  triggerRunId: string | undefined,
): Promise<boolean> => {
  if (!triggerRunId) return false;
  try {
    await runs.cancel(triggerRunId);
  } catch (error) {
    if (!isIdempotentTriggerCleanupError(error)) throw error;
  }
  return true;
};

export const closeAgentApprovalSession = async (
  approvalSessionId: string | undefined,
  reason: string,
): Promise<boolean> => {
  if (!approvalSessionId) return false;
  try {
    await sessions.close(approvalSessionId, { reason });
  } catch (error) {
    if (!isIdempotentTriggerCleanupError(error)) throw error;
  }
  return true;
};
