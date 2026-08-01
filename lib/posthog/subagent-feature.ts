import "server-only";

import { getPostHogFeatureFlagForUser } from "./server";

export const SECURITY_VALIDATION_SUBAGENTS_FLAG =
  "agent-subagents-security-validation-v1" as const;

export const resolveSecurityValidationSubagentsEnabled = async (
  userId: string,
): Promise<boolean> =>
  await getPostHogFeatureFlagForUser(
    SECURITY_VALIDATION_SUBAGENTS_FLAG,
    userId,
  );
