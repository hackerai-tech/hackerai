import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const DEFAULT_BATCH_SIZE = 500;

const result = v.object({
  scanned: v.number(),
  cleared: v.number(),
  cursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});

/**
 * One-off cleanup: strip the legacy `byok_enabled` field from
 * `user_customization` rows. Idempotent — re-running on a clean table is a
 * no-op. Call repeatedly with the returned cursor until `isDone` is true.
 *
 *   npx convex run migrations:clearByokEnabledFlag
 *   npx convex run migrations:clearByokEnabledFlag '{"cursor":"<value>"}'
 *
 * Once both BYOK migrations are fully drained, drop `byok_enabled` from
 * `user_customization` in `schema.ts` and delete this file.
 */
export const clearByokEnabledFlag = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: result,
  handler: async (ctx, args) => {
    const numItems = args.limit ?? DEFAULT_BATCH_SIZE;
    const page = await ctx.db
      .query("user_customization")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let cleared = 0;
    for (const row of page.page) {
      if (row.byok_enabled !== undefined) {
        await ctx.db.patch(row._id, { byok_enabled: undefined });
        cleared++;
      }
    }

    return {
      scanned: page.page.length,
      cleared,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * One-off cleanup: strip the legacy `byok` field from `usage_logs` rows.
 * `usage_logs` can be large — call repeatedly with the returned cursor until
 * `isDone` is true (or wrap in a small loop script).
 *
 *   npx convex run migrations:clearByokFromUsageLogs
 *   npx convex run migrations:clearByokFromUsageLogs '{"cursor":"<value>"}'
 */
export const clearByokFromUsageLogs = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: result,
  handler: async (ctx, args) => {
    const numItems = args.limit ?? DEFAULT_BATCH_SIZE;
    const page = await ctx.db
      .query("usage_logs")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let cleared = 0;
    for (const row of page.page) {
      if (row.byok !== undefined) {
        await ctx.db.patch(row._id, { byok: undefined });
        cleared++;
      }
    }

    return {
      scanned: page.page.length,
      cleared,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
