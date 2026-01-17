import { QueryCtx } from "./_generated/server";

/**
 * Aggregate Version History:
 * 0 = default (no record exists) - no aggregates available
 * 1 = file count aggregate introduced
 * 2 = file size sum added to aggregate (re-backfill required)
 *
 * When adding new aggregates, increment CURRENT_AGGREGATE_VERSION
 * and add a new MIN_VERSION constant for the feature.
 */
export const CURRENT_AGGREGATE_VERSION = 2;

const FILE_COUNT_AGGREGATE_MIN_VERSION = 1;
const FILE_SIZE_AGGREGATE_MIN_VERSION = 2;

async function getUserAggregateVersion(
  ctx: QueryCtx,
  userId: string,
): Promise<number> {
  const state = await ctx.db
    .query("user_aggregate_state")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .unique();

  return state?.version ?? 0;
}

/**
 * Check if the file count aggregate is available for a user.
 * Returns true if the user has been migrated to version >= 1.
 */
export async function isFileCountAggregateAvailable(
  ctx: QueryCtx,
  userId: string,
): Promise<boolean> {
  const version = await getUserAggregateVersion(ctx, userId);
  return version >= FILE_COUNT_AGGREGATE_MIN_VERSION;
}

/**
 * Check if the file size aggregate (sum) is available for a user.
 * Returns true if the user has been migrated to version >= 2.
 */
export async function isFileSizeAggregateAvailable(
  ctx: QueryCtx,
  userId: string,
): Promise<boolean> {
  const version = await getUserAggregateVersion(ctx, userId);
  return version >= FILE_SIZE_AGGREGATE_MIN_VERSION;
}
