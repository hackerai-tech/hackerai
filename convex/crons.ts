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
 */
export const runProcessedWebhooksPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const { deletedCount } = await ctx.runMutation(
        internal.extraUsage.purgeOldProcessedWebhooks,
        { cutoffTimeMs: cutoff, limit: 100 },
      );
      if (deletedCount === 0) break;
    }
    return null;
  },
});

/**
 * Delete disconnected local_sandbox_connections older than 30 days. Keeps
 * recent disconnects around long enough for any UX/support lookups.
 */
export const runStaleConnectionsPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const { deletedCount } = await ctx.runMutation(
        internal.localSandbox.purgeStaleDisconnectedConnections,
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

export default crons;
