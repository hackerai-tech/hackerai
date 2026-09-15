import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  assertTriggerRunRegion,
  TriggerRegionMismatchError,
} from "@/lib/api/trigger-region";
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
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5 * 60 * 1000,
    maxTimeoutInMs: 15 * 60 * 1000,
    randomize: true,
  },
  machine: { preset: "small-1x" },
  run: async (payload, { ctx }) => {
    try {
      assertTriggerRunRegion({
        requestedRegion: payload.triggerRegion,
        actualRegion: ctx.run.region,
        environmentType: ctx.environment.type,
      });
    } catch (error) {
      if (error instanceof TriggerRegionMismatchError)
        throw new AbortTaskRunError(
          "Miosa workspace migration region mismatch",
        );
      throw error;
    }
    try {
      const result = await migrateE2BWorkspace(payload);
      if (result.reason === "transfer_unavailable")
        throw new Error("Miosa workspace transfer temporarily unavailable");
      return result;
    } finally {
      await phLogger.flush().catch(() => undefined);
    }
  },
});
