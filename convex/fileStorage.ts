import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { internal } from "./_generated/api";
import { isSupportedImageMediaType } from "../lib/utils/file-utils";
import { fileCountAggregate } from "./fileAggregate";
import { isFileSizeAggregateAvailable } from "./aggregateVersions";

// Maximum storage per user: 10 GB
const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024; // 10737418240 bytes

/**
 * Get download URL for a file by storageId (on-demand for non-image files)
 */
export const getFileDownloadUrl = query({
  args: {
    storageId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      // Direct lookup by storage_id using index
      const file = await ctx.db
        .query("files")
        .withIndex("by_storage_id", (q) =>
          q.eq("storage_id", args.storageId as Id<"_storage">),
        )
        .first();

      // Verify file exists and belongs to user
      if (!file || file.user_id !== user.subject) {
        throw new ConvexError({
          code: "FILE_NOT_FOUND",
          message: "File not found",
        });
      }

      // Generate and return signed URL
      const url = await ctx.storage.getUrl(args.storageId);
      return url;
    } catch (error) {
      console.error("Failed to get file download URL:", error);
      throw error;
    }
  },
});

/**
 * Delete file from storage by file ID
 * Handles both S3 and Convex storage files
 */
export const deleteFile = mutation({
  args: {
    fileId: v.id("files"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    const file = await ctx.db.get(args.fileId);

    if (!file) {
      throw new ConvexError({
        code: "FILE_NOT_FOUND",
        message: "File not found",
      });
    }

    if (file.user_id !== user.subject) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: File does not belong to user",
      });
    }

    // Delete from appropriate storage
    if (file.s3_key) {
      // Schedule S3 deletion using the cleanup action
      await ctx.scheduler.runAfter(0, internal.s3Cleanup.deleteS3ObjectAction, {
        s3Key: file.s3_key,
      });
    } else if (file.storage_id) {
      // Delete from Convex storage
      await ctx.storage.delete(file.storage_id);
    } else {
      console.warn(
        `File ${args.fileId} has neither s3_key nor storage_id, skipping storage deletion`,
      );
    }

    // Delete from aggregate (uses deleteIfExists for idempotency with pre-backfill data)
    await fileCountAggregate.deleteIfExists(ctx, file);

    // Delete database record
    await ctx.db.delete(args.fileId);

    return null;
  },
});

/**
 * Get file token sizes by file IDs using service key (for backend processing)
 */
export const getFileTokensByFileIds = query({
  args: {
    serviceKey: v.string(),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.number()),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Get file records from database to extract token sizes
    const files = await Promise.all(
      args.fileIds.map((fileId) => ctx.db.get(fileId)),
    );

    // Return token sizes, defaulting to 0 for missing files
    return files.map((file) => file?.file_token_size ?? 0);
  },
});

/**
 * Get file metadata by file IDs using service key (for backend processing)
 */
export const getFileMetadataByFileIds = query({
  args: {
    serviceKey: v.string(),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(
    v.union(
      v.object({
        fileId: v.id("files"),
        name: v.string(),
        mediaType: v.string(),
        storageId: v.optional(v.id("_storage")),
        s3Key: v.optional(v.string()),
      }),
      v.null(),
    ),
  ),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Get file records from database
    const files = await Promise.all(
      args.fileIds.map((fileId) => ctx.db.get(fileId)),
    );

    // Return file metadata
    return files.map((file, index) => {
      if (!file) {
        return null;
      }

      return {
        fileId: args.fileIds[index],
        name: file.name,
        mediaType: file.media_type,
        storageId: file.storage_id,
        s3Key: file.s3_key,
      };
    });
  },
});

/**
 * Get file content and metadata by file IDs using service key (for backend processing)
 * Only returns content for non-image, non-PDF files
 */
export const getFileContentByFileIds = query({
  args: {
    serviceKey: v.string(),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      mediaType: v.string(),
      content: v.union(v.string(), v.null()),
      tokenSize: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Get file records from database
    const files = await Promise.all(
      args.fileIds.map((fileId) => ctx.db.get(fileId)),
    );

    // Return file content and metadata
    return files.map((file, index) => {
      if (!file) {
        return {
          id: args.fileIds[index],
          name: "Unknown",
          mediaType: "unknown",
          content: null,
          tokenSize: 0,
        };
      }

      // Only return content for non-image, non-PDF files
      // Note: Supported image formats don't have content, unsupported images may have extracted content
      const isSupportedImage = isSupportedImageMediaType(file.media_type);
      const isPdf = file.media_type === "application/pdf";

      return {
        id: args.fileIds[index],
        name: file.name,
        mediaType: file.media_type,
        content: isSupportedImage || isPdf ? null : file.content || null,
        tokenSize: file.file_token_size,
      };
    });
  },
});

/**
 * Internal mutation: purge unattached files older than cutoff
 * Handles both S3 and Convex storage files
 */
export const purgeExpiredUnattachedFiles = internalMutation({
  args: {
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deletedCount: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const candidates = await ctx.db
      .query("files")
      .withIndex("by_is_attached", (q) =>
        q.eq("is_attached", false).lt("_creationTime", args.cutoffTimeMs),
      )
      .order("asc")
      .take(limit);

    let deletedCount = 0;
    for (const file of candidates) {
      try {
        // Delete from appropriate storage
        if (file.s3_key) {
          // Schedule S3 deletion using the cleanup action
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectAction,
            { s3Key: file.s3_key },
          );
        } else if (file.storage_id) {
          // Delete from Convex storage
          await ctx.storage.delete(file.storage_id);
        } else {
          console.warn(
            `File ${file._id} has neither s3_key nor storage_id, skipping storage deletion`,
          );
        }
      } catch (e) {
        console.error(`Failed to delete storage for file ${file._id}:`, e);
      }

      // Delete from aggregate (uses deleteIfExists for idempotency with pre-backfill data)
      await fileCountAggregate.deleteIfExists(ctx, file);

      // Delete database record regardless of storage deletion result
      await ctx.db.delete(file._id);
      deletedCount++;
    }

    return { deletedCount };
  },
});

/**
 * Internal query to get a file by ID
 * Used by actions that need to verify file existence and ownership
 */
export const getFileById = internalQuery({
  args: {
    fileId: v.id("files"),
  },
  returns: v.union(
    v.object({
      _id: v.id("files"),
      storage_id: v.optional(v.id("_storage")),
      s3_key: v.optional(v.string()),
      user_id: v.string(),
      name: v.string(),
      media_type: v.string(),
      size: v.number(),
      file_token_size: v.number(),
      content: v.optional(v.string()),
      is_attached: v.boolean(),
      _creationTime: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    return file;
  },
});

/**
 * Internal mutation to save file metadata to database
 * This is separated from the action to handle database operations
 */
export const saveFileToDb = internalMutation({
  args: {
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    userId: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    fileTokenSize: v.number(),
    content: v.optional(v.string()),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    // Check storage limit if aggregate is available (user has been migrated)
    const sizeAggregateAvailable = await isFileSizeAggregateAvailable(
      ctx,
      args.userId,
    );
    if (sizeAggregateAvailable) {
      const currentStorageBytes = await fileCountAggregate.sum(ctx, {
        namespace: args.userId,
      });
      if (currentStorageBytes + args.size > MAX_STORAGE_BYTES) {
        const usedGB = (currentStorageBytes / (1024 * 1024 * 1024)).toFixed(2);
        throw new ConvexError({
          code: "STORAGE_LIMIT_EXCEEDED",
          message: `Storage limit exceeded. You are using ${usedGB} GB of 10 GB.`,
        });
      }
    }

    const fileId = await ctx.db.insert("files", {
      storage_id: args.storageId,
      s3_key: args.s3Key,
      user_id: args.userId,
      name: args.name,
      media_type: args.mediaType,
      size: args.size,
      file_token_size: args.fileTokenSize,
      content: args.content,
      is_attached: false,
    });

    // Insert into aggregate for O(log(n)) counting
    // Uses insertIfDoesNotExist for idempotency in case of race with backfill
    const doc = await ctx.db.get(fileId);
    if (doc) {
      await fileCountAggregate.insertIfDoesNotExist(ctx, doc);
    }

    return fileId;
  },
});

/**
 * Internal query to get user's current storage usage in bytes.
 * Returns null if the aggregate is not yet available (user not migrated).
 */
export const getUserStorageUsage = internalQuery({
  args: {
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      usedBytes: v.number(),
      maxBytes: v.number(),
      availableBytes: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const sizeAggregateAvailable = await isFileSizeAggregateAvailable(
      ctx,
      args.userId,
    );
    if (!sizeAggregateAvailable) {
      return null;
    }

    const usedBytes = await fileCountAggregate.sum(ctx, {
      namespace: args.userId,
    });

    return {
      usedBytes,
      maxBytes: MAX_STORAGE_BYTES,
      availableBytes: Math.max(0, MAX_STORAGE_BYTES - usedBytes),
    };
  },
});
