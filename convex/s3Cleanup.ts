"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { deleteS3Object, getStoredS3Location } from "./s3Utils";
import { convexLogger } from "./lib/logger";

const s3ObjectValidator = v.object({
  s3Key: v.string(),
  s3Region: v.optional(v.string()),
  s3Bucket: v.optional(v.string()),
});

const deleteStoredS3Object = (
  s3Key: string,
  s3Region?: string,
  s3Bucket?: string,
) => {
  const storageLocation = getStoredS3Location(s3Region, s3Bucket);
  return storageLocation
    ? deleteS3Object(s3Key, storageLocation)
    : deleteS3Object(s3Key);
};

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
    s3Region: v.optional(v.string()),
    s3Bucket: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await deleteStoredS3Object(args.s3Key, args.s3Region, args.s3Bucket);
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
    s3Keys: v.optional(v.array(v.string())),
    s3Objects: v.optional(v.array(s3ObjectValidator)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s3Objects =
      args.s3Objects ??
      (args.s3Keys ?? []).map((s3Key) => ({
        s3Key,
        s3Region: undefined,
        s3Bucket: undefined,
      }));
    const results = await Promise.allSettled(
      s3Objects.map(async (object) =>
        deleteStoredS3Object(object.s3Key, object.s3Region, object.s3Bucket),
      ),
    );

    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed.length > 0) {
      convexLogger.error("s3_object_batch_delete_failed", {
        totalCount: s3Objects.length,
        failedCount: failed.length,
        failedKeys: s3Objects
          .map((object) => object.s3Key)
          .filter((_, i) => results[i].status === "rejected"),
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
