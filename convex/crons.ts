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

/**
 * Delete processed_webhooks rows older than 7 days. Stripe retries fall within
 * a ~72h window, so anything older is just idempotency dead weight.
 *
 * Processes up to 10 batches per run. If the last batch fills `limit`, more
 * work remains — schedule a follow-up so backlog can't outpace the daily cron.
 */
export const runProcessedWebhooksPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const limit = 100;
    let lastDeletedCount = 0;
    for (let i = 0; i < 10; i++) {
      const { deletedCount } = await ctx.runMutation(
        internal.extraUsage.purgeOldProcessedWebhooks,
        { cutoffTimeMs: cutoff, limit },
      );
      lastDeletedCount = deletedCount;
      if (deletedCount < limit) break;
    }
    if (lastDeletedCount === limit) {
      await ctx.scheduler.runAfter(
        0,
        internal.crons.runProcessedWebhooksPurge,
        {},
      );
    }
    return null;
  },
});

/**
 * Delete disconnected local_sandbox_connections older than 30 days. Keeps
 * recent disconnects around long enough for any UX/support lookups.
 *
 * Processes up to 10 batches per run. If the last batch fills `limit`, more
 * work remains — schedule a follow-up so backlog can't outpace the daily cron.
 */
export const runStaleConnectionsPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const limit = 100;
    let lastDeletedCount = 0;
    for (let i = 0; i < 10; i++) {
      const { deletedCount } = await ctx.runMutation(
        internal.localSandbox.purgeStaleDisconnectedConnections,
        { cutoffTimeMs: cutoff, limit },
      );
      lastDeletedCount = deletedCount;
      if (deletedCount < limit) break;
    }
    if (lastDeletedCount === limit) {
      await ctx.scheduler.runAfter(
        0,
        internal.crons.runStaleConnectionsPurge,
        {},
      );
    }
    return null;
  },
});

/**
 * Keep detailed per-request paid usage logs for user-facing history, while
 * relying on user_economics_daily for long-term economics.
 */
export const runUsageLogsPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const limit = 100;
    let lastDeletedCount = 0;
    for (let i = 0; i < 10; i++) {
      const { deletedCount } = await ctx.runMutation(
        internal.usageLogs.purgeOldUsageLogs,
        { cutoffTimeMs: cutoff, limit },
      );
      lastDeletedCount = deletedCount;
      if (deletedCount < limit) break;
    }
    if (lastDeletedCount === limit) {
      await ctx.scheduler.runAfter(0, internal.crons.runUsageLogsPurge, {});
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
  "purge processed webhook idempotency rows older than 7d",
  { hours: 24 },
  internal.crons.runProcessedWebhooksPurge,
  {},
);

crons.interval(
  "purge stale disconnected sandbox connections older than 30d",
  { hours: 24 },
  internal.crons.runStaleConnectionsPurge,
  {},
);

crons.interval(
  "purge detailed usage logs older than 90d",
  { hours: 24 },
  internal.crons.runUsageLogsPurge,
  {},
);

export default crons;
