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
  if (currentVersion < 2) {
    await migrateToV2(ctx, userId);
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
 * Migration v1 -> v2: Re-backfill aggregate with size sums
 *
 * Clears existing aggregate entries and re-inserts all files
 * to capture the new sumValue (file size) tracking.
 */
async function migrateToV2(ctx: MutationCtx, userId: string): Promise<void> {
  const files = await ctx.db
    .query("files")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();

  // Delete existing entries and re-insert to capture size sums
  for (const file of files) {
    await fileCountAggregate.deleteIfExists(ctx, file);
    await fileCountAggregate.insert(ctx, file);
  }
}

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

/**
 * Internal mutation to backfill aggregates for unmigrated users.
 *
 * This is an admin function that can be called from the Convex dashboard
 * or via `npx convex run aggregateMigrations:backfillAllUsers`.
 *
 * Scans files with Convex storage (storage_id defined) since those are
 * older files from before S3 migration. Users with only S3 files don't
 * need backfill as their aggregates are already correct.
 *
 * The runMigration function is idempotent - it skips users already at
 * the current version.
 */
export const backfillAllUsers = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    migrated: v.number(),
    nextCursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;

    // Query files with Convex storage (older files that need migration)
    // Uses by_storage_id index - undefined values are indexed separately
    const paginatedFiles = await ctx.db
      .query("files")
      .withIndex("by_storage_id")
      .order("asc")
      .paginate({
        numItems: batchSize * 10,
        cursor: args.cursor ? (JSON.parse(args.cursor) as never) : null,
      });

    // Filter to only files with storage_id (Convex storage)
    // and collect unique user IDs
    const userIdsInBatch = new Set<string>();
    for (const file of paginatedFiles.page) {
      if (file.storage_id !== undefined) {
        userIdsInBatch.add(file.user_id);
      }
    }

    let processed = 0;
    let migrated = 0;

    // Run migration for each unique user (skips if already migrated)
    for (const userId of userIdsInBatch) {
      const result = await runMigration(ctx, userId);
      processed++;
      if (result.migrated) {
        migrated++;
      }
    }

    const nextCursor = paginatedFiles.isDone
      ? null
      : JSON.stringify(paginatedFiles.continueCursor);

    return {
      processed,
      migrated,
      nextCursor,
      done: paginatedFiles.isDone,
    };
  },
});
