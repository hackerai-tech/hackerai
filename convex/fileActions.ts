"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { countTokens } from "gpt-tokenizer";
import { getDocument } from "pdfjs-serverless";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { JSONLoader } from "langchain/document_loaders/fs/json";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { isBinaryFile } from "isbinaryfile";
import { internal } from "./_generated/api";
import type {
  FileItemChunk,
  SupportedFileType,
  ProcessFileOptions,
} from "../types/file";
import { Id } from "./_generated/dataModel";
import { validateServiceKey } from "./chats";
import { isSupportedImageMediaType } from "../lib/utils/file-utils";
import { MAX_TOKENS_FILE } from "../lib/token-utils";

/**
 * Validate token count and throw error if exceeds limit
 * @param chunks - Array of file chunks
 * @param fileName - Name of the file for error reporting
 */
const validateTokenLimit = (
  chunks: FileItemChunk[],
  fileName: string,
): void => {
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

/**
 * Process file with auto-detection of file type and comprehensive fallback handling
 * @param file - The file as a Blob
 * @param fileName - Optional file name for type detection
 * @param mediaType - Optional media type for additional checks
 * @param prepend - Optional prepend text for markdown files
 * @returns Promise<FileItemChunk[]>
 */
const processFileAuto = async (
  file: Blob | string,
  fileName?: string,
  mediaType?: string,
  prepend?: string,
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
      validateTokenLimit(chunks, fileName || "unknown");
      return chunks;
    }
    const fileType = detectedType;

    const chunks = await processFile(file, { fileType, prepend, fileName });
    validateTokenLimit(chunks, fileName || "unknown");
    return chunks;
  } catch (error) {
    // Check if this is a token limit error - re-throw immediately without fallback
    if (
      error instanceof Error &&
      error.message.includes("exceeds the maximum token limit")
    ) {
      throw error;
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
        if (fallbackTokens > MAX_TOKENS_FILE) {
          throw new Error(
            `File "${fileName || "unknown"}" exceeds the maximum token limit of ${MAX_TOKENS_FILE} tokens. Current tokens: ${fallbackTokens}`,
          );
        }

        return [
          {
            content: textContent,
            tokens: fallbackTokens,
          },
        ];
      } catch (textError) {
        // Check if this is a token limit error
        if (
          textError instanceof Error &&
          textError.message.includes("exceeds the maximum token limit")
        ) {
          throw textError; // Re-throw token limit errors
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
  const loader = new JSONLoader(json);
  const docs = await loader.load();
  const completeText = docs.map((doc) => doc.pageContent).join(" ");

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
    storageId: v.id("_storage"),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    serviceKey: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  returns: v.object({
    url: v.string(),
    fileId: v.id("files"),
    tokens: v.number(),
  }),
  handler: async (ctx, args) => {
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

    const fileUrl = await ctx.storage.getUrl(args.storageId);

    if (!fileUrl) {
      throw new Error(
        `Failed to upload ${args.name}: File not found in storage`,
      );
    }

    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(`Failed to upload ${args.name}: ${response.statusText}`);
    }

    const file = await response.blob();

    // Calculate token size using the comprehensive file processing logic
    let tokenSize = 0;
    let fileContent: string | undefined = undefined;

    try {
      // Use the comprehensive file processing for all file types (including auto-detection and default handling)
      const chunks = await processFileAuto(file, args.name, args.mediaType);
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
        await ctx.storage.delete(args.storageId);
        throw error; // Re-throw the token limit error (already includes file name)
      }

      // For any other unexpected errors, delete storage and wrap with file name
      console.error(
        `Unexpected error processing file "${args.name}". Deleting storage object.`,
      );
      await ctx.storage.delete(args.storageId);
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to upload ${args.name}: ${errorMsg}`);
    }

    // Use internal mutation to save to database
    const fileId = (await ctx.runMutation(internal.fileStorage.saveFileToDb, {
      storageId: args.storageId,
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
