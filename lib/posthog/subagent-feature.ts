import "server-only";

import { getPostHogFeatureFlagForUser } from "./server";

export const SECURITY_TASK_SUBAGENTS_FLAG =
  "agent-subagents-security-task-v1" as const;

export const resolveSecurityTaskSubagentsEnabled = async (
  userId: string,
): Promise<boolean> =>
  await getPostHogFeatureFlagForUser(SECURITY_TASK_SUBAGENTS_FLAG, userId);
