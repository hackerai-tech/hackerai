import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

export const runPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const { deletedCount } = await ctx.runMutation(
        internal.fileStorage.purgeExpiredUnattachedFiles,
        { cutoffTimeMs: cutoff, limit: 100 },
      );
      if (deletedCount === 0) break;
    }
    return null;
  },
});

export const runLocalSandboxCleanup = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Cleanup stale connections
    await ctx.runMutation(internal.localSandbox.cleanupStaleConnections, {});

    // Cleanup old commands and results
    for (let i = 0; i < 10; i++) {
      const { deleted } = await ctx.runMutation(
        internal.localSandbox.cleanupOldCommands,
        {},
      );
      if (deleted === 0) break;
    }
    return null;
  },
});

export const runAggregateBackfill = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalProcessed = 0;
    let totalMigrated = 0;

    // Process all users in batches
    for (let i = 0; i < 100; i++) {
      const result: {
        processed: number;
        migrated: number;
        nextCursor: string | null;
        done: boolean;
      } = await ctx.runMutation(internal.aggregateMigrations.backfillAllUsers, {
        cursor: cursor ?? undefined,
        batchSize: 100,
      });

      totalProcessed += result.processed;
      totalMigrated += result.migrated;

      if (result.done) break;
      cursor = result.nextCursor;
    }

    if (totalMigrated > 0) {
      console.log(
        `Aggregate backfill: migrated ${totalMigrated}/${totalProcessed} users`,
      );
    }
    return null;
  },
});

const crons = cronJobs();

crons.interval(
  "purge orphan files older than 24h",
  { hours: 1 },
  internal.crons.runPurge,
  {},
);

crons.interval(
  "cleanup local sandbox stale connections and old commands",
  { minutes: 5 },
  internal.crons.runLocalSandboxCleanup,
  {},
);

crons.interval(
  "backfill user aggregates for unmigrated users",
  { hours: 24 },
  internal.crons.runAggregateBackfill,
  {},
);

export default crons;
