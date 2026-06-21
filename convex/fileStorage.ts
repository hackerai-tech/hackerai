import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import { internal } from "./_generated/api";
import { isSupportedImageMediaType } from "../lib/utils/file-utils";
import { fileCountAggregate } from "./fileAggregate";
import { convexLogger } from "./lib/logger";

// Maximum storage per user: 10 GB
const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024; // 10737418240 bytes

/**
 * Delete file from storage by file ID
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
      convexLogger.warn("file_delete_missing_file", {
        user_id: user.subject,
        file_id: args.fileId,
      });
      return null;
    }

    if (file.user_id !== user.subject) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: File does not belong to user",
      });
    }

    // Delete from S3 storage when this row still has an object reference.
    if (file.s3_key) {
      await ctx.scheduler.runAfter(0, internal.s3Cleanup.deleteS3ObjectAction, {
        s3Key: file.s3_key,
      });
    } else {
      console.warn(
        `File ${args.fileId} has no s3_key, skipping storage deletion`,
      );
    }

    await fileCountAggregate.deleteIfExists(ctx, file);

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
    userId: v.string(),
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

    // Return token sizes only for files owned by the requester.
    return files.map((file) =>
      file && file.user_id === args.userId ? file.file_token_size : 0,
    );
  },
});

/**
 * Get file metadata by file IDs using service key (for backend processing)
 */
export const getFileMetadataByFileIds = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(
    v.union(
      v.object({
        fileId: v.id("files"),
        name: v.string(),
        mediaType: v.string(),
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
      if (!file || file.user_id !== args.userId) {
        return null;
      }

      return {
        fileId: args.fileIds[index],
        name: file.name,
        mediaType: file.media_type,
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
    userId: v.string(),
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
      if (!file || file.user_id !== args.userId) {
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
        if (file.s3_key) {
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectAction,
            { s3Key: file.s3_key },
          );
        } else {
          console.warn(
            `File ${file._id} has no s3_key, skipping storage deletion`,
          );
        }
      } catch (e) {
        console.error(`Failed to delete storage for file ${file._id}:`, e);
      }

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
      s3_key: v.optional(v.string()),
      storage_id: v.optional(v.string()),
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

export const createPendingS3File = internalMutation({
  args: {
    s3Key: v.string(),
    userId: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("files")
      .withIndex("by_s3_key", (q) => q.eq("s3_key", args.s3Key))
      .unique();
    if (existing) {
      throw new ConvexError({
        code: "DUPLICATE_S3_KEY",
        message: "An upload reservation already exists for this S3 key",
      });
    }

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

    const fileId = await ctx.db.insert("files", {
      s3_key: args.s3Key,
      user_id: args.userId,
      name: args.name,
      media_type: args.mediaType,
      size: args.size,
      file_token_size: 0,
      is_attached: false,
    });

    const doc = await ctx.db.get(fileId);
    if (doc) {
      await fileCountAggregate.insertIfDoesNotExist(ctx, doc);
    }

    return fileId;
  },
});

/**
 * Internal mutation to save file metadata to database
 * This is separated from the action to handle database operations
 */
export const saveFileToDb = internalMutation({
  args: {
    s3Key: v.string(),
    userId: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    fileTokenSize: v.number(),
    content: v.optional(v.string()),
    trustedServiceGenerated: v.optional(v.boolean()),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    if (!args.s3Key) {
      throw new ConvexError({
        code: "S3_KEY_REQUIRED",
        message: "S3 key is required to save file metadata.",
      });
    }

    const existing = await ctx.db
      .query("files")
      .withIndex("by_s3_key", (q) => q.eq("s3_key", args.s3Key))
      .unique();
    if (existing) {
      if (existing.user_id !== args.userId) {
        throw new ConvexError({
          code: "UNAUTHORIZED",
          message: "Upload reservation does not belong to this user.",
        });
      }
      if (existing.size !== args.size) {
        throw new ConvexError({
          code: "FILE_SIZE_MISMATCH",
          message: "Uploaded file size does not match reserved size.",
        });
      }

      await ctx.db.patch(existing._id, {
        name: args.name,
        media_type: args.mediaType,
        file_token_size: args.fileTokenSize,
        content: args.content,
        is_attached: false,
      });
      return existing._id;
    }
    if (!args.trustedServiceGenerated) {
      throw new ConvexError({
        code: "MISSING_UPLOAD_RESERVATION",
        message: "S3 uploads must have an existing upload reservation.",
      });
    }

    // Check storage limit
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

    const fileId = await ctx.db.insert("files", {
      s3_key: args.s3Key,
      user_id: args.userId,
      name: args.name,
      media_type: args.mediaType,
      size: args.size,
      file_token_size: args.fileTokenSize,
      content: args.content,
      is_attached: false,
    });

    const doc = await ctx.db.get(fileId);
    if (doc) {
      await fileCountAggregate.insertIfDoesNotExist(ctx, doc);
    }

    return fileId;
  },
});

/**
 * Internal query to get user's current storage usage in bytes.
 */
export const getUserStorageUsage = internalQuery({
  args: {
    userId: v.string(),
  },
  returns: v.object({
    usedBytes: v.number(),
    maxBytes: v.number(),
    availableBytes: v.number(),
  }),
  handler: async (ctx, args) => {
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
