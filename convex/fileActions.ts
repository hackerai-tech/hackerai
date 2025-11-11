"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { countTokens } from "gpt-tokenizer";
import { getDocument } from "pdfjs-serverless";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { isBinaryFile } from "isbinaryfile";
import { api, internal } from "./_generated/api";
import type {
  FileItemChunk,
  SupportedFileType,
  ProcessFileOptions,
} from "../types/file";
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
import { MAX_TOKENS_FILE } from "../lib/token-utils";

// Maximum file size: 20 MB (enforced regardless of skipTokenValidation)
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

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
    throw new Error(
      `File "${fileName}" exceeds the maximum token limit of ${MAX_TOKENS_FILE} tokens. Current tokens: ${totalTokens}`,
    );
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

  // Parse and stringify to ensure valid JSON and format consistently
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
  },
  returns: v.object({
    url: v.string(),
    fileId: v.id("files"),
    tokens: v.number(),
  }),
  handler: async (ctx, args) => {
    // =========================================================================
    // STEP 1: Normalize and validate file metadata
    // =========================================================================
    // Normalize empty MIME types to application/octet-stream
    // This happens when browsers don't recognize file types (e.g., .md, .log, etc.)
    const normalizedMediaType = args.mediaType.trim().length === 0
      ? "application/octet-stream"
      : args.mediaType;

    const validation = validateFile(args.name, normalizedMediaType, args.size);
    if (!validation.isValid) {
      // Clean up storage before throwing error
      if (args.storageId) {
        try {
          await ctx.storage.delete(args.storageId);
        } catch (e) {
          console.warn("Failed to delete storage after validation error:", e);
        }
      }
      if (args.s3Key) {
        try {
          await ctx.runAction(internal.s3Cleanup.deleteS3Object, {
            s3Key: args.s3Key,
          });
        } catch (e) {
          console.warn("Failed to delete S3 object after validation error:", e);
        }
      }
      throw new Error(validation.error);
    }

    // =========================================================================
    // STEP 2: Authentication & Authorization
    // =========================================================================
    let actingUserId: string;
    let entitlements: Array<string> = [];

    // Service key flow (backend)
    if (args.serviceKey) {
      validateServiceKey(args.serviceKey);
      if (!args.userId) {
        throw new Error("userId is required when using serviceKey");
      }
      actingUserId = args.userId;
      entitlements = ["ultra-plan"]; // Max limit for service flows
    } else {
      // User-authenticated flow
      const user = await ctx.auth.getUserIdentity();
      if (!user) {
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
        throw new Error(
          "skipTokenValidation is only allowed for backend service flows",
        );
      }
    }

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

    if (fileLimit === 0) {
      throw new Error("Paid plan required for file uploads");
    }

    const currentFileCount = await ctx.runQuery(
      internal.fileStorage.countUserFiles,
      { userId: actingUserId },
    );

    if (currentFileCount >= fileLimit) {
      throw new Error(
        `Upload limit exceeded: Maximum ${fileLimit} files allowed for your plan`,
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
    let fileUrl: string;
    let file: Blob;
    let buffer: Buffer | null = null;

    // Handle both S3 and legacy Convex storage
    if (args.s3Key) {
      // S3 storage: fetch file from S3 using Convex-compatible utils
      const { generateS3DownloadUrl } = await import("./s3Utils");
      fileUrl = await generateS3DownloadUrl(args.s3Key);
      buffer = await getS3FileContent(args.s3Key);

      // Verify file signature matches declared MIME type (first 8KB is sufficient)
      const { verifyFileSignature } = await import("./fileValidation");
      const signatureBuffer = buffer.slice(0, 8192); // First 8KB for signature check
      if (!verifyFileSignature(signatureBuffer, args.mediaType)) {
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

      // Create a standalone ArrayBuffer copy to satisfy BlobPart typing
      const copy = new Uint8Array(buffer.byteLength);
      copy.set(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      );
      const ab = copy.buffer as ArrayBuffer;
      file = new Blob([ab], { type: args.mediaType });
    } else if (args.storageId) {
      // Legacy Convex storage
      const convexUrl = await ctx.storage.getUrl(args.storageId);
      if (!convexUrl) {
        throw new Error(
          `Failed to upload ${args.name}: File not found in storage`,
        );
      }
      fileUrl = convexUrl;
      const response = await fetch(convexUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to upload ${args.name}: ${response.statusText}`,
        );
      }
      file = await response.blob();
    } else {
      throw new Error("Either storageId or s3Key must be provided");
    }

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
        args.skipTokenValidation ?? false,
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
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    // Entitlements from session
    const entitlements: Array<string> = Array.isArray(user.entitlements)
      ? (user.entitlements.filter(
          (e: unknown): e is string => typeof e === "string",
        ) as Array<string>)
      : [];

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

    if (fileLimit === 0) {
      throw new Error("Paid plan required for file uploads");
    }

    // Current file count via public query
    const current = await ctx.runQuery(internal.fileStorage.countUserFiles, {
      userId: user.subject,
    });
    if (current >= fileLimit) {
      throw new Error(
        `Upload limit exceeded: Maximum ${fileLimit} files allowed for your plan`,
      );
    }

    // Generate key + presigned URL
    const s3Key = generateS3Key(user.subject, args.fileName);
    const uploadUrl = await generateS3UploadUrl(s3Key, args.contentType);
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
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

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

    const files: Array<FileRecord> = await Promise.all(
      args.fileIds.map(
        (fileId) =>
          ctx.runQuery(api.fileStorage.getFile, {
            fileId,
          }) as Promise<FileRecord>,
      ),
    );

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) {
        throw new Error("File not found");
      }
      if (file.user_id !== user.subject) {
        throw new Error("Unauthorized: File does not belong to user");
      }
      if (!file.s3_key) {
        throw new Error("File is not stored in S3");
      }
    }

    const s3Keys: Array<string> = files.map((f) => (f as any).s3_key as string);

    try {
      const keyToUrl = await generateS3DownloadUrls(s3Keys);

      return args.fileIds.map((fileId, idx) => ({
        fileId,
        url: keyToUrl[s3Keys[idx]],
      }));
    } catch (error) {
      console.error("Failed to generate S3 download URLs:", error);
      console.error("S3 Keys:", s3Keys);
      throw new Error(
        `Failed to generate presigned URLs: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
});
