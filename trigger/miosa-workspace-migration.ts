import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { assertTriggerRunRegion } from "@/lib/api/trigger-region";
import { migrateE2BWorkspace } from "@/lib/ai/tools/utils/miosa-workspace-migration";
import { E2B_FILE_MIGRATION_TASK } from "@/lib/ai/tools/utils/miosa-workspace-migration-queue";
import { phLogger } from "@/lib/posthog/server";

export const miosaWorkspaceMigration = schemaTask({
  id: E2B_FILE_MIGRATION_TASK,
  schema: z.object({
    userId: z.string().min(1).max(256),
    sourceId: z.string().min(1).max(256),
    subscription: z.enum(["pro", "pro-plus", "ultra", "team"]),
    triggerRegion: z.enum(["us-east-1", "us-west-2"]),
  }),
  queue: { concurrencyLimit: 2 },
  maxDuration: 2 * 60 * 60,
  retry: { maxAttempts: 1 },
  machine: { preset: "small-1x" },
  run: async (payload, { ctx }) => {
    assertTriggerRunRegion({
      requestedRegion: payload.triggerRegion,
      actualRegion: ctx.run.region,
      environmentType: ctx.environment.type,
    });
    try {
      return await migrateE2BWorkspace(payload);
    } finally {
      await phLogger.flush().catch(() => undefined);
    }
  },
});
