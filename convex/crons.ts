import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * Purge unattached files (both Convex storage and S3) older than 24h
 */
export const runPurge = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const { deleteS3Files } = await import("./s3Utils");

    // Run purge in batches until no more files to delete
    for (let i = 0; i < 10; i++) {
      // Get batch of unattached files
      const files = await ctx.runQuery(
        internal.fileStorage.getUnattachedFiles,
        {
          cutoffTimeMs: cutoff,
          limit: 100,
        },
      );

      if (files.length === 0) break;

      // Collect S3 keys for batch deletion
      const s3Keys = files
        .filter((file) => file.s3_key)
        .map((file) => file.s3_key!);

      // Delete from storage (Convex or S3) before deleting DB records
      for (const file of files) {
        try {
          if (file.storage_id) {
            // Legacy Convex storage
            await ctx.storage.delete(file.storage_id);
          }
        } catch (error) {
          console.error(
            `Failed to delete storage for file ${file._id}:`,
            error,
          );
        }
      }

      // Batch delete all S3 files
      if (s3Keys.length > 0) {
        try {
          await deleteS3Files(s3Keys);
        } catch (error) {
          console.error("Failed to batch delete S3 files:", error);
        }
      }

      // Delete DB records after storage cleanup
      await ctx.runMutation(internal.fileStorage.deleteFileRecords, {
        fileIds: files.map((f) => f._id),
      });
    }

    return null;
  },
});

const crons = cronJobs();

crons.interval(
  "cleanup orphaned files (Convex + S3)",
  { hours: 1 },
  internal.crons.runPurge,
  {},
);

export default crons;
