"use node";

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
import { generateS3DownloadUrl } from "./s3Utils";
import type {
  FileItemChunk,
  SupportedFileType,
  ProcessFileOptions,
} from "../types/file";
import { Id } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { isSupportedImageMediaType } from "../lib/utils/file-utils";
import { MAX_TOKENS_FILE } from "../lib/token-utils";

// Maximum file size: 20 MB (enforced regardless of skipTokenValidation)
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

// File upload rate limit: 80 files per 5 hours for paid tiers
const FILE_UPLOAD_LIMIT = 80;
const FILE_UPLOAD_WINDOW = "5 h";

/** Rate limit check result with remaining count */
export type RateLimitResult = {
  remaining: number;
  limit: number;
  reset: number;
};

/**
 * Check file upload rate limit using sliding window algorithm.
 * Allows 80 file uploads per 5 hours for paid tiers.
 *
 * @param userId - The user's unique identifier
 * @param consume - If true, consumes a token from the bucket. If false, just peeks at the current state.
 * @returns RateLimitResult with remaining count, or null if Redis is not configured
 * @throws ConvexError if rate limited
 */
export const checkFileUploadRateLimit = async (
  userId: string,
  consume: boolean = true,
): Promise<RateLimitResult | null> => {
  // Check if Redis is configured
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    // If Redis is not configured, allow the request (fail-open)
    return null;
  }

  try {
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
      limiter: Ratelimit.slidingWindow(FILE_UPLOAD_LIMIT, FILE_UPLOAD_WINDOW),
      prefix: "file_upload_limit",
    });

    const rateLimitKey = `${userId}:file_upload`;

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
        message: `You've reached your file upload limit of ${FILE_UPLOAD_LIMIT} files per 5 hours. Please try again after ${timeString}.`,
      });
    }

    return { remaining, limit, reset };
  } catch (error) {
    // Re-throw ConvexError
    if (error instanceof ConvexError) {
      throw error;
    }
    // Log and allow for other errors (fail-open)
    console.warn("File upload rate limit check failed:", error);
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
): void => {
  if (skipValidation) {
    return; // Skip validation for assistant-generated files
  }
  const totalTokens = chunks.reduce((total, chunk) => total + chunk.tokens, 0);
  if (totalTokens > MAX_TOKENS_FILE) {
    throw new ConvexError({
      code: "FILE_TOKEN_LIMIT_EXCEEDED",
      message: `File "${fileName}" exceeds the maximum token limit of ${MAX_TOKENS_FILE.toLocaleString()} tokens. Current tokens: ${totalTokens.toLocaleString()}. Tip: Switch to Agent mode to upload larger files without token limits.`,
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
      validateTokenLimit(chunks, fileName || "unknown", skipTokenValidation);
      return chunks;
    }
    const fileType = detectedType;

    const chunks = await processFile(file, { fileType, prepend, fileName });
    validateTokenLimit(chunks, fileName || "unknown", skipTokenValidation);
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
        if (!skipTokenValidation && fallbackTokens > MAX_TOKENS_FILE) {
          throw new ConvexError({
            code: "FILE_TOKEN_LIMIT_EXCEEDED",
            message: `File "${fileName || "unknown"}" exceeds the maximum token limit of ${MAX_TOKENS_FILE.toLocaleString()} tokens. Current tokens: ${fallbackTokens.toLocaleString()}. Tip: Switch to Agent mode to upload larger files without token limits.`,
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
      entitlements = Array.isArray(user.entitlements)
        ? user.entitlements.filter(
            (e: unknown): e is string => typeof e === "string",
          )
        : [];

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
    const shouldSkipTokenValidation =
      args.skipTokenValidation ||
      args.mode === "agent" ||
      args.mode === "agent-long";

    // Check if paid tier (free tier cannot upload)
    const hasPaidEntitlement =
      entitlements.includes("ultra-plan") ||
      entitlements.includes("ultra-monthly-plan") ||
      entitlements.includes("ultra-yearly-plan") ||
      entitlements.includes("pro-plus-plan") ||
      entitlements.includes("pro-plus-monthly-plan") ||
      entitlements.includes("pro-plus-yearly-plan") ||
      entitlements.includes("team-plan") ||
      entitlements.includes("pro-plan") ||
      entitlements.includes("pro-monthly-plan") ||
      entitlements.includes("pro-yearly-plan");

    if (!hasPaidEntitlement) {
      throw new ConvexError({
        code: "PAID_PLAN_REQUIRED",
        message: "Paid plan required for file uploads",
      });
    }

    // Check file upload rate limit (peek mode - verify limit not exceeded)
    // Token was already consumed at URL generation step
    await checkFileUploadRateLimit(actingUserId, false);

    // Enforce file size limit (20 MB) regardless of skipTokenValidation
    if (args.size > MAX_FILE_SIZE_BYTES) {
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
        console.warn(
          `Failed to delete storage for oversized file "${args.name}":`,
          deleteError,
        );
      }
      throw new ConvexError({
        code: "FILE_SIZE_EXCEEDED",
        message: `File "${args.name}" exceeds the maximum file size limit of 20 MB. Current size: ${(args.size / (1024 * 1024)).toFixed(2)} MB`,
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

    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new ConvexError({
        code: "FILE_FETCH_FAILED",
        message: `Failed to upload ${args.name}: ${response.statusText}`,
      });
    }

    const file = await response.blob();

    // Calculate token size using the comprehensive file processing logic
    let tokenSize = 0;
    let fileContent: string | undefined = undefined;

    try {
      // Use the comprehensive file processing for all file types (including auto-detection and default handling)
      const chunks = await processFileAuto(
        file,
        args.name,
        args.mediaType,
        undefined,
        shouldSkipTokenValidation,
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
        // Always truncate content to MAX_TOKENS_FILE before saving to database
        // This ensures database content field stays reasonable even for agent mode files
        fileContent = truncateContentByTokens(rawContent, MAX_TOKENS_FILE);
      }
    } catch (error) {
      // Check if this is a ConvexError (including token limit errors) - re-throw as-is
      if (error instanceof ConvexError) {
        // Best-effort cleanup: delete storage before re-throwing
        console.error(
          `Error processing file "${args.name}". Deleting storage object.`,
        );
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
          console.warn(
            `Failed to cleanup storage for file "${args.name}":`,
            cleanupError,
          );
        }
        throw error; // Re-throw ConvexError as-is
      }

      // Check if this is a token limit error (legacy Error format)
      if (
        error instanceof Error &&
        error.message.includes("exceeds the maximum token limit")
      ) {
        console.error(
          `Token limit exceeded for file "${args.name}". Deleting storage object.`,
        );
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
          console.warn(
            `Failed to cleanup storage for file "${args.name}":`,
            cleanupError,
          );
        }
        // Convert to ConvexError for consistent error handling
        throw new ConvexError({
          code: "FILE_TOKEN_LIMIT_EXCEEDED",
          message: error.message,
        });
      }

      // For any other unexpected errors, delete storage and wrap with file name
      console.error(
        `Unexpected error processing file "${args.name}". Deleting storage object.`,
      );
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
        console.warn(
          `Failed to cleanup storage for file "${args.name}":`,
          cleanupError,
        );
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
      size: args.size,
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
