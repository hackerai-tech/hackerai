"use node";

import { action } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { generateS3UploadUrl, generateS3DownloadUrl } from "./s3Utils";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";
import { checkFileUploadRateLimit } from "./fileActions";
import { Doc } from "./_generated/dataModel";

type StorageUsage = {
  usedBytes: number;
  maxBytes: number;
  availableBytes: number;
} | null;

/** File record returned by internal.fileStorage.getFileById */
type FileRecord = Doc<"files"> | null;

/**
 * Generate presigned S3 upload URL for authenticated users
 *
 * This action:
 * - Authenticates the user via ctx.auth
 * - Validates input parameters (fileName, contentType)
 * - Generates a user-scoped S3 key
 * - Returns a presigned upload URL, the S3 key, and rate limit info
 */
export const generateS3UploadUrlAction = action({
  args: {
    fileName: v.string(),
    contentType: v.string(),
  },
  returns: v.object({
    uploadUrl: v.string(),
    s3Key: v.string(),
    rateLimit: v.optional(
      v.object({
        remaining: v.number(),
        limit: v.number(),
        reset: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    // Authenticate user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error(
        "Unauthenticated: User must be logged in to upload files",
      );
    }

    // Validate inputs
    if (!args.fileName || args.fileName.trim().length === 0) {
      throw new Error("Invalid fileName: fileName cannot be empty");
    }

    if (!args.contentType || args.contentType.trim().length === 0) {
      throw new Error("Invalid contentType: contentType cannot be empty");
    }

    // Get user ID from identity
    const userId = identity.subject;

    // Check storage limit before allowing upload
    const storageUsage: StorageUsage = await ctx.runQuery(
      internal.fileStorage.getUserStorageUsage,
      { userId },
    );
    if (storageUsage && storageUsage.availableBytes <= 0) {
      const usedGB = (storageUsage.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
      throw new ConvexError({
        code: "STORAGE_LIMIT_EXCEEDED",
        message: `Storage limit exceeded. You are using ${usedGB} GB of 10 GB. Please delete some files to upload new ones.`,
      });
    }

    // Check rate limit and consume a token
    // This prevents abuse by spamming URL generation
    const rateLimitResult = await checkFileUploadRateLimit(userId, true);

    try {
      // Generate presigned upload URL with user-scoped S3 key
      const { uploadUrl, s3Key } = await generateS3UploadUrl(
        args.fileName,
        args.contentType,
        userId,
      );

      return {
        uploadUrl,
        s3Key,
        rateLimit: rateLimitResult
          ? {
              remaining: rateLimitResult.remaining,
              limit: rateLimitResult.limit,
              reset: rateLimitResult.reset,
            }
          : undefined,
      };
    } catch (error) {
      console.error("Failed to generate S3 upload URL:", error);
      throw new Error(
        "Failed to generate upload URL: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  },
});

/**
 * Generate download URL for a file (S3 presigned or Convex storage URL)
 *
 * This action:
 * - Authenticates the user via ctx.auth
 * - Fetches the file record from database
 * - Verifies user has access to the file (ownership check)
 * - Generates appropriate URL based on storage type:
 *   - S3: Returns presigned URL (valid for 1 hour)
 *   - Convex: Returns Convex storage URL
 * - Enforces storage invariant (exactly one storage reference)
 */
export const getFileUrlAction = action({
  args: {
    fileId: v.id("files"),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    // Authenticate user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error(
        "Unauthenticated: User must be logged in to access files",
      );
    }

    try {
      // Get file record using internal query
      const file: FileRecord = await ctx.runQuery(
        internal.fileStorage.getFileById,
        {
          fileId: args.fileId,
        },
      );

      if (!file) {
        throw new Error("File not found");
      }

      // Verify user has access to this file
      if (file.user_id !== identity.subject) {
        throw new Error(
          "Access denied: You do not have permission to access this file",
        );
      }

      // Enforce storage invariant: exactly one storage reference
      const hasS3Key = !!file.s3_key;
      const hasStorageId = !!file.storage_id;

      if (!hasS3Key && !hasStorageId) {
        throw new Error("File has no storage reference");
      }

      if (hasS3Key && hasStorageId) {
        throw new Error(
          "File has both S3 and Convex storage references (invalid state)",
        );
      }

      // Generate appropriate URL based on storage type
      if (file.s3_key) {
        // S3 file: Generate presigned download URL (valid for 1 hour)
        return await generateS3DownloadUrl(file.s3_key);
      } else {
        // Convex file: Get Convex storage URL
        const url = await ctx.storage.getUrl(file.storage_id!);
        if (!url) {
          throw new Error("Failed to generate Convex storage URL");
        }
        return url;
      }
    } catch (error) {
      console.error("Failed to get file URL:", error);
      throw new Error(
        "Failed to get file URL: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  },
});

/**
 * Backend batch URL generation for service key (server-side processing)
 *
 * This action:
 * - Authenticates via service key (for backend use)
 * - Accepts array of file IDs (max 50 files)
 * - Generates URLs for both S3 and Convex storage files
 * - Returns array of URLs (matching order of fileIds, null for missing files)
 * - Handles partial failures gracefully
 */
export const getFileUrlsByFileIdsAction = action({
  args: {
    serviceKey: v.string(),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, args): Promise<Array<string | null>> => {
    // Verify service role key
    validateServiceKey(args.serviceKey);

    // Enforce batch size limit
    const MAX_BATCH_SIZE = 50;
    if (args.fileIds.length > MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size exceeds limit: Maximum ${MAX_BATCH_SIZE} files allowed per request (requested: ${args.fileIds.length})`,
      );
    }

    // Get file records and generate URLs
    const urls: Array<string | null> = await Promise.all(
      args.fileIds.map(async (fileId): Promise<string | null> => {
        try {
          // Get file record using internal query
          const file: FileRecord = await ctx.runQuery(
            internal.fileStorage.getFileById,
            { fileId },
          );

          // Return null if file not found
          if (!file) {
            return null;
          }

          // Generate URL based on storage type
          if (file.s3_key) {
            // S3 file: Generate presigned download URL
            return await generateS3DownloadUrl(file.s3_key);
          } else if (file.storage_id) {
            // Convex file: Get Convex storage URL
            return await ctx.storage.getUrl(file.storage_id);
          }

          return null;
        } catch (error) {
          console.error(`Failed to generate URL for file ${fileId}:`, error);
          return null;
        }
      }),
    );

    return urls;
  },
});

/**
 * Batch URL generation for multiple files
 *
 * This action:
 * - Authenticates the user via ctx.auth
 * - Accepts array of file IDs (max 50 files)
 * - Fetches file records using internal query
 * - Applies access control per file (skips files user doesn't own)
 * - Generates URLs for accessible files only (S3 presigned or Convex storage)
 * - Processes S3 URLs in parallel for better performance
 * - Returns map of fileId -> url (only includes accessible files)
 * - Handles partial failures gracefully (skips failed files)
 */
export const getFileUrlsBatchAction = action({
  args: {
    fileIds: v.array(v.id("files")),
  },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, args): Promise<Record<string, string>> => {
    // Authenticate user
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error(
        "Unauthenticated: User must be logged in to access files",
      );
    }

    // Enforce batch size limit
    const MAX_BATCH_SIZE = 50;
    if (args.fileIds.length > MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size exceeds limit: Maximum ${MAX_BATCH_SIZE} files allowed per request (requested: ${args.fileIds.length})`,
      );
    }

    const urlMap: Record<string, string> = {};

    // Process each file - access control per file
    for (const fileId of args.fileIds) {
      try {
        // Get file record using internal query
        const file: FileRecord = await ctx.runQuery(
          internal.fileStorage.getFileById,
          {
            fileId,
          },
        );

        // Skip if file not found
        if (!file) {
          continue;
        }

        // Skip if user doesn't own this file (access control)
        if (file.user_id !== identity.subject) {
          continue;
        }

        // Enforce storage invariant
        const hasS3Key = !!file.s3_key;
        const hasStorageId = !!file.storage_id;

        // Skip if no storage reference
        if (!hasS3Key && !hasStorageId) {
          continue;
        }

        // Skip if both storage references (invalid state)
        if (hasS3Key && hasStorageId) {
          continue;
        }

        // Generate URL based on storage type
        if (file.s3_key) {
          // S3 file: Generate presigned download URL
          const url = await generateS3DownloadUrl(file.s3_key);
          urlMap[fileId] = url;
        } else if (file.storage_id) {
          // Convex file: Get Convex storage URL
          const url = await ctx.storage.getUrl(file.storage_id);
          if (url) {
            urlMap[fileId] = url;
          }
        }
      } catch (error) {
        // Log error but continue processing other files (partial failure handling)
        console.error(`Failed to generate URL for file ${fileId}:`, error);
        continue;
      }
    }

    return urlMap;
  },
});
