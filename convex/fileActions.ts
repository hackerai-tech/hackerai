"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { countTokens, encode } from "gpt-tokenizer";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { JSONLoader } from "langchain/document_loaders/fs/json";
import { isBinaryFile } from "isbinaryfile";
import { internal } from "./_generated/api";
import type {
  FileItemChunk,
  SupportedFileType,
  ProcessFileOptions,
} from "../types/file";

// Constants
const MAX_TOKEN_LIMIT = 24000;

/**
 * Check if the file is an image based on MIME type
 * @param mediaType - The MIME type of the file
 * @returns boolean - True if the file is an image
 */
const isImageFile = (mediaType: string): boolean => {
  return mediaType.startsWith("image/");
};

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
  if (totalTokens > MAX_TOKEN_LIMIT) {
    throw new Error(
      `File "${fileName}" exceeds the maximum token limit of ${MAX_TOKEN_LIMIT} tokens. Current tokens: ${totalTokens}`,
    );
  }
};

/**
 * Unified file processing function that supports all file types
 * @param file - The file as a Blob or string (for DOCX)
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
        return await processDocxFile(file as string);

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
    throw new Error(
      `Failed to process ${fileType} file: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
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
        return "docx";
    }
  }

  return null;
};

/**
 * Process file with auto-detection of file type and comprehensive fallback handling
 * @param file - The file as a Blob or string (for DOCX)
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
  // Check if file is an image - return 0 tokens immediately
  if (mediaType && isImageFile(mediaType)) {
    return [
      {
        content: "",
        tokens: 0,
      },
    ];
  }

  try {
    let fileType: SupportedFileType;

    if (typeof file === "string") {
      // Assume it's a DOCX file if string input
      fileType = "docx";
    } else {
      const detectedType = detectFileType(file, fileName);
      if (!detectedType) {
        // Use default processing for unknown file types
        const chunks = await processFile(file, {
          fileType: "unknown" as any,
          prepend,
        });
        validateTokenLimit(chunks, fileName || "unknown");
        return chunks;
      }
      fileType = detectedType;
    }

    const chunks = await processFile(file, { fileType, prepend });
    validateTokenLimit(chunks, fileName || "unknown");
    return chunks;
  } catch (error) {
    // If processing fails, try simple text decoding as fallback
    console.warn(`Failed to process file with comprehensive logic: ${error}`);

    // Check if file is an image - return 0 tokens
    if (mediaType && isImageFile(mediaType)) {
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
        if (fallbackTokens > MAX_TOKEN_LIMIT) {
          throw new Error(
            `File "${fileName || "unknown"}" exceeds the maximum token limit of ${MAX_TOKEN_LIMIT} tokens. Current tokens: ${fallbackTokens}`,
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
  const loader = new PDFLoader(pdf);
  const docs = await loader.load();
  const completeText = docs.map((doc: any) => doc.pageContent).join(" ");

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

const processDocxFile = async (text: string): Promise<FileItemChunk[]> => {
  return [
    {
      content: text,
      tokens: encode(text).length,
    },
  ];
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
  },
  returns: v.object({
    url: v.string(),
    fileId: v.string(),
    tokens: v.number(),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();

    if (!user) {
      throw new Error("Unauthorized: User not authenticated");
    }

    const fileUrl = await ctx.storage.getUrl(args.storageId);

    if (!fileUrl) {
      throw new Error("File not found in storage");
    }

    const response = await fetch(fileUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.statusText}`);
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
      const shouldSaveContent = !isImageFile(args.mediaType) && 
                               args.mediaType !== "application/pdf" && 
                               chunks.length > 0 && 
                               chunks[0].content.length > 0;
      
      if (shouldSaveContent) {
        fileContent = chunks.map(chunk => chunk.content).join('\n\n');
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
        throw error; // Re-throw the token limit error
      }

      // For any other unexpected errors, delete storage and re-throw
      console.error(
        `Unexpected error processing file "${args.name}". Deleting storage object.`,
      );
      await ctx.storage.delete(args.storageId);
      throw error;
    }

    // Use internal mutation to save to database
    const fileId: string = await ctx.runMutation(
      internal.fileStorage.saveFileToDb,
      {
        storageId: args.storageId,
        userId: user.subject,
        name: args.name,
        mediaType: args.mediaType,
        size: args.size,
        fileTokenSize: tokenSize,
        content: fileContent,
      },
    );

    // Return the file URL, database file ID, and token count
    return {
      url: fileUrl,
      fileId,
      tokens: tokenSize,
    };
  },
});
