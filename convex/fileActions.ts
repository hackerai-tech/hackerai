"use node";

// Polyfill Promise.try for the Convex Node runtime (not yet available there).
// pdfjs-serverless >=0.7.0 uses Promise.try and crashes without this.
if (typeof (Promise as unknown as { try?: unknown }).try !== "function") {
  (Promise as unknown as { try: unknown }).try = function <T>(
    fn: (...args: unknown[]) => T | PromiseLike<T>,
    ...args: unknown[]
  ): Promise<T> {
    return new Promise<T>((resolve) => resolve(fn(...args)));
  };
}

import { action } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { countTokens } from "gpt-tokenizer";
import { encode, decode } from "gpt-tokenizer";
import { getDocument } from "pdfjs-serverless";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { isBinaryFile } from "isbinaryfile";
import { internal } from "./_generated/api";
import { generateS3DownloadUrl, getS3ObjectSizeBytes } from "./s3Utils";
import { convexLogger } from "./lib/logger";
import type {
  FileItemChunk,
  SupportedFileType,
  ProcessFileOptions,
} from "../types/file";
import { Id } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import {
  getUploadLimitsForMode,
  isSupportedImageMediaType,
  validateUploadPolicy,
} from "../lib/utils/upload-policy";
import { FILE_TOKEN_PERCENT, MAX_TOKENS_PAID } from "../lib/token-utils";
import {
  MAX_GENERATED_FILE_SIZE_BYTES,
  S3_USER_FILES_PREFIX,
} from "../lib/constants/s3";
import {
  hasPaidEntitlement,
  parseEntitlements,
} from "../lib/auth/entitlements";

const FILE_UPLOAD_WINDOW = "5 h";

type FileUploadRateLimitTier = "pro" | "pro-plus" | "team" | "ultra";

type FileUploadRateLimitConfig = {
  tier: FileUploadRateLimitTier;
  limit: number;
  window: typeof FILE_UPLOAD_WINDOW;
};

const isUserScopedS3Key = (s3Key: string, userId: string) =>
  s3Key.startsWith(`${S3_USER_FILES_PREFIX}/${userId}/`);

const FILE_UPLOAD_RATE_LIMITS: Record<
  FileUploadRateLimitTier,
  FileUploadRateLimitConfig
> = {
  pro: { tier: "pro", limit: 400, window: FILE_UPLOAD_WINDOW },
  "pro-plus": { tier: "pro-plus", limit: 800, window: FILE_UPLOAD_WINDOW },
  team: { tier: "team", limit: 800, window: FILE_UPLOAD_WINDOW },
  ultra: { tier: "ultra", limit: 1600, window: FILE_UPLOAD_WINDOW },
};

const FILE_UPLOAD_RATE_LIMIT_ENTITLEMENTS: Record<
  FileUploadRateLimitTier,
  ReadonlySet<string>
> = {
  pro: new Set(["pro-plan", "pro-monthly-plan", "pro-yearly-plan"]),
  "pro-plus": new Set([
    "pro-plus-plan",
    "pro-plus-monthly-plan",
    "pro-plus-yearly-plan",
  ]),
  team: new Set(["team-plan"]),
  ultra: new Set(["ultra-plan", "ultra-monthly-plan", "ultra-yearly-plan"]),
};

const hasEntitlement = (
  entitlements: Array<string>,
  tier: FileUploadRateLimitTier,
) =>
  entitlements.some((entitlement) =>
    FILE_UPLOAD_RATE_LIMIT_ENTITLEMENTS[tier].has(entitlement),
  );

export const getFileUploadRateLimitConfig = (
  entitlements: Array<string> = [],
): FileUploadRateLimitConfig => {
  if (hasEntitlement(entitlements, "ultra")) {
    return FILE_UPLOAD_RATE_LIMITS.ultra;
  }
  if (hasEntitlement(entitlements, "team")) {
    return FILE_UPLOAD_RATE_LIMITS.team;
  }
  if (hasEntitlement(entitlements, "pro-plus")) {
    return FILE_UPLOAD_RATE_LIMITS["pro-plus"];
  }
  return FILE_UPLOAD_RATE_LIMITS.pro;
};

/** Rate limit check result with remaining count */
export type RateLimitResult = {
  remaining: number;
  limit: number;
  reset: number;
  tier: FileUploadRateLimitTier;
};

/**
 * Check cloud file upload rate limit using sliding window algorithm.
 * This protects S3 writes and presigned URL generation; local desktop
 * attachments bypass this path and are governed by per-turn/file-size limits.
 *
 * @param userId - The user's unique identifier
 * @param consume - If true, consumes a token from the bucket. If false, just peeks at the current state.
 * @param options.entitlements - WorkOS entitlements used to choose a paid-tier quota.
 * @returns RateLimitResult with remaining count, or null if Redis is not configured
 * @throws ConvexError if rate limited
 */
export const checkFileUploadRateLimit = async (
  userId: string,
  consume: boolean = true,
  options: { entitlements?: Array<string> } = {},
): Promise<RateLimitResult | null> => {
  // Check if Redis is configured
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    // If Redis is not configured, allow the request (fail-open)
    return null;
  }

  try {
    const config = getFileUploadRateLimitConfig(options.entitlements);
    // Dynamic imports in Convex Node runtime expose modules via .default
    const ratelimitModule = await import("@upstash/ratelimit");
    const Ratelimit = ratelimitModule.default.Ratelimit;

    const { Redis } = await import("@upstash/redis");

    const redis = new Redis({
      url: redisUrl,
      token: redisToken,
    });

    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.limit, config.window),
      prefix: "file_upload_limit",
    });

    const rateLimitKey = `${userId}:${config.tier}:s3_upload`;

    let success: boolean;
    let reset: number;
    let remaining: number;
    let limit: number;

    if (consume) {
      // Consume a token from the rate limit bucket
      ({ success, reset, remaining, limit } =
        await ratelimit.limit(rateLimitKey));
    } else {
      // Peek at the current state without consuming a token
      ({ remaining, limit, reset } =
        await ratelimit.getRemaining(rateLimitKey));
      success = remaining > 0;
    }

    if (!success) {
      // Calculate time remaining
      const now = Date.now();
      const resetMs = reset - now;
      const hours = Math.floor(resetMs / (1000 * 60 * 60));
      const minutes = Math.floor((resetMs % (1000 * 60 * 60)) / (1000 * 60));

      let timeString = "";
      if (hours > 0) {
        timeString = `${hours}h ${minutes}m`;
      } else {
        timeString = `${minutes}m`;
      }

      throw new ConvexError({
        code: "FILE_UPLOAD_RATE_LIMIT",
        message: `You've reached your cloud file upload limit of ${config.limit} files per 5 hours. Desktop Agent attachments from your local workspace do not count toward this limit. Please try again after ${timeString}.`,
      });
    }

    return { remaining, limit, reset, tier: config.tier };
  } catch (error) {
    // Re-throw ConvexError
    if (error instanceof ConvexError) {
      throw error;
    }
    // Log and allow for other errors (fail-open)
    convexLogger.warn("file_upload_rate_limit_check_failed", {
      userId,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
    });
    return null;
  }
};

/**
 * Truncate content to a maximum number of tokens
 * @param content - The content to truncate
 * @param maxTokens - Maximum number of tokens
 * @returns Truncated content
 */
const truncateContentByTokens = (
  content: string,
  maxTokens: number,
): string => {
  const tokens = encode(content);
  if (tokens.length <= maxTokens) return content;

  const truncationSuffix = "\n\n[Content truncated due to token limit]";
  const suffixTokens = countTokens(truncationSuffix);
  const budgetForContent = maxTokens - suffixTokens;

  if (budgetForContent <= 0) {
    return truncationSuffix;
  }

  return decode(tokens.slice(0, budgetForContent)) + truncationSuffix;
};

/**
 * Validate token count and throw error if exceeds limit
 * @param chunks - Array of file chunks
 * @param fileName - Name of the file for error reporting
 * @param skipValidation - Skip token validation (for assistant-generated files)
 */
const validateTokenLimit = (
  chunks: FileItemChunk[],
  fileName: string,
  skipValidation: boolean = false,
  maxTokens: number = Math.floor(MAX_TOKENS_PAID * FILE_TOKEN_PERCENT),
): void => {
  if (skipValidation) {
    return; // Skip validation for assistant-generated files
  }
  const totalTokens = chunks.reduce((total, chunk) => total + chunk.tokens, 0);
  if (totalTokens > maxTokens) {
    throw new ConvexError({
      code: "FILE_TOKEN_LIMIT_EXCEEDED",
      message: `File "${fileName}" exceeds the maximum token limit of ${maxTokens.toLocaleString()} tokens. Current tokens: ${totalTokens.toLocaleString()}. Tip: Switch to Agent mode to upload larger files without token limits.`,
    });
  }
};

/**
 * Unified file processing function that supports all file types
 * @param file - The file as a Blob
 * @param options - Processing options including file type and optional prepend text
 * @returns Promise<FileItemChunk[]> - Array of processed file chunks
 */
const processFile = async (
  file: Blob | string,
  options: ProcessFileOptions,
): Promise<FileItemChunk[]> => {
  const { fileType, prepend = "" } = options;

  try {
    switch (fileType) {
      case "pdf":
        return await processPdfFile(file as Blob);

      case "csv":
        return await processCsvFile(file as Blob);

      case "json":
        return await processJsonFile(file as Blob);

      case "txt":
        return await processTxtFile(file as Blob);

      case "md":
        return await processMarkdownFile(file as Blob, prepend);

      case "docx":
        return await processDocxFile(file as Blob, options.fileName);

      default: {
        // Check if the original file is binary before text conversion
        const blob = file as Blob;
        const fileBuffer = Buffer.from(await blob.arrayBuffer());
        const isBinary = await isBinaryFile(fileBuffer);

        if (isBinary) {
          // For binary files, create a single chunk with empty content and 0 tokens
          return [
            {
              content: "",
              tokens: 0,
            },
          ];
        } else {
          // For non-binary files, convert to text and process as txt
          const textDecoder = new TextDecoder("utf-8");
          const cleanText = textDecoder.decode(fileBuffer);
          return await processTxtFile(new Blob([cleanText]));
        }
      }
    }
  } catch (error) {
    // Throw clean error message without wrapping
    throw error;
  }
};

/**
 * Auto-detect file type based on MIME type or file extension
 * @param file - The file blob
 * @param fileName - Optional file name for extension-based detection
 * @returns SupportedFileType | null
 */
const detectFileType = (
  file: Blob,
  fileName?: string,
): SupportedFileType | null => {
  // Check MIME type first
  const mimeType = file.type;

  if (mimeType) {
    switch (mimeType) {
      case "application/pdf":
        return "pdf";
      case "text/csv":
      case "application/csv":
        return "csv";
      case "application/json":
        return "json";
      case "text/plain":
        return "txt";
      case "text/markdown":
        return "md";
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return "docx";
    }
  }

  // Fallback to file extension if MIME type is not helpful
  if (fileName) {
    const extension = fileName.toLowerCase().split(".").pop();
    switch (extension) {
      case "pdf":
        return "pdf";
      case "csv":
        return "csv";
      case "json":
        return "json";
      case "txt":
        return "txt";
      case "md":
      case "markdown":
        return "md";
      case "docx":
      case "doc":
        return "docx";
    }
  }

  return null;
};

/**
 * Process file with auto-detection of file type and comprehensive fallback handling
 * @param file - The file as a Blob
 * @param fileName - Optional file name for type detection
 * @param mediaType - Optional media type for additional checks
 * @param prepend - Optional prepend text for markdown files
 * @param skipTokenValidation - Skip token validation (for assistant-generated files)
 * @returns Promise<FileItemChunk[]>
 */
const processFileAuto = async (
  file: Blob | string,
  fileName?: string,
  mediaType?: string,
  prepend?: string,
  skipTokenValidation: boolean = false,
  maxTokens: number = Math.floor(MAX_TOKENS_PAID * FILE_TOKEN_PERCENT),
): Promise<FileItemChunk[]> => {
  // Check if file is a supported image format - return 0 tokens immediately
  // Unsupported image formats will be processed as files
  if (mediaType && isSupportedImageMediaType(mediaType)) {
    return [
      {
        content: "",
        tokens: 0,
      },
    ];
  }

  try {
    const detectedType = detectFileType(file as Blob, fileName);
    if (!detectedType) {
      // Use default processing for unknown file types
      const chunks = await processFile(file, {
        fileType: "unknown" as any,
        prepend,
        fileName,
      });
      validateTokenLimit(
        chunks,
        fileName || "unknown",
        skipTokenValidation,
        maxTokens,
      );
      return chunks;
    }
    const fileType = detectedType;

    const chunks = await processFile(file, { fileType, prepend, fileName });
    validateTokenLimit(
      chunks,
      fileName || "unknown",
      skipTokenValidation,
      maxTokens,
    );
    return chunks;
  } catch (error) {
    // Check if this is a ConvexError (including token limit errors) - re-throw as-is
    if (error instanceof ConvexError) {
      throw error;
    }

    // Check if this is a token limit error (legacy Error format) - convert to ConvexError
    if (
      error instanceof Error &&
      error.message.includes("exceeds the maximum token limit")
    ) {
      throw new ConvexError({
        code: "FILE_TOKEN_LIMIT_EXCEEDED",
        message: error.message,
      });
    }

    // If processing fails, try simple text decoding as fallback
    console.warn(`Failed to process file with comprehensive logic: ${error}`);

    // Check if file is a supported image format - return 0 tokens
    // Unsupported image formats will fall through to text processing
    if (mediaType && isSupportedImageMediaType(mediaType)) {
      return [
        {
          content: "",
          tokens: 0,
        },
      ];
    } else if (mediaType && mediaType.startsWith("text/")) {
      try {
        const blob = file as Blob;
        const fileBuffer = Buffer.from(await blob.arrayBuffer());
        const textDecoder = new TextDecoder("utf-8");
        const textContent = textDecoder.decode(fileBuffer);
        const fallbackTokens = countTokens(textContent);

        // Check token limit for fallback processing
        if (!skipTokenValidation && fallbackTokens > maxTokens) {
          throw new ConvexError({
            code: "FILE_TOKEN_LIMIT_EXCEEDED",
            message: `File "${fileName || "unknown"}" exceeds the maximum token limit of ${maxTokens.toLocaleString()} tokens. Current tokens: ${fallbackTokens.toLocaleString()}. Tip: Switch to Agent mode to upload larger files without token limits.`,
          });
        }

        return [
          {
            content: textContent,
            tokens: fallbackTokens,
          },
        ];
      } catch (textError) {
        // Check if this is a ConvexError (including token limit errors) - re-throw as-is
        if (textError instanceof ConvexError) {
          throw textError;
        }

        // Check if this is a token limit error (legacy Error format) - convert to ConvexError
        if (
          textError instanceof Error &&
          textError.message.includes("exceeds the maximum token limit")
        ) {
          throw new ConvexError({
            code: "FILE_TOKEN_LIMIT_EXCEEDED",
            message: textError.message,
          });
        }
        console.warn(`Failed to decode file as text: ${textError}`);
        return [
          {
            content: "",
            tokens: 0,
          },
        ];
      }
    }

    // For other file types that failed processing, return 0 tokens
    return [
      {
        content: "",
        tokens: 0,
      },
    ];
  }
};

// Individual processor functions (internal)
const processPdfFile = async (pdf: Blob): Promise<FileItemChunk[]> => {
  const arrayBuffer = await pdf.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);

  const doc = await getDocument(typedArray).promise;
  const textPages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(" ");
    textPages.push(pageText);
  }

  const completeText = textPages.join(" ");

  return [
    {
      content: completeText,
      tokens: countTokens(completeText),
    },
  ];
};

const processCsvFile = async (csv: Blob): Promise<FileItemChunk[]> => {
  const loader = new CSVLoader(csv);
  const docs = await loader.load();
  const completeText = docs.map((doc) => doc.pageContent).join(" ");

  return [
    {
      content: completeText,
      tokens: countTokens(completeText),
    },
  ];
};

const processJsonFile = async (json: Blob): Promise<FileItemChunk[]> => {
  const fileBuffer = Buffer.from(await json.arrayBuffer());
  const textDecoder = new TextDecoder("utf-8");
  const jsonText = textDecoder.decode(fileBuffer);
  const parsedJson = JSON.parse(jsonText);
  const completeText = JSON.stringify(parsedJson, null, 2);

  return [
    {
      content: completeText,
      tokens: countTokens(completeText),
    },
  ];
};

const processTxtFile = async (txt: Blob): Promise<FileItemChunk[]> => {
  const fileBuffer = Buffer.from(await txt.arrayBuffer());
  const textDecoder = new TextDecoder("utf-8");
  const textContent = textDecoder.decode(fileBuffer);

  return [
    {
      content: textContent,
      tokens: countTokens(textContent),
    },
  ];
};

const processMarkdownFile = async (
  markdown: Blob,
  prepend = "",
): Promise<FileItemChunk[]> => {
  const fileBuffer = Buffer.from(await markdown.arrayBuffer());
  const textDecoder = new TextDecoder("utf-8");
  const textContent = textDecoder.decode(fileBuffer);

  const finalContent =
    prepend + (prepend?.length > 0 ? "\n\n" : "") + textContent;

  return [
    {
      content: finalContent,
      tokens: countTokens(finalContent),
    },
  ];
};

const processDocxFile = async (
  docx: Blob,
  fileName?: string,
): Promise<FileItemChunk[]> => {
  try {
    // Determine file type based on extension
    const extension = fileName?.toLowerCase().split(".").pop();
    const isLegacyDoc = extension === "doc";

    // Convert Blob to Buffer
    const buffer = Buffer.from(await docx.arrayBuffer());

    let completeText = "";

    if (isLegacyDoc) {
      // Use word-extractor for .doc files
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(buffer);
      completeText = extracted.getBody();
    } else {
      // Use mammoth for .docx files
      const result = await mammoth.extractRawText({ buffer });
      completeText = result.value;
    }

    const tokens = countTokens(completeText);

    return [
      {
        content: completeText,
        tokens,
      },
    ];
  } catch (error) {
    // Throw clean, user-friendly error message
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    throw new Error(errorMsg);
  }
};

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
    mode: v.optional(
      v.union(v.literal("ask"), v.literal("agent"), v.literal("agent-long")),
    ),
  },
  returns: v.object({
    url: v.string(),
    fileId: v.id("files"),
    tokens: v.number(),
  }),
  handler: async (ctx, args) => {
    // Storage invariant validation: exactly one of storageId or s3Key must be provided
    if (!args.storageId && !args.s3Key) {
      throw new ConvexError({
        code: "INVALID_STORAGE_ARGS",
        message: "Must provide either storageId or s3Key",
      });
    }
    if (args.storageId && args.s3Key) {
      throw new ConvexError({
        code: "INVALID_STORAGE_ARGS",
        message: "Cannot provide both storageId and s3Key",
      });
    }
    let actingUserId: string;
    let entitlements: Array<string> = [];

    // Service key flow (backend)
    if (args.serviceKey) {
      validateServiceKey(args.serviceKey);
      if (!args.userId) {
        throw new ConvexError({
          code: "MISSING_USER_ID",
          message: "userId is required when using serviceKey",
        });
      }
      actingUserId = args.userId;
      entitlements = ["ultra-plan"]; // Max limit for service flows
    } else {
      // User-authenticated flow
      const user = await ctx.auth.getUserIdentity();
      if (!user) {
        throw new ConvexError({
          code: "UNAUTHORIZED",
          message: "Unauthorized: User not authenticated",
        });
      }
      actingUserId = user.subject;
      entitlements = parseEntitlements(user.entitlements);

      // Security: Only backend (service key) flows can directly set skipTokenValidation
      // Client can use mode="agent" to skip validation
      if (args.skipTokenValidation && !args.mode) {
        throw new ConvexError({
          code: "INVALID_REQUEST",
          message:
            "skipTokenValidation is only allowed for backend service flows",
        });
      }
    }

    // Determine if we should skip token validation based on mode
    // Agent mode: files are accessed in sandbox, no token counting needed
    // Ask mode: files are included in context, token counting required
    const isAgentUploadMode =
      args.mode === "agent" || args.mode === "agent-long";
    const shouldSkipTokenValidation =
      args.skipTokenValidation || isAgentUploadMode;

    // Check if paid tier (free tier cannot upload)
    if (!hasPaidEntitlement(entitlements)) {
      throw new ConvexError({
        code: "PAID_PLAN_REQUIRED",
        message: "Paid plan required for file uploads",
      });
    }

    // Check file upload rate limit (peek mode - verify limit not exceeded)
    // Token was already consumed at URL generation step
    await checkFileUploadRateLimit(actingUserId, false, { entitlements });

    let verifiedSize = args.size;
    if (args.s3Key) {
      try {
        verifiedSize = await getS3ObjectSizeBytes(args.s3Key);
      } catch (error) {
        convexLogger.error("file_upload_s3_metadata_fetch_failed", {
          userId: actingUserId,
          fileName: args.name,
          s3Key: args.s3Key,
          mode: args.mode,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
        });
        throw new ConvexError({
          code: "FILE_NOT_FOUND",
          message: `Failed to upload ${args.name}: File not found in storage`,
        });
      }

      const reservation = await ctx.runQuery(
        internal.fileStorage.getFileByS3Key,
        { s3Key: args.s3Key },
      );
      if (!reservation) {
        if (isUserScopedS3Key(args.s3Key, actingUserId)) {
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectAction,
            { s3Key: args.s3Key },
          );
        }
        throw new ConvexError({
          code: "INVALID_UPLOAD_RESERVATION",
          message: `Failed to upload ${args.name}: Upload reservation not found`,
        });
      }
      if (reservation.user_id !== actingUserId) {
        throw new ConvexError({
          code: "UNAUTHORIZED_UPLOAD_RESERVATION",
          message: `Failed to upload ${args.name}: Upload reservation belongs to another user`,
        });
      }
      if (reservation.size !== verifiedSize) {
        await ctx.scheduler.runAfter(
          0,
          internal.s3Cleanup.deleteS3ObjectAction,
          { s3Key: args.s3Key },
        );
        throw new ConvexError({
          code: "FILE_SIZE_MISMATCH",
          message: `File "${args.name}" uploaded size does not match the reserved upload size`,
        });
      }
    } else if (args.storageId) {
      try {
        const metadata = await ctx.storage.getMetadata(args.storageId);
        if (!metadata) {
          throw new Error("Storage metadata not found");
        }
        verifiedSize = metadata.size;
      } catch (error) {
        convexLogger.error("file_upload_storage_metadata_fetch_failed", {
          userId: actingUserId,
          fileName: args.name,
          storageId: args.storageId,
          mode: args.mode,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : String(error),
        });
        throw new ConvexError({
          code: "FILE_NOT_FOUND",
          message: `Failed to upload ${args.name}: File not found in storage`,
        });
      }
    }

    const uploadLimits = getUploadLimitsForMode(args.mode, {
      surface: "backend",
    });
    const uploadValidation = validateUploadPolicy({
      mode: args.mode,
      size: verifiedSize,
      mediaType: args.mediaType,
      surface: "backend",
    });

    // Ask-mode uploads are processed for model context; Agent uploads may be
    // larger because oversized attachments are staged into the sandbox only.
    if (
      !uploadValidation.valid &&
      uploadValidation.code === "FILE_SIZE_EXCEEDED"
    ) {
      // Clean up storage before throwing error
      try {
        if (args.s3Key) {
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectAction,
            { s3Key: args.s3Key },
          );
        } else if (args.storageId) {
          await ctx.storage.delete(args.storageId);
        }
      } catch (deleteError) {
        convexLogger.warn("file_upload_storage_cleanup_failed", {
          userId: actingUserId,
          fileName: args.name,
          stage: "oversized",
          s3Key: args.s3Key,
          storageId: args.storageId,
          error:
            deleteError instanceof Error
              ? { name: deleteError.name, message: deleteError.message }
              : String(deleteError),
        });
      }
      throw new ConvexError({
        code: "FILE_SIZE_EXCEEDED",
        message: `File "${args.name}" exceeds the maximum file size limit of ${uploadLimits.maxFileSizeBytes / (1024 * 1024)} MB. Current size: ${(verifiedSize / (1024 * 1024)).toFixed(2)} MB`,
      });
    }

    if (
      !uploadValidation.valid &&
      uploadValidation.code === "IMAGE_SIZE_EXCEEDED"
    ) {
      try {
        if (args.s3Key) {
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectAction,
            { s3Key: args.s3Key },
          );
        } else if (args.storageId) {
          await ctx.storage.delete(args.storageId);
        }
      } catch (deleteError) {
        convexLogger.warn("file_upload_storage_cleanup_failed", {
          userId: actingUserId,
          fileName: args.name,
          stage: "oversized_image",
          s3Key: args.s3Key,
          storageId: args.storageId,
          error:
            deleteError instanceof Error
              ? { name: deleteError.name, message: deleteError.message }
              : String(deleteError),
        });
      }
      throw new ConvexError({
        code: "IMAGE_SIZE_EXCEEDED",
        message: `Image "${args.name}" exceeds the maximum image size limit of ${uploadLimits.maxProviderImageSizeBytes / (1024 * 1024)} MB. Current size: ${(verifiedSize / (1024 * 1024)).toFixed(2)} MB`,
      });
    }

    // Get file content from appropriate storage
    let fileUrl: string | null;
    if (args.s3Key) {
      // Fetch from S3
      fileUrl = await generateS3DownloadUrl(args.s3Key);
    } else {
      // Get from Convex storage
      fileUrl = await ctx.storage.getUrl(args.storageId!);
    }

    if (!fileUrl) {
      throw new ConvexError({
        code: "FILE_NOT_FOUND",
        message: `Failed to upload ${args.name}: File not found in storage`,
      });
    }

    // Calculate token size using the comprehensive file processing logic
    let tokenSize = 0;
    let fileContent: string | undefined = undefined;

    try {
      if (isAgentUploadMode) {
        convexLogger.info("agent_file_upload_saved_without_processing", {
          userId: actingUserId,
          fileName: args.name,
          size: verifiedSize,
          mediaType: args.mediaType,
          mode: args.mode,
        });
      } else {
        const response = await fetch(fileUrl);

        if (!response.ok) {
          throw new ConvexError({
            code: "FILE_FETCH_FAILED",
            message: `Failed to upload ${args.name}: ${response.statusText}`,
          });
        }

        const file = await response.blob();

        // Compute file token limit based on subscription (all paid tiers use MAX_TOKENS_PAID)
        const maxFileTokens = Math.floor(MAX_TOKENS_PAID * FILE_TOKEN_PERCENT);

        // Use the comprehensive file processing for all file types (including auto-detection and default handling)
        const chunks = await processFileAuto(
          file,
          args.name,
          args.mediaType,
          undefined,
          shouldSkipTokenValidation,
          maxFileTokens,
        );
        tokenSize = chunks.reduce((total, chunk) => total + chunk.tokens, 0);

        // Save content for non-image, non-PDF, non-binary files
        // Note: Unsupported image formats will have content extracted, so we check for supported images
        const shouldSaveContent =
          !isSupportedImageMediaType(args.mediaType) &&
          args.mediaType !== "application/pdf" &&
          chunks.length > 0 &&
          chunks[0].content.length > 0;

        if (shouldSaveContent) {
          const rawContent = chunks.map((chunk) => chunk.content).join("\n\n");
          // Always truncate content to maxFileTokens before saving to database
          // This ensures database content field stays reasonable even for agent mode files
          fileContent = truncateContentByTokens(rawContent, maxFileTokens);
        }
      }
    } catch (error) {
      // Check if this is a ConvexError (including token limit errors) - re-throw as-is
      if (error instanceof ConvexError) {
        const errorData = error.data as { code?: string; message?: string };
        // Best-effort cleanup: delete storage before re-throwing
        if (errorData?.code === "FILE_TOKEN_LIMIT_EXCEEDED") {
          convexLogger.warn("file_upload_token_limit_exceeded", {
            userId: actingUserId,
            fileName: args.name,
            size: args.size,
            mediaType: args.mediaType,
            mode: args.mode,
            errorCode: errorData.code,
            errorMessage: errorData.message,
          });
        } else {
          convexLogger.error("file_upload_processing_convex_error", {
            userId: actingUserId,
            fileName: args.name,
            size: args.size,
            mediaType: args.mediaType,
            mode: args.mode,
            errorCode: errorData?.code,
            errorMessage: errorData?.message,
          });
        }
        try {
          if (args.s3Key) {
            await ctx.scheduler.runAfter(
              0,
              internal.s3Cleanup.deleteS3ObjectAction,
              { s3Key: args.s3Key },
            );
          } else if (args.storageId) {
            await ctx.storage.delete(args.storageId);
          }
        } catch (cleanupError) {
          convexLogger.warn("file_upload_storage_cleanup_failed", {
            userId: actingUserId,
            fileName: args.name,
            stage: "post_processing_error",
            s3Key: args.s3Key,
            storageId: args.storageId,
            error:
              cleanupError instanceof Error
                ? { name: cleanupError.name, message: cleanupError.message }
                : String(cleanupError),
          });
        }
        throw error; // Re-throw ConvexError as-is
      }

      // Check if this is a token limit error (legacy Error format)
      if (
        error instanceof Error &&
        error.message.includes("exceeds the maximum token limit")
      ) {
        convexLogger.warn("file_upload_token_limit_exceeded", {
          userId: actingUserId,
          fileName: args.name,
          size: args.size,
          mediaType: args.mediaType,
          mode: args.mode,
          errorMessage: error.message,
        });
        // Best-effort cleanup before throwing standardized error
        try {
          if (args.s3Key) {
            await ctx.scheduler.runAfter(
              0,
              internal.s3Cleanup.deleteS3ObjectAction,
              { s3Key: args.s3Key },
            );
          } else if (args.storageId) {
            await ctx.storage.delete(args.storageId);
          }
        } catch (cleanupError) {
          convexLogger.warn("file_upload_storage_cleanup_failed", {
            userId: actingUserId,
            fileName: args.name,
            stage: "post_processing_error",
            s3Key: args.s3Key,
            storageId: args.storageId,
            error:
              cleanupError instanceof Error
                ? { name: cleanupError.name, message: cleanupError.message }
                : String(cleanupError),
          });
        }
        // Convert to ConvexError for consistent error handling
        throw new ConvexError({
          code: "FILE_TOKEN_LIMIT_EXCEEDED",
          message: error.message,
        });
      }

      // For any other unexpected errors, delete storage and wrap with file name
      convexLogger.error("file_upload_processing_unexpected_error", {
        userId: actingUserId,
        fileName: args.name,
        size: args.size,
        mediaType: args.mediaType,
        mode: args.mode,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      // Best-effort cleanup before throwing standardized error
      try {
        if (args.s3Key) {
          await ctx.scheduler.runAfter(
            0,
            internal.s3Cleanup.deleteS3ObjectAction,
            { s3Key: args.s3Key },
          );
        } else if (args.storageId) {
          await ctx.storage.delete(args.storageId);
        }
      } catch (cleanupError) {
        convexLogger.warn("file_upload_storage_cleanup_failed", {
          userId: actingUserId,
          fileName: args.name,
          stage: "post_unexpected_error",
          s3Key: args.s3Key,
          storageId: args.storageId,
          error:
            cleanupError instanceof Error
              ? { name: cleanupError.name, message: cleanupError.message }
              : String(cleanupError),
        });
      }
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      throw new ConvexError({
        code: "FILE_PROCESSING_FAILED",
        message: `Failed to upload ${args.name}: ${errorMsg}`,
      });
    }

    // Use internal mutation to save to database
    const fileId = (await ctx.runMutation(internal.fileStorage.saveFileToDb, {
      storageId: args.storageId,
      s3Key: args.s3Key,
      userId: actingUserId,
      name: args.name,
      mediaType: args.mediaType,
      size: verifiedSize,
      fileTokenSize: tokenSize,
      content: fileContent,
    })) as Id<"files">;

    // Return the file URL, database file ID, and token count
    return {
      url: fileUrl,
      fileId,
      tokens: tokenSize,
    };
  },
});

/**
 * Save metadata for an assistant-generated sandbox artifact.
 *
 * These files are download-only artifacts produced by tools like
 * get_terminal_files, not prompt attachments. Avoid fetching or parsing the
 * object here so large generated archives do not consume Convex memory.
 */
export const saveSandboxGeneratedFile = action({
  args: {
    s3Key: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.object({
    url: v.string(),
    fileId: v.id("files"),
    tokens: v.number(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    await checkFileUploadRateLimit(args.userId, false);

    const cleanupUploadedObject = async (stage: string) => {
      try {
        await ctx.scheduler.runAfter(
          0,
          internal.s3Cleanup.deleteS3ObjectAction,
          {
            s3Key: args.s3Key,
          },
        );
      } catch (deleteError) {
        convexLogger.warn("file_upload_storage_cleanup_failed", {
          userId: args.userId,
          fileName: args.name,
          stage,
          s3Key: args.s3Key,
          error:
            deleteError instanceof Error
              ? { name: deleteError.name, message: deleteError.message }
              : String(deleteError),
        });
      }
    };

    if (args.size > MAX_GENERATED_FILE_SIZE_BYTES) {
      convexLogger.warn("sandbox_generated_file_too_large", {
        event: "sandbox_generated_file_too_large",
        service: "convex-file-actions",
        user_id: args.userId,
        file_name: args.name,
        media_type: args.mediaType,
        size_bytes: args.size,
        limit_bytes: MAX_GENERATED_FILE_SIZE_BYTES,
      });
      await cleanupUploadedObject("oversized_generated_artifact");
      throw new ConvexError({
        code: "GENERATED_FILE_SIZE_EXCEEDED",
        message: `File "${args.name}" exceeds the maximum generated file size limit of ${MAX_GENERATED_FILE_SIZE_BYTES / (1024 * 1024)} MB. Current size: ${(args.size / (1024 * 1024)).toFixed(2)} MB`,
      });
    }

    try {
      const fileUrl = await generateS3DownloadUrl(args.s3Key);
      const fileId = (await ctx.runMutation(internal.fileStorage.saveFileToDb, {
        s3Key: args.s3Key,
        userId: args.userId,
        name: args.name,
        mediaType: args.mediaType,
        size: args.size,
        fileTokenSize: 0,
        trustedServiceGenerated: true,
      })) as Id<"files">;

      return {
        url: fileUrl,
        fileId,
        tokens: 0,
      };
    } catch (error) {
      convexLogger.error("sandbox_generated_file_metadata_save_failed", {
        event: "sandbox_generated_file_metadata_save_failed",
        service: "convex-file-actions",
        user_id: args.userId,
        file_name: args.name,
        media_type: args.mediaType,
        size_bytes: args.size,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
      });
      await cleanupUploadedObject("generated_artifact_save_failed");

      if (error instanceof ConvexError) {
        throw error;
      }
      throw new ConvexError({
        code: "GENERATED_FILE_SAVE_FAILED",
        message: `Failed to save generated file ${args.name}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      });
    }
  },
});
