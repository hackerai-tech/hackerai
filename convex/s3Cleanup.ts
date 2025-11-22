"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { deleteS3Object } from "./s3Utils";

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
      console.error(`Failed to delete S3 object: ${args.s3Key}`, error);
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

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.error(`Failed to delete ${failed.length} S3 objects`);
    }
    return null;
  },
});
