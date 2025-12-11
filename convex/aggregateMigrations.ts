import { v, ConvexError } from "convex/values";
import { internalMutation, mutation, MutationCtx } from "./_generated/server";
import { fileCountAggregate } from "./fileAggregate";
import { CURRENT_AGGREGATE_VERSION } from "./aggregateVersions";

interface MigrationResult {
  previousVersion: number;
  newVersion: number;
  migrated: boolean;
}

/**
 * Core migration logic shared between internal and public mutations.
 */
async function runMigration(
  ctx: MutationCtx,
  userId: string,
): Promise<MigrationResult> {
  const existingState = await ctx.db
    .query("user_aggregate_state")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .unique();

  const currentVersion = existingState?.version ?? 0;

  if (currentVersion >= CURRENT_AGGREGATE_VERSION) {
    return {
      previousVersion: currentVersion,
      newVersion: currentVersion,
      migrated: false,
    };
  }

  // Run migrations in order
  if (currentVersion < 1) {
    await migrateToV1(ctx, userId);
  }

  // Update or create the state record
  const now = Date.now();
  if (existingState) {
    await ctx.db.patch(existingState._id, {
      version: CURRENT_AGGREGATE_VERSION,
      updated_at: now,
    });
  } else {
    await ctx.db.insert("user_aggregate_state", {
      user_id: userId,
      version: CURRENT_AGGREGATE_VERSION,
      updated_at: now,
    });
  }

  return {
    previousVersion: currentVersion,
    newVersion: CURRENT_AGGREGATE_VERSION,
    migrated: true,
  };
}

/**
 * Migration v0 -> v1: Backfill file count aggregate
 *
 * Inserts all existing files for the user into the aggregate.
 */
async function migrateToV1(ctx: MutationCtx, userId: string): Promise<void> {
  const files = await ctx.db
    .query("files")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();

  for (const file of files) {
    await fileCountAggregate.insertIfDoesNotExist(ctx, file);
  }
}

/**
 * Internal mutation: Migrate a user's aggregates to the current version.
 *
 * This should be called during user login or session initialization.
 * It's idempotent - safe to call multiple times.
 *
 * Migration v0 -> v1: Backfill file count aggregate
 */
export const migrateUserAggregates = internalMutation({
  args: {
    userId: v.string(),
  },
  returns: v.object({
    previousVersion: v.number(),
    newVersion: v.number(),
    migrated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    return runMigration(ctx, args.userId);
  },
});

/**
 * Public mutation to trigger aggregate migration for the authenticated user.
 *
 * Called from the frontend when a user loads the app to ensure their
 * aggregates are up-to-date. Safe to call repeatedly (idempotent).
 */
export const ensureUserAggregatesMigrated = mutation({
  args: {},
  returns: v.object({
    migrated: v.boolean(),
  }),
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "User not authenticated",
      });
    }

    const result = await runMigration(ctx, user.subject);
    return { migrated: result.migrated };
  },
});
