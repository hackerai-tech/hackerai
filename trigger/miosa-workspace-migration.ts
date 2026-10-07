import { AbortTaskRunError, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  assertTriggerRunRegion,
  TriggerRegionMismatchError,
} from "@/lib/api/trigger-region";
import { migrateE2BWorkspace } from "@/lib/ai/tools/utils/miosa-workspace-migration";
import { E2B_FILE_MIGRATION_TASK } from "@/lib/ai/tools/utils/miosa-workspace-migration-queue";
import { phLogger } from "@/lib/posthog/server";

const RECENT_IDLE_RECHECKS = 3;
const RECENT_IDLE_RECHECK_MINUTES = 15;

function shouldRecheckWhenIdle(reason: string) {
  return (
    reason === "source_active" ||
    reason === "workspace_in_use" ||
    reason === "migration_in_progress"
  );
}

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
      for (let recheck = 0; ; recheck += 1) {
        const result = await migrateE2BWorkspace({
          ...payload,
          triggerRunId: ctx.run.id,
          triggerAttempt: ctx.attempt.number,
          environment: ctx.environment.type,
        });
        if (
          shouldRecheckWhenIdle(result.reason) &&
          recheck < RECENT_IDLE_RECHECKS
        ) {
          // The acquisition that nominated this workspace stays on E2B. Keep
          // only this recent candidate alive until its sandbox becomes idle.
          await phLogger.flush().catch(() => undefined);
          await wait.for({ minutes: RECENT_IDLE_RECHECK_MINUTES });
          continue;
        }
        if (result.reason === "transfer_unavailable") {
          const failure = result as Record<string, unknown>;
          const diagnostic = ["failureStage", "failureOperation", "failureKind"]
            .map((key) => failure[key])
            .filter((value): value is string => typeof value === "string")
            .join("/");
          throw new Error(
            `Miosa workspace transfer temporarily unavailable (${diagnostic})`,
          );
        }
        return result;
      }
    } finally {
      await phLogger.flush().catch(() => undefined);
    }
  },
});
