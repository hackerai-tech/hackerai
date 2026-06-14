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
import { convexLogger } from "./lib/logger";

// Maximum storage per user: 10 GB
const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024; // 10737418240 bytes
const LEGACY_CONVEX_PURGE_DEFAULT_LIMIT = 100;
const LEGACY_CONVEX_PURGE_MAX_LIMIT = 500;
const LEGACY_CONVEX_PURGE_SAMPLE_LIMIT = 20;

function isMissingConvexStorageError(error: unknown): boolean {
  return (
    error instanceof Error && /^storage id .+ not found$/.test(error.message)
  );
}

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

    // Direct lookup by storage_id using index
    const file = await ctx.db
      .query("files")
      .withIndex("by_storage_id", (q) =>
        q.eq("storage_id", args.storageId as Id<"_storage">),
      )
      .first();

    // Stale message/file UI can outlive deleted storage rows. Treat missing as
    // an unavailable URL instead of a Convex exception.
    if (!file) {
      convexLogger.warn("file_download_url_missing_file", {
        user_id: user.subject,
        storage_id: args.storageId,
      });
      return null;
    }

    if (file.user_id !== user.subject) {
      convexLogger.warn("file_download_url_access_denied", {
        user_id: user.subject,
        file_id: file._id,
        storage_id: args.storageId,
      });
      return null;
    }

    // Generate and return signed URL
    return await ctx.storage.getUrl(args.storageId);
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
      if (!file || file.user_id !== args.userId) {
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

      await fileCountAggregate.deleteIfExists(ctx, file);

      // Delete database record regardless of storage deletion result
      await ctx.db.delete(file._id);
      deletedCount++;
    }

    return { deletedCount };
  },
});

/**
 * Admin mutation: purge legacy Convex storage blobs for files older than a cutoff.
 *
 * New uploads use S3, but older file rows can still point at Convex storage via
 * `storage_id`. This deletes those blobs in batches and clears the storage ID
 * from the file row so old chat metadata can survive without exposing a
 * long-lived Convex storage URL. Pass `deleteDatabaseRecords: true` only if you
 * intentionally want the file rows removed as well.
 */
export const purgeLegacyConvexStorageFiles = mutation({
  args: {
    serviceKey: v.string(),
    cutoffTimeMs: v.number(),
    limit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    includeAttached: v.optional(v.boolean()),
    deleteDatabaseRecords: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    cutoffTimeMs: v.number(),
    limit: v.number(),
    includeAttached: v.boolean(),
    deleteDatabaseRecords: v.boolean(),
    candidateCount: v.number(),
    totalBytes: v.number(),
    attachedCount: v.number(),
    unattachedCount: v.number(),
    deletedStorageCount: v.number(),
    missingStorageCount: v.number(),
    detachedRecordCount: v.number(),
    deletedRecordCount: v.number(),
    aggregateRemovedCount: v.number(),
    aggregateFailedCount: v.number(),
    failedCount: v.number(),
    samples: v.array(
      v.object({
        fileId: v.id("files"),
        userId: v.string(),
        name: v.string(),
        size: v.number(),
        isAttached: v.boolean(),
        creationTimeMs: v.number(),
      }),
    ),
    failures: v.array(
      v.object({
        fileId: v.id("files"),
        name: v.string(),
        error: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const limit = Math.min(
      Math.max(Math.round(args.limit ?? LEGACY_CONVEX_PURGE_DEFAULT_LIMIT), 1),
      LEGACY_CONVEX_PURGE_MAX_LIMIT,
    );
    const dryRun = args.dryRun ?? true;
    const includeAttached = args.includeAttached ?? true;
    const deleteDatabaseRecords = args.deleteDatabaseRecords ?? false;

    const legacyQuery = ctx.db
      .query("files")
      .withIndex("by_s3_key", (q) =>
        q.eq("s3_key", undefined).lt("_creationTime", args.cutoffTimeMs),
      )
      .order("asc");

    const candidateRows = includeAttached
      ? await legacyQuery
          .filter((q) => q.neq(q.field("storage_id"), undefined))
          .take(limit)
      : await legacyQuery
          .filter((q) =>
            q.and(
              q.neq(q.field("storage_id"), undefined),
              q.eq(q.field("is_attached"), false),
            ),
          )
          .take(limit);

    type LegacyConvexFile = (typeof candidateRows)[number] & {
      storage_id: Id<"_storage">;
    };

    const candidates = candidateRows.filter(
      (file): file is LegacyConvexFile =>
        file.storage_id !== undefined && (includeAttached || !file.is_attached),
    );

    const totalBytes = candidates.reduce((sum, file) => sum + file.size, 0);
    const attachedCount = candidates.filter((file) => file.is_attached).length;
    const unattachedCount = candidates.length - attachedCount;
    const samples = candidates
      .slice(0, LEGACY_CONVEX_PURGE_SAMPLE_LIMIT)
      .map((file) => ({
        fileId: file._id,
        userId: file.user_id,
        name: file.name,
        size: file.size,
        isAttached: file.is_attached,
        creationTimeMs: file._creationTime,
      }));

    let deletedStorageCount = 0;
    let missingStorageCount = 0;
    let detachedRecordCount = 0;
    let deletedRecordCount = 0;
    let aggregateRemovedCount = 0;
    let aggregateFailedCount = 0;
    const failures: Array<{
      fileId: Id<"files">;
      name: string;
      error: string;
    }> = [];

    if (!dryRun) {
      for (const file of candidates) {
        try {
          try {
            await ctx.storage.delete(file.storage_id);
            deletedStorageCount++;
          } catch (error) {
            if (!isMissingConvexStorageError(error)) {
              throw error;
            }

            missingStorageCount++;
            convexLogger.warn("legacy_convex_storage_already_missing", {
              fileId: file._id,
              userId: file.user_id,
            });
          }

          try {
            await fileCountAggregate.deleteIfExists(ctx, file);
            aggregateRemovedCount++;
          } catch (error) {
            aggregateFailedCount++;
            convexLogger.warn(
              "legacy_convex_storage_aggregate_cleanup_failed",
              {
                fileId: file._id,
                userId: file.user_id,
                error:
                  error instanceof Error
                    ? {
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                      }
                    : String(error),
              },
            );
          }

          if (deleteDatabaseRecords) {
            await ctx.db.delete(file._id);
            deletedRecordCount++;
          } else {
            await ctx.db.patch(file._id, { storage_id: undefined });
            detachedRecordCount++;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push({
            fileId: file._id,
            name: file.name,
            error: message,
          });
          convexLogger.error("legacy_convex_storage_purge_failed", {
            fileId: file._id,
            userId: file.user_id,
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  }
                : String(error),
          });
        }
      }
    }

    const result = {
      dryRun,
      cutoffTimeMs: args.cutoffTimeMs,
      limit,
      includeAttached,
      deleteDatabaseRecords,
      candidateCount: candidates.length,
      totalBytes,
      attachedCount,
      unattachedCount,
      deletedStorageCount,
      missingStorageCount,
      detachedRecordCount,
      deletedRecordCount,
      aggregateRemovedCount,
      aggregateFailedCount,
      failedCount: failures.length,
      samples,
      failures,
    };

    convexLogger.info("legacy_convex_storage_purge_completed", {
      dryRun,
      cutoffTimeMs: args.cutoffTimeMs,
      limit,
      includeAttached,
      deleteDatabaseRecords,
      candidateCount: candidates.length,
      totalBytes,
      attachedCount,
      unattachedCount,
      deletedStorageCount,
      missingStorageCount,
      detachedRecordCount,
      deletedRecordCount,
      aggregateRemovedCount,
      aggregateFailedCount,
      failedCount: failures.length,
    });

    return result;
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
        storage_id: undefined,
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
