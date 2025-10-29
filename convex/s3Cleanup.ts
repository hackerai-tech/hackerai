"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * Delete a single S3 object by key (Node action)
 * Called by mutations when S3 files need to be deleted
 */
export const deleteS3Object = internalAction({
  args: { s3Key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { deleteS3File } = await import("./s3Utils");
    try {
      await deleteS3File(args.s3Key);
    } catch (error) {
      console.error("Failed to delete S3 object:", args.s3Key, error);
    }
    return null;
  },
});

/**
 * Delete multiple S3 objects by keys (Node action)
 * More efficient than calling deleteS3Object multiple times
 */
export const deleteS3Objects = internalAction({
  args: { s3Keys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.s3Keys.length === 0) return null;

    const { deleteS3Files } = await import("./s3Utils");
    try {
      await deleteS3Files(args.s3Keys);
    } catch (error) {
      console.error("Failed to batch delete S3 objects:", error);
    }
    return null;
  },
});
