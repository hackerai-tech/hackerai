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

const crons = cronJobs();

crons.interval(
  "purge orphan files older than 24h",
  { hours: 1 },
  internal.crons.runPurge,
  {},
);

export default crons;
