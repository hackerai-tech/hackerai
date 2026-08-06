import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;

const normalizeBatchSize = (requested?: number): number => {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(requested)));
};

/**
 * Inspect one bounded page of the retired temp_streams table. Callers should
 * follow continueCursor until isDone and sum rowCount before purging.
 */
export const inspectLegacyTempStreams = query({
  args: {
    serviceKey: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    rowCount: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const result = await ctx.db
      .query("temp_streams")
      .order("asc")
      .paginate({
        cursor: args.cursor,
        numItems: normalizeBatchSize(args.numItems),
      });

    return {
      rowCount: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Delete one bounded batch from the retired temp_streams table. Repeat while
 * hasMore is true, then inspect again and remove this migration surface only
 * after the production table is verified empty.
 */
export const purgeLegacyTempStreams = mutation({
  args: {
    serviceKey: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    deletedCount: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const limit = normalizeBatchSize(args.limit);
    const rows = await ctx.db
      .query("temp_streams")
      .order("asc")
      .take(limit + 1);
    const rowsToDelete = rows.slice(0, limit);

    for (const row of rowsToDelete) {
      await ctx.db.delete(row._id);
    }

    return {
      deletedCount: rowsToDelete.length,
      hasMore: rows.length > limit,
    };
  },
});
