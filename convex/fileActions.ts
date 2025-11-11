"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { validateServiceKey } from "./chats";
import { isSupportedImageMediaType } from "../lib/utils/file-utils";
import {
  generateS3Key,
  generateS3UploadUrl,
  generateS3DownloadUrls,
  getS3FileContent,
} from "./s3Utils";
import { processFileAuto } from "./fileProcessing";
import { validateFile, getFileTypeName } from "./fileValidation";
import { MAX_FILE_SIZE_BYTES } from "../lib/constants/s3";

/**
 * Save file metadata to database after processing the file content
 * This is an action because it uses Node.js APIs like Buffer
 */
export const saveFile = action({
  args: {
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    serviceKey: v.optional(v.string()),
    userId: v.optional(v.string()),
    skipTokenValidation: v.optional(v.boolean()),
  },
  returns: v.object({
    url: v.string(),
    fileId: v.id("files"),
    tokens: v.number(),
  }),
  handler: async (ctx, args) => {
    console.log(`[FileActions] saveFile called - name: ${args.name}, size: ${args.size}, mediaType: ${args.mediaType}`);
    console.log(`[FileActions] Storage method: ${args.s3Key ? `S3 (key: ${args.s3Key})` : `Convex (id: ${args.storageId})`}`);
    console.log(`[FileActions] skipTokenValidation: ${args.skipTokenValidation ?? false}`);

    // =========================================================================
    // STEP 1: Normalize and validate file metadata
    // =========================================================================
    // Normalize empty MIME types to application/octet-stream
    // This happens when browsers don't recognize file types (e.g., .md, .log, etc.)
    const normalizedMediaType = args.mediaType.trim().length === 0
      ? "application/octet-stream"
      : args.mediaType;

    console.log(`[FileActions] Normalized mediaType: ${normalizedMediaType}`);

    const validation = validateFile(args.name, normalizedMediaType, args.size);
    if (!validation.isValid) {
      console.error(`[FileActions] Validation failed: ${validation.error}`);

      // Clean up storage before throwing error
      if (args.storageId) {
        try {
          console.log(`[FileActions] Cleaning up Convex storage: ${args.storageId}`);
          await ctx.storage.delete(args.storageId);
        } catch (e) {
          console.warn("Failed to delete storage after validation error:", e);
        }
      }
      if (args.s3Key) {
        try {
          console.log(`[FileActions] Cleaning up S3 object: ${args.s3Key}`);
          await ctx.runAction(internal.s3Cleanup.deleteS3Object, {
            s3Key: args.s3Key,
          });
        } catch (e) {
          console.warn("Failed to delete S3 object after validation error:", e);
        }
      }
      throw new Error(validation.error);
    }

    console.log(`[FileActions] File validation passed`);

    // =========================================================================
    // STEP 2: Authentication & Authorization
    // =========================================================================
    let actingUserId: string;
    let entitlements: Array<string> = [];

    // Service key flow (backend)
    if (args.serviceKey) {
      console.log(`[FileActions] Using service key authentication`);
      validateServiceKey(args.serviceKey);
      if (!args.userId) {
        throw new Error("Invalid request: userId is required when using serviceKey");
      }
      actingUserId = args.userId;
      entitlements = ["ultra-plan"]; // Max limit for service flows
    } else {
      console.log(`[FileActions] Using user authentication`);
      // User-authenticated flow
      const user = await ctx.auth.getUserIdentity();
      if (!user) {
        console.error(`[FileActions] User not authenticated`);
        throw new Error("Unauthorized: User not authenticated");
      }
      actingUserId = user.subject;
      entitlements = Array.isArray(user.entitlements)
        ? user.entitlements.filter(
            (e: unknown): e is string => typeof e === "string",
          )
        : [];

      // Security: Only backend (service key) flows can skip token validation
      if (args.skipTokenValidation) {
        console.error(`[FileActions] skipTokenValidation not allowed for user flows`);
        throw new Error(
          "skipTokenValidation is only allowed for backend service flows",
        );
      }
    }

    console.log(`[FileActions] Acting user: ${actingUserId}, Entitlements: ${entitlements.join(", ")}`);

    // Check file limit (Pro: 300, Team: 500, Ultra: 1000, Free: 0)
    let fileLimit = 0;
    if (
      entitlements.includes("ultra-plan") ||
      entitlements.includes("ultra-monthly-plan") ||
      entitlements.includes("ultra-yearly-plan")
    ) {
      fileLimit = 1000;
    } else if (entitlements.includes("team-plan")) {
      fileLimit = 500;
    } else if (
      entitlements.includes("pro-plan") ||
      entitlements.includes("pro-monthly-plan") ||
      entitlements.includes("pro-yearly-plan")
    ) {
      fileLimit = 300;
    }

    console.log(`[FileActions] User file limit: ${fileLimit}`);

    if (fileLimit === 0) {
      console.error(`[FileActions] No paid plan - upload rejected`);
      throw new Error("Unauthorized: Paid plan required for file uploads");
    }

    const currentFileCount = await ctx.runQuery(
      internal.fileStorage.countUserFiles,
      { userId: actingUserId },
    );

    console.log(`[FileActions] Current file count: ${currentFileCount}/${fileLimit}`);

    if (currentFileCount >= fileLimit) {
      console.error(`[FileActions] File limit exceeded: ${currentFileCount}/${fileLimit}`);
      throw new Error(
        `Limit exceeded: Maximum ${fileLimit} files allowed for your plan`,
      );
    }

    // Enforce file size limit (20 MB) regardless of skipTokenValidation
    if (args.size > MAX_FILE_SIZE_BYTES) {
      // Clean up storage before throwing error
      if (args.storageId) {
        try {
          await ctx.storage.delete(args.storageId);
        } catch (deleteError) {
          console.warn(
            `Failed to delete storage for oversized file "${args.name}":`,
            deleteError,
          );
        }
      }
      if (args.s3Key) {
        try {
          await ctx.runAction(internal.s3Cleanup.deleteS3Object, {
            s3Key: args.s3Key,
          });
        } catch (deleteError) {
          console.warn(
            `Failed to delete S3 object for oversized file "${args.name}":`,
            deleteError,
          );
        }
      }
      throw new Error(
        `File "${args.name}" exceeds the maximum file size limit of 20 MB. Current size: ${(args.size / (1024 * 1024)).toFixed(2)} MB`,
      );
    }

    // =========================================================================
    // STEP 4: Fetch file content and verify signature
    // =========================================================================
    console.log(`[FileActions] Fetching file content...`);
    let fileUrl: string;
    let file: Blob;
    let buffer: Buffer | null = null;

    // Handle both S3 and legacy Convex storage
    if (args.s3Key) {
      console.log(`[FileActions] Using S3 storage - key: ${args.s3Key}`);
      // S3 storage: fetch file from S3 using Convex-compatible utils
      const { generateS3DownloadUrl } = await import("./s3Utils");
      fileUrl = await generateS3DownloadUrl(args.s3Key);
      console.log(`[FileActions] Generated download URL for ${args.s3Key}`);

      buffer = await getS3FileContent(args.s3Key);
      console.log(`[FileActions] Fetched file content from S3 - size: ${buffer.length} bytes`);

      // Verify file signature matches declared MIME type (first 8KB is sufficient)
      const { verifyFileSignature } = await import("./fileValidation");
      const signatureBuffer = buffer.slice(0, 8192); // First 8KB for signature check
      console.log(`[FileActions] Verifying file signature for ${args.mediaType}...`);

      if (!verifyFileSignature(signatureBuffer, args.mediaType)) {
        console.error(`[FileActions] File signature verification failed for ${args.name}`);
        // Clean up S3 file before throwing error
        try {
          await ctx.runAction(internal.s3Cleanup.deleteS3Object, {
            s3Key: args.s3Key,
          });
        } catch (e) {
          console.warn("Failed to delete S3 object after signature check:", e);
        }
        throw new Error(
          `File "${args.name}" content does not match declared type "${getFileTypeName(args.mediaType)}". ` +
            `Possible file type spoofing detected. Please ensure the file is a valid ${getFileTypeName(args.mediaType)}.`,
        );
      }

      console.log(`[FileActions] File signature verified successfully`);

      // Create a standalone ArrayBuffer copy to satisfy BlobPart typing
      const copy = new Uint8Array(buffer.byteLength);
      copy.set(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      );
      const ab = copy.buffer as ArrayBuffer;
      file = new Blob([ab], { type: args.mediaType });
    } else if (args.storageId) {
      console.log(`[FileActions] Using Convex storage - id: ${args.storageId}`);
      // Legacy Convex storage
      const convexUrl = await ctx.storage.getUrl(args.storageId);
      if (!convexUrl) {
        console.error(`[FileActions] File not found in Convex storage`);
        throw new Error(
          `Failed to upload ${args.name}: File not found in storage`,
        );
      }
      fileUrl = convexUrl;
      const response = await fetch(convexUrl);
      if (!response.ok) {
        console.error(`[FileActions] Failed to fetch from Convex storage: ${response.statusText}`);
        throw new Error(
          `Failed to upload ${args.name}: ${response.statusText}`,
        );
      }
      file = await response.blob();
      console.log(`[FileActions] Fetched file from Convex storage - size: ${file.size} bytes`);
    } else {
      console.error(`[FileActions] No storage method provided`);
      throw new Error("Invalid request: Either storageId or s3Key must be provided");
    }

    // Calculate token size using the comprehensive file processing logic
    console.log(`[FileActions] Processing file to calculate tokens...`);
    let tokenSize = 0;
    let fileContent: string | undefined = undefined;

    try {
      // Use the comprehensive file processing for all file types (including auto-detection and default handling)
      const chunks = await processFileAuto(
        file,
        args.name,
        args.mediaType,
        undefined,
        args.skipTokenValidation ?? false,
      );
      tokenSize = chunks.reduce((total, chunk) => total + chunk.tokens, 0);
      console.log(`[FileActions] File processed - tokens: ${tokenSize}, chunks: ${chunks.length}`);

      // Save content for non-image, non-PDF, non-binary files
      // Note: Unsupported image formats will have content extracted, so we check for supported images
      const shouldSaveContent =
        !isSupportedImageMediaType(args.mediaType) &&
        args.mediaType !== "application/pdf" &&
        chunks.length > 0 &&
        chunks[0].content.length > 0;

      if (shouldSaveContent) {
        fileContent = chunks.map((chunk) => chunk.content).join("\n\n");
      }
    } catch (error) {
      // Check if this is a token limit error - if so, delete storage and re-throw
      if (
        error instanceof Error &&
        error.message.includes("exceeds the maximum token limit")
      ) {
        console.error(
          `Token limit exceeded for file "${args.name}". Deleting storage object.`,
        );
        if (args.storageId) {
          await ctx.storage.delete(args.storageId);
        }
        if (args.s3Key) {
          try {
            await ctx.runAction(internal.s3Cleanup.deleteS3Object, {
              s3Key: args.s3Key,
            });
          } catch (deleteError) {
            console.warn(
              `Failed to delete S3 object after token limit for "${args.name}":`,
              deleteError,
            );
          }
        }
        throw error; // Re-throw the token limit error (already includes file name)
      }

      // For any other unexpected errors, delete storage and wrap with file name
      console.error(
        `Unexpected error processing file "${args.name}". Deleting storage object.`,
      );
      if (args.storageId) {
        await ctx.storage.delete(args.storageId);
      }
      if (args.s3Key) {
        try {
          await ctx.runAction(internal.s3Cleanup.deleteS3Object, {
            s3Key: args.s3Key,
          });
        } catch (deleteError) {
          console.warn(
            `Failed to delete S3 object after unexpected error for "${args.name}":`,
            deleteError,
          );
        }
      }
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to upload ${args.name}: ${errorMsg}`);
    }

    // Use internal mutation to save to database
    console.log(`[FileActions] Saving file to database...`);
    console.log(`[FileActions] File metadata - userId: ${actingUserId}, tokens: ${tokenSize}, hasContent: ${!!fileContent}`);

    const fileId = (await ctx.runMutation(internal.fileStorage.saveFileToDb, {
      storageId: args.storageId,
      s3Key: args.s3Key,
      userId: actingUserId,
      name: args.name,
      mediaType: args.mediaType,
      size: args.size,
      fileTokenSize: tokenSize,
      content: fileContent,
    })) as Id<"files">;

    console.log(`[FileActions] File saved successfully - fileId: ${fileId}`);
    console.log(`[FileActions] Returning file URL: ${fileUrl.substring(0, 100)}...`);

    // Return the file URL, database file ID, and token count
    return {
      url: fileUrl,
      fileId,
      tokens: tokenSize,
    };
  },
});
/**
 * Generate S3 presigned upload URL via Convex (replaces Next.js API route)
 */
export const generateS3UploadUrlAction = action({
  args: {
    fileName: v.string(),
    contentType: v.string(),
  },
  returns: v.object({ uploadUrl: v.string(), s3Key: v.string() }),
  handler: async (ctx, args) => {
    console.log(`[FileActions] generateS3UploadUrlAction called - fileName: ${args.fileName}, contentType: ${args.contentType}`);

    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      console.error(`[FileActions] Unauthorized: User not authenticated`);
      throw new Error("Unauthorized: User not authenticated");
    }

    console.log(`[FileActions] User authenticated - userId: ${user.subject}`);

    // Entitlements from session
    const entitlements: Array<string> = Array.isArray(user.entitlements)
      ? (user.entitlements.filter(
          (e: unknown): e is string => typeof e === "string",
        ) as Array<string>)
      : [];

    console.log(`[FileActions] User entitlements: ${entitlements.join(", ")}`);

    // File limit (mirror logic in fileStorage)
    let fileLimit = 0;
    if (
      entitlements.includes("ultra-plan") ||
      entitlements.includes("ultra-monthly-plan") ||
      entitlements.includes("ultra-yearly-plan")
    ) {
      fileLimit = 1000;
    } else if (entitlements.includes("team-plan")) {
      fileLimit = 500;
    } else if (
      entitlements.includes("pro-plan") ||
      entitlements.includes("pro-monthly-plan") ||
      entitlements.includes("pro-yearly-plan")
    ) {
      fileLimit = 300;
    }

    console.log(`[FileActions] User file limit: ${fileLimit}`);

    if (fileLimit === 0) {
      console.error(`[FileActions] Upload rejected: No paid plan`);
      throw new Error("Unauthorized: Paid plan required for file uploads");
    }

    // Current file count via public query
    const current = await ctx.runQuery(internal.fileStorage.countUserFiles, {
      userId: user.subject,
    });
    console.log(`[FileActions] Current file count: ${current}/${fileLimit}`);

    if (current >= fileLimit) {
      console.error(`[FileActions] Upload limit exceeded: ${current}/${fileLimit}`);
      throw new Error(
        `Limit exceeded: Maximum ${fileLimit} files allowed for your plan`,
      );
    }

    // Generate key + presigned URL
    const s3Key = generateS3Key(user.subject, args.fileName);
    const uploadUrl = await generateS3UploadUrl(s3Key, args.contentType);

    console.log(`[FileActions] Successfully generated upload URL - s3Key: ${s3Key}`);
    console.log(`[FileActions] Upload URL preview: ${uploadUrl.substring(0, 100)}...`);

    return { uploadUrl, s3Key };
  },
});

/**
 * Generate S3 presigned download URLs for multiple files in one call
 */
export const generateS3DownloadUrlsAction = action({
  args: {
    fileIds: v.array(v.id("files")),
  },
  returns: v.array(
    v.object({
      fileId: v.id("files"),
      url: v.string(),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ fileId: Id<"files">; url: string }>> => {
    console.log(`[FileActions] generateS3DownloadUrlsAction called - fileIds: [${args.fileIds.join(", ")}]`);
    console.log(`[FileActions] Generating download URLs for ${args.fileIds.length} files`);

    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      console.error(`[FileActions] Unauthorized: User not authenticated`);
      throw new Error("Unauthorized: User not authenticated");
    }

    console.log(`[FileActions] User authenticated - userId: ${user.subject}`);

    // Load files and validate ownership + S3 storage
    type FileRecord = {
      _id: Id<"files">;
      _creationTime: number;
      storage_id?: Id<"_storage"> | undefined;
      s3_key?: string | undefined;
      user_id: string;
      name: string;
      media_type: string;
      size: number;
      file_token_size: number;
      content?: string | undefined;
      is_attached: boolean;
    } | null;

    console.log(`[FileActions] Loading file records from database...`);
    const files: Array<FileRecord> = await Promise.all(
      args.fileIds.map(
        (fileId) =>
          ctx.runQuery(api.fileStorage.getFile, {
            fileId,
          }) as Promise<FileRecord>,
      ),
    );

    console.log(`[FileActions] Loaded ${files.length} file records`);
    console.log(`[FileActions] Validating file ownership and S3 storage...`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) {
        console.error(`[FileActions] File not found - fileId: ${args.fileIds[i]}`);
        throw new Error("File not found or access denied");
      }
      if (file.user_id !== user.subject) {
        console.error(`[FileActions] Unauthorized access attempt - fileId: ${args.fileIds[i]}, file owner: ${file.user_id}, requesting user: ${user.subject}`);
        throw new Error("Unauthorized: File does not belong to user");
      }
      if (!file.s3_key) {
        console.error(`[FileActions] File not in S3 - fileId: ${args.fileIds[i]}`);
        throw new Error("Invalid request: File is not stored in S3");
      }
    }

    console.log(`[FileActions] All files validated successfully`);

    const s3Keys: Array<string> = files.map((f) => (f as any).s3_key as string);
    console.log(`[FileActions] S3 keys to fetch: [${s3Keys.join(", ")}]`);

    try {
      console.log(`[FileActions] Calling generateS3DownloadUrls...`);
      const keyToUrl = await generateS3DownloadUrls(s3Keys);

      console.log(`[FileActions] Successfully generated ${Object.keys(keyToUrl).length} download URLs`);

      const result = args.fileIds.map((fileId, idx) => ({
        fileId,
        url: keyToUrl[s3Keys[idx]],
      }));

      console.log(`[FileActions] Returning ${result.length} file URLs to client`);

      return result;
    } catch (error) {
      console.error("[FileActions] Failed to generate S3 download URLs:", error);
      console.error("[FileActions] S3 Keys:", s3Keys);
      throw new Error(
        `Failed to generate presigned URLs: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
});
