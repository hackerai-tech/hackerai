import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { terminateCloudSandboxesForUser } from "@/lib/ai/tools/utils/cloud-sandbox";

const ACCEPTANCE_PREVIEW_SLUG = "preview-codexmiosa-migration-acceptance";

/**
 * Temporary acceptance-only task for resetting the disposable migration test
 * account. This file must be removed before this branch is merged.
 */
export const previewMigrationAcceptanceReset = schemaTask({
  id: "preview-migration-acceptance-reset",
  schema: z.object({
    userId: z
      .string()
      .regex(/^user_[A-Za-z0-9]+$/)
      .max(128),
  }),
  retry: { maxAttempts: 1 },
  maxDuration: 10 * 60,
  run: async ({ userId }, { ctx }) => {
    if (
      ctx.environment.type !== "PREVIEW" ||
      ctx.environment.slug !== ACCEPTANCE_PREVIEW_SLUG
    ) {
      throw new AbortTaskRunError(
        "Acceptance reset is restricted to its dedicated Preview environment",
      );
    }

    return terminateCloudSandboxesForUser(userId);
  },
});
