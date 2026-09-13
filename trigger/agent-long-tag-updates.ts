import { logger as triggerLogger, tags } from "@trigger.dev/sdk";

type AgentLongTagValue = string | string[];

export type AgentLongTagUpdateStage =
  | "task_start_missing"
  | "terminal_error"
  | "handled_rate_limit"
  | "handled_tool_failure"
  | "realtime_transport_error";

type AgentLongTagUpdateContext = {
  runId: string;
  chatId: string;
  userId: string;
  stage: AgentLongTagUpdateStage;
};

const getErrorField = (error: unknown, field: string): unknown => {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[field];
};

const isTriggerApiRateLimitError = (error: unknown): boolean =>
  getErrorField(error, "name") === "TriggerApiError" &&
  getErrorField(error, "status") === 429;

export const getMissingAgentLongTags = (
  existingTags: readonly string[],
  desiredTags: readonly string[],
): string[] => {
  const existing = new Set(existingTags);
  return desiredTags.filter((tag) => !existing.has(tag));
};

/**
 * Trigger tags are dashboard-only diagnostics. A project-level Trigger API
 * rate-limit burst must not terminate otherwise healthy Agent work, while
 * unknown tag failures remain visible through the task's normal error path.
 */
export const addAgentLongTags = async (
  value: AgentLongTagValue,
  context: AgentLongTagUpdateContext,
): Promise<boolean> => {
  try {
    await tags.add(value);
    return true;
  } catch (error) {
    if (!isTriggerApiRateLimitError(error)) throw error;

    const errorCode = getErrorField(error, "code");
    triggerLogger.warn("[agent-long] tag update rate limited", {
      event: "agent_long_tag_update_rate_limited",
      service: "agent-long",
      reason: "trigger_api_rate_limited",
      statusCode: 429,
      stage: context.stage,
      runId: context.runId,
      chatId: context.chatId,
      userId: context.userId,
      ...(typeof errorCode === "string" ? { errorCode } : {}),
    });
    return false;
  }
};
