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

export default crons;
