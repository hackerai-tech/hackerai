"use node";

import { action } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import {
  generateS3UploadUrl,
  generateS3DownloadUrl,
  getStoredS3Location,
} from "./s3Utils";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";
import { checkFileUploadRateLimit } from "./fileActions";
import { validateUploadPolicy } from "../lib/utils/upload-policy";
import { hasPaidEntitlement } from "../lib/auth/entitlements";

type StorageUsage = {
  usedBytes: number;
  maxBytes: number;
  availableBytes: number;
} | null;

/** File record returned by internal.fileStorage.getFileById */
type FileRecord = {
  s3_key?: string;
  s3_region?: string;
  s3_bucket?: string;
  user_id: string;
  name: string;
  media_type: string;
  size: number;
  auxiliary_vision_description?: string;
  auxiliary_vision_model?: string;
} | null;

const s3StorageRegionValidator = v.union(
  v.literal("eu-central-1"),
  v.literal("us-east-1"),
  v.literal("us-west-2"),
);

const getFileStorageLocation = (file: NonNullable<FileRecord>) =>
  getStoredS3Location(file.s3_region, file.s3_bucket);

const generateFileDownloadUrl = (file: NonNullable<FileRecord>) => {
  if (!file.s3_key) throw new Error("File has no S3 object reference");
  const storageLocation = getFileStorageLocation(file);
  return storageLocation
    ? generateS3DownloadUrl(file.s3_key, storageLocation)
    : generateS3DownloadUrl(file.s3_key);
};

const getFileLookupErrorFields = (error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : "";
  const reason =
    (error instanceof Error && error.name === "ReturnsValidationError") ||
    errorMessage.includes("ReturnsValidationError") ||
    errorMessage.includes("Value does not match validator")
      ? "returns_validation"
      : "unknown";

  return { reason };
};

const serviceFileUrlInfoValidator = v.object({
  url: v.string(),
  sizeBytes: v.number(),
  mediaType: v.string(),
  name: v.string(),
  auxiliaryVisionDescription: v.optional(v.string()),
  auxiliaryVisionModel: v.optional(v.string()),
});

type ServiceFileUrlInfo = {
  url: string;
  sizeBytes: number;
  mediaType: string;
  name: string;
  auxiliaryVisionDescription?: string;
  auxiliaryVisionModel?: string;
};

const MAX_SERVICE_FILE_URL_BATCH_SIZE = 50;

const getIdentityEntitlements = (identity: unknown) => {
  if (
    !identity ||
    typeof identity !== "object" ||
    !("entitlements" in identity)
  ) {
    return [];
  }

  const entitlements = identity.entitlements;
  return Array.isArray(entitlements)
    ? entitlements.filter(
        (entitlement: unknown): entitlement is string =>
          typeof entitlement === "string",
      )
    : [];
};

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
    size: v.optional(v.number()),
    mode: v.optional(v.union(v.literal("ask"), v.literal("agent"))),
    storageRegion: v.optional(s3StorageRegionValidator),
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

    if (
      args.size === undefined ||
      !Number.isFinite(args.size) ||
      args.size <= 0
    ) {
      throw new ConvexError({
        code: "INVALID_FILE_SIZE",
        message:
          "A positive file size is required before generating an upload URL",
      });
    }

    const validation = validateUploadPolicy({
      mode: args.mode ?? "ask",
      size: args.size,
      mediaType: args.contentType,
      surface: "client",
    });

    if (!validation.valid) {
      throw new ConvexError({
        code: validation.code,
        message: validation.message,
      });
    }

    const userId = identity.subject;
    const entitlements = getIdentityEntitlements(identity);

    if (!hasPaidEntitlement(entitlements)) {
      throw new ConvexError({
        code: "PAID_PLAN_REQUIRED",
        message: "Paid plan required for file uploads",
      });
    }

    // Check storage limit before allowing upload
    const storageUsage: StorageUsage = await ctx.runQuery(
      internal.fileStorage.getUserStorageUsage,
      { userId },
    );
    if (storageUsage.availableBytes <= 0) {
      const usedGB = (storageUsage.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
      throw new ConvexError({
        code: "STORAGE_LIMIT_EXCEEDED",
        message: `Storage limit exceeded. You are using ${usedGB} GB of 10 GB. Please delete some files to upload new ones.`,
      });
    }
    if (args.size !== undefined && storageUsage.availableBytes < args.size) {
      const usedGB = (storageUsage.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
      const requestedMB = (args.size / (1024 * 1024)).toFixed(2);
      throw new ConvexError({
        code: "STORAGE_LIMIT_EXCEEDED",
        message: `Storage limit exceeded. You are using ${usedGB} GB of 10 GB and this file requires ${requestedMB} MB. Please delete some files to upload new ones.`,
      });
    }

    // Check rate limit and consume a token
    // This prevents abuse by spamming URL generation
    const rateLimitResult = await checkFileUploadRateLimit(userId, true, {
      entitlements,
    });

    try {
      // Generate presigned upload URL with user-scoped S3 key
      const { uploadUrl, s3Key, storageLocation } = args.storageRegion
        ? await generateS3UploadUrl(
            args.fileName,
            args.contentType,
            userId,
            args.size,
            args.storageRegion,
          )
        : await generateS3UploadUrl(
            args.fileName,
            args.contentType,
            userId,
            args.size,
          );

      await ctx.runMutation(internal.fileStorage.createPendingS3File, {
        s3Key,
        userId,
        name: args.fileName,
        mediaType: args.contentType,
        size: args.size,
        s3Region: storageLocation.region,
        s3Bucket: storageLocation.bucket,
      });

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
      if (error instanceof ConvexError) {
        throw error;
      }
      convexLogger.error("file_upload_url_generation_failed", {
        userId,
        fileName: args.fileName,
        contentType: args.contentType,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      throw new Error(
        "Failed to generate upload URL: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    }
  },
});

/**
 * Generate an S3 presigned download URL for a file.
 *
 * This action:
 * - Authenticates the user via ctx.auth
 * - Fetches the file record from database
 * - Verifies user has access to the file (ownership check)
 * - Returns null when the file is missing, inaccessible, or no longer has an
 *   S3 object reference
 * - Returns a presigned URL (valid for 1 hour)
 */
export const getFileUrlAction = action({
  args: {
    fileId: v.id("files"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
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
        return null;
      }

      // Verify user has access to this file
      if (file.user_id !== identity.subject) {
        return null;
      }

      if (!file.s3_key) {
        return null;
      }

      // S3 file: Generate presigned download URL (valid for 1 hour)
      return await generateFileDownloadUrl(file);
    } catch (error) {
      convexLogger.error("file_get_url_failed", {
        userId: identity.subject,
        fileId: args.fileId,
        ...getFileLookupErrorFields(error),
      });
      throw new Error("Failed to get file URL");
    }
  },
});

/**
 * Backend batch URL generation for service key (server-side processing)
 *
 * This action:
 * - Authenticates via service key (for backend use)
 * - Accepts array of file IDs (max 50 files)
 * - Generates S3 presigned URLs
 * - Returns array of URLs (matching order of fileIds, null for missing files)
 * - Handles partial failures gracefully
 *
 * Keep this return shape string-only for deploy skew compatibility with older
 * workers. New callers that need file metadata should use
 * getFileUrlInfosByFileIdsAction.
 */
export const getFileUrlsByFileIdsAction = action({
  args: {
    serviceKey: v.string(),
    userId: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, args): Promise<Array<string | null>> => {
    // Verify service role key
    validateServiceKey(args.serviceKey);
    if (!args.userId) {
      throw new Error("Missing userId for service file URL fetch");
    }

    // Enforce batch size limit
    if (args.fileIds.length > MAX_SERVICE_FILE_URL_BATCH_SIZE) {
      throw new Error(
        `Batch size exceeds limit: Maximum ${MAX_SERVICE_FILE_URL_BATCH_SIZE} files allowed per request (requested: ${args.fileIds.length})`,
      );
    }
    if (args.fileIds.length === 0) {
      return [];
    }

    let files: FileRecord[];
    try {
      files = await ctx.runQuery(internal.fileStorage.getFilesByIds, {
        fileIds: args.fileIds,
      });
    } catch (error) {
      convexLogger.error("file_batch_lookup_failed", {
        caller: "service",
        fileCount: args.fileIds.length,
        ...getFileLookupErrorFields(error),
      });
      return args.fileIds.map(() => null);
    }

    // Get file records and generate URLs
    const urls: Array<string | null> = await Promise.all(
      args.fileIds.map(async (fileId, index): Promise<string | null> => {
        try {
          const file = files[index];

          if (!file || file.user_id !== args.userId) {
            return null;
          }

          if (file.s3_key) {
            return await generateFileDownloadUrl(file);
          }

          return null;
        } catch (error) {
          convexLogger.error("file_batch_url_generation_failed", {
            fileId,
            caller: "service",
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : String(error),
          });
          return null;
        }
      }),
    );

    return urls;
  },
});

/**
 * Metadata-aware service URL lookup for workers that need trusted DB file
 * attributes before sending provider-visible media URLs.
 */
export const getFileUrlInfosByFileIdsAction = action({
  args: {
    serviceKey: v.string(),
    userId: v.optional(v.string()),
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(v.union(serviceFileUrlInfoValidator, v.null())),
  handler: async (ctx, args): Promise<Array<ServiceFileUrlInfo | null>> => {
    validateServiceKey(args.serviceKey);
    if (!args.userId) {
      throw new Error("Missing userId for service file URL fetch");
    }

    if (args.fileIds.length > MAX_SERVICE_FILE_URL_BATCH_SIZE) {
      throw new Error(
        `Batch size exceeds limit: Maximum ${MAX_SERVICE_FILE_URL_BATCH_SIZE} files allowed per request (requested: ${args.fileIds.length})`,
      );
    }
    if (args.fileIds.length === 0) {
      return [];
    }

    let files: FileRecord[];
    try {
      files = await ctx.runQuery(internal.fileStorage.getFilesByIds, {
        fileIds: args.fileIds,
      });
    } catch (error) {
      convexLogger.error("file_batch_lookup_failed", {
        caller: "service-info",
        fileCount: args.fileIds.length,
        ...getFileLookupErrorFields(error),
      });
      return args.fileIds.map(() => null);
    }

    const urls: Array<ServiceFileUrlInfo | null> = await Promise.all(
      args.fileIds.map(
        async (fileId, index): Promise<ServiceFileUrlInfo | null> => {
          try {
            const file = files[index];

            if (!file || file.user_id !== args.userId) {
              return null;
            }

            if (file.s3_key) {
              return {
                url: await generateFileDownloadUrl(file),
                sizeBytes: file.size,
                mediaType: file.media_type,
                name: file.name,
                auxiliaryVisionDescription: file.auxiliary_vision_description,
                auxiliaryVisionModel: file.auxiliary_vision_model,
              };
            }

            return null;
          } catch (error) {
            convexLogger.error("file_batch_url_info_generation_failed", {
              fileId,
              caller: "service",
              error:
                error instanceof Error
                  ? { message: error.message, name: error.name }
                  : String(error),
            });
            return null;
          }
        },
      ),
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
 * - Generates S3 presigned URLs for accessible files only
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
    if (args.fileIds.length > MAX_SERVICE_FILE_URL_BATCH_SIZE) {
      throw new Error(
        `Batch size exceeds limit: Maximum ${MAX_SERVICE_FILE_URL_BATCH_SIZE} files allowed per request (requested: ${args.fileIds.length})`,
      );
    }
    if (args.fileIds.length === 0) {
      return {};
    }

    const urlMap: Record<string, string> = {};

    let files: FileRecord[];
    try {
      files = await ctx.runQuery(internal.fileStorage.getFilesByIds, {
        fileIds: args.fileIds,
      });
    } catch (error) {
      convexLogger.error("file_batch_lookup_failed", {
        userId: identity.subject,
        caller: "user",
        fileCount: args.fileIds.length,
        ...getFileLookupErrorFields(error),
      });
      return urlMap;
    }

    // Process each file - access control per file
    for (let index = 0; index < args.fileIds.length; index++) {
      const fileId = args.fileIds[index];
      try {
        const file = files[index];

        // Skip if file not found
        if (!file) {
          continue;
        }

        // Skip if user doesn't own this file (access control)
        if (file.user_id !== identity.subject) {
          continue;
        }

        // Skip files that no longer have an S3 object reference.
        if (!file.s3_key) {
          continue;
        }

        const url = await generateFileDownloadUrl(file);
        urlMap[fileId] = url;
      } catch (error) {
        // Log error but continue processing other files (partial failure handling)
        convexLogger.error("file_batch_url_generation_failed", {
          userId: identity.subject,
          fileId,
          caller: "user",
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
        });
        continue;
      }
    }

    return urlMap;
  },
});
