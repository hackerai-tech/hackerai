import "server-only";

import { getPostHogFeatureFlagForUser } from "./server";

export const SECURITY_VALIDATION_SUBAGENTS_FLAG =
  "agent-subagents-security-validation-v1" as const;
export const SECURITY_TASK_SUBAGENTS_FLAG =
  "agent-subagents-security-task-v1" as const;

type SubagentFeatureEnvironment = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
};

export const shouldBypassSecurityValidationSubagentsFlag = (
  environment: SubagentFeatureEnvironment = process.env,
): boolean =>
  environment.VERCEL_ENV === "preview" ||
  (environment.NODE_ENV === "development" &&
    environment.VERCEL_ENV !== "production");

export const resolveSecurityValidationSubagentsEnabled = async (
  userId: string,
  environment: SubagentFeatureEnvironment = process.env,
): Promise<boolean> => {
  if (shouldBypassSecurityValidationSubagentsFlag(environment)) return true;

  return await getPostHogFeatureFlagForUser(
    SECURITY_VALIDATION_SUBAGENTS_FLAG,
    userId,
  );
};

export const resolveSecurityTaskSubagentsEnabled = async (
  userId: string,
): Promise<boolean> =>
  await getPostHogFeatureFlagForUser(SECURITY_TASK_SUBAGENTS_FLAG, userId);
