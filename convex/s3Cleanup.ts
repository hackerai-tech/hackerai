"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { deleteS3Object } from "./s3Utils";
import { convexLogger } from "./lib/logger";

/**
 * Delete a single S3 object by key
 *
 * This internal action:
 * - Accepts an S3 key to delete
 * - Calls the deleteS3Object utility function
 * - Logs success or failure
 * - Does NOT throw errors to avoid blocking other operations
 */
export const deleteS3ObjectAction = internalAction({
  args: {
    s3Key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await deleteS3Object(args.s3Key);
      // console.log(`Successfully deleted S3 object: ${args.s3Key}`);
    } catch (error) {
      convexLogger.error("s3_object_delete_failed", {
        s3Key: args.s3Key,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      // Don't throw - we don't want to block other operations
    }
    return null;
  },
});

/**
 * Delete multiple S3 objects in batch
 *
 * This internal action:
 * - Accepts an array of S3 keys to delete
 * - Uses Promise.allSettled to delete all keys in parallel
 * - Logs the count of failed deletions
 * - Does NOT throw errors to avoid blocking other operations
 */
export const deleteS3ObjectsBatchAction = internalAction({
  args: {
    s3Keys: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const results = await Promise.allSettled(
      args.s3Keys.map((key) => deleteS3Object(key)),
    );

    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed.length > 0) {
      convexLogger.error("s3_object_batch_delete_failed", {
        totalCount: args.s3Keys.length,
        failedCount: failed.length,
        failedKeys: args.s3Keys.filter(
          (_, i) => results[i].status === "rejected",
        ),
        firstError:
          failed[0].reason instanceof Error
            ? {
                name: failed[0].reason.name,
                message: failed[0].reason.message,
              }
            : String(failed[0].reason),
      });
    }
    return null;
  },
});
