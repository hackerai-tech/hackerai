import "server-only";

import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { UIMessage } from "ai";
import type { ChatMode } from "@/types";
import type { FileMessagePart } from "@/types/file";
import { Id } from "@/convex/_generated/dataModel";
import { isSupportedImageMediaType, isSupportedFileMediaType } from "./file-utils";
import type { SandboxFile } from "./sandbox-file-utils";
import { collectSandboxFiles } from "./sandbox-file-utils";
import { extractAllFileIdsFromMessages } from "./file-token-utils";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

function isFilePart(part: any): part is FileMessagePart {
  return part && typeof part === "object" && part.type === "file";
}

function containsPdfAttachments(messages: UIMessage[]): boolean {
  return messages.some((message: any) =>
    (message.parts || []).some(
      (part: any) => isFilePart(part) && isSupportedFileMediaType(part.mediaType),
    ),
  );
}

/**
 * Converts a file URL to a base64 data URL for the given media type.
 * Falls back to original URL on failure.
 * @param url - The URL of the file to convert
 * @param mediaType - MIME type for the data URL
 * @returns Base64 data URL or original URL if conversion fails
 */
async function convertUrlToBase64DataUrl(
  url: string,
  mediaType: string,
): Promise<string> {
  if (!url) return url;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    try {
      const response = await fetch(url, {
        signal: controller.signal,
      });

      if (!response.ok) {
        console.error(`Failed to fetch file (${response.status}): ${url}`);
        return url;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Data = buffer.toString("base64");

      return `data:${mediaType};base64,${base64Data}`;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    console.error("Failed to convert file to base64:", {
      url,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    return url;
  }
}

/**
 * Processes all file attachments in messages:
 * - Transforms storage IDs to URLs
 * - Converts PDFs to base64
 * - Detects media and PDF files
 * - Processes document content for non-media files
 * - Prepares sandbox file uploads for agent mode
 * @param messages - Array of messages to process
 * @param mode - Chat mode (ask or agent)
 * @returns Processed messages with file metadata
 */

export async function processMessageFiles(
  messages: UIMessage[],
  mode: ChatMode = "ask",
): Promise<{
  messages: UIMessage[];
  hasMediaFiles: boolean;
  sandboxFiles: SandboxFile[];
  containsPdfFiles: boolean;
}> {
  if (!messages.length) {
    return {
      messages,
      hasMediaFiles: false,
      sandboxFiles: [],
      containsPdfFiles: false,
    };
  }

  // Create a deep copy to avoid mutation
  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];

  // Track media file types
  let hasMediaFiles = false;
  const sandboxFiles: SandboxFile[] = [];

  // Collect files that need processing
  const filesToProcess = new Map<
    string,
    {
      url?: string; // Populated dynamically during processing, not from parts
      mediaType?: string;
      positions: Array<{ messageIndex: number; partIndex: number }>;
    }
  >();

  // Scan all messages for file parts
  updatedMessages.forEach((message, messageIndex) => {
    if (!message.parts) return;

    message.parts.forEach((part: any, partIndex) => {
      if (isFilePart(part) && part.fileId) {
        // Check for media files (supported images and supported file types)
        if (part.mediaType) {
          if (
            isSupportedImageMediaType(part.mediaType) ||
            isSupportedFileMediaType(part.mediaType)
          ) {
            hasMediaFiles = true;
          }
        }

        // Files no longer have URLs in parts - they're fetched on-demand
        // Process supported files and images (URLs will be fetched when needed)
        const shouldProcess =
          (part.mediaType && isSupportedFileMediaType(part.mediaType)) ||
          (part.mediaType && isSupportedImageMediaType(part.mediaType));

        if (shouldProcess) {
          if (!filesToProcess.has(part.fileId)) {
            filesToProcess.set(part.fileId, {
              mediaType: part.mediaType,
              positions: [],
            });
          }
          filesToProcess
            .get(part.fileId)!
            .positions.push({ messageIndex, partIndex });
        }
      }
    });
  });

  if (filesToProcess.size === 0) {
    // Always add document content for non-media files even if no URL processing is needed
    const fileIds = extractAllFileIdsFromMessages(updatedMessages);
    // Mode-specific transforms
    if (mode === "agent") {
      collectSandboxFiles(updatedMessages, sandboxFiles);
      removeNonMediaFileParts(updatedMessages);
    } else {
      if (fileIds.length > 0) {
        // Filter out media files - they should stay as file parts in ask mode
        const nonMediaFileIds = filterNonMediaFileIds(updatedMessages, fileIds);
        if (nonMediaFileIds.length > 0) {
          await addDocumentContentToMessages(updatedMessages, nonMediaFileIds);
        }
      }
      // In ask mode, strip audio files entirely to avoid provider errors
      removeAudioFileParts(updatedMessages);
    }

    const containsPdfFiles = containsPdfAttachments(updatedMessages);

    return {
      messages: updatedMessages,
      hasMediaFiles,
      sandboxFiles,
      containsPdfFiles,
    };
  }

  try {
    // Always fetch fresh URLs for all files that need processing
    // Frontend strips URLs before sending, so we always generate fresh ones here
    // This ensures URLs never expire and prevents 403 errors
    // Uses action (not query) to support both S3 presigned URLs and Convex storage URLs
    const fileIdsNeedingUrls = Array.from(filesToProcess.entries())
      .filter(([_, file]) => !file.url)
      .map(([fileId]) => fileId);

    let fetchedUrls: (string | null)[] = [];
    if (fileIdsNeedingUrls.length > 0) {
      try {
        // Use ACTION instead of QUERY to properly generate S3 presigned URLs
        // Actions can call Node.js APIs (AWS SDK) while queries cannot
        fetchedUrls = await convex.action(
          api.s3Actions.getFileUrlsByFileIdsAction,
          {
            serviceKey,
            fileIds: fileIdsNeedingUrls as Id<"files">[],
          },
        );
      } catch (error) {
        console.error("Failed to fetch file URLs:", {
          error: error instanceof Error ? error.message : String(error),
          fileCount: fileIdsNeedingUrls.length,
        });
        // Continue with empty URLs - files without URLs will be skipped in processing
      }
    }

    // Map fetched URLs back to files
    fileIdsNeedingUrls.forEach((fileId, index) => {
      const file = filesToProcess.get(fileId);
      if (file && fetchedUrls[index]) {
        file.url = fetchedUrls[index];
      }
    });

    // Process each file
    for (const [fileId, file] of filesToProcess) {
      if (!file.url) continue;

      let finalUrl = file.url;
      if (file.mediaType === "application/pdf") {
        try {
          finalUrl = await convertUrlToBase64DataUrl(
            file.url,
            "application/pdf",
          );
        } catch (error) {
          console.error("Error converting PDF to base64, using original URL:", {
            fileId,
            url: file.url,
            error: error instanceof Error ? error.message : String(error),
          });
          // Continue with original URL if conversion fails
        }
      }

      // Update all file parts with the final URL
      file.positions.forEach(({ messageIndex, partIndex }) => {
        const filePart = updatedMessages[messageIndex].parts![partIndex] as any;
        if (filePart.type === "file") {
          filePart.url = finalUrl;
        }
      });
    }

    // Detect if any attached files are PDFs
    const containsPdfFiles = containsPdfAttachments(updatedMessages);

    // Extract file IDs from all messages and process document content
    const fileIds = extractAllFileIdsFromMessages(updatedMessages);
    // Mode-specific transforms
    if (mode === "agent") {
      collectSandboxFiles(updatedMessages, sandboxFiles);
      removeNonMediaFileParts(updatedMessages);
    } else {
      if (fileIds.length > 0) {
        // Filter out media files - they should stay as file parts in ask mode
        const nonMediaFileIds = filterNonMediaFileIds(updatedMessages, fileIds);
        if (nonMediaFileIds.length > 0) {
          await addDocumentContentToMessages(updatedMessages, nonMediaFileIds);
        }
      }
      // In ask mode, strip audio files entirely to avoid provider errors
      removeAudioFileParts(updatedMessages);
    }

    return {
      messages: updatedMessages,
      hasMediaFiles,
      sandboxFiles,
      containsPdfFiles,
    };
  } catch (error) {
    console.error("Failed to transform file URLs:", {
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
    // Return processed messages even if some transformations failed
    return {
      messages: updatedMessages,
      hasMediaFiles,
      sandboxFiles: [],
      containsPdfFiles: false,
    };
  }
}

/**
 * Filters out media files (images and PDFs) from the file IDs array.
 * Returns only non-media file IDs that should be converted to document content.
 */
function filterNonMediaFileIds(
  messages: UIMessage[],
  fileIds: Id<"files">[],
): Id<"files">[] {
  // Build a set of media file IDs from message parts
  const mediaFileIds = new Set<string>();

  for (const message of messages) {
    if (!message.parts) continue;

    for (const part of message.parts as any[]) {
      if (part.type === "file" && part.fileId && part.mediaType) {
        // Keep images and supported file types as file parts
        if (
          isSupportedImageMediaType(part.mediaType) ||
          isSupportedFileMediaType(part.mediaType)
        ) {
          mediaFileIds.add(part.fileId);
        }
      }
    }
  }

  // Return only non-media file IDs
  return fileIds.filter((fileId) => !mediaFileIds.has(fileId));
}

/**
 * Adds document content to the specific messages where files were attached and removes those file parts
 * @param messages - Array of messages to process
 * @param fileIds - Array of file IDs to fetch content for
 */
async function addDocumentContentToMessages(
  messages: UIMessage[],
  fileIds: Id<"files">[],
): Promise<void> {
  if (fileIds.length === 0 || messages.length === 0) {
    return;
  }

  try {
    // Fetch file content and metadata
    const fileContents = await convex.query(
      api.fileStorage.getFileContentByFileIds,
      {
        serviceKey,
        fileIds,
      },
    );

    // Create a map of fileId to content
    const fileContentMap = new Map<string, { name: string; content: string }>();
    const unprocessableFiles = new Map<
      string,
      { name: string; reason: string }
    >();

    for (const file of fileContents) {
      if (file.content !== null && file.content.trim().length > 0) {
        fileContentMap.set(file.id, { name: file.name, content: file.content });
      } else {
        unprocessableFiles.set(file.id, {
          name: file.name,
          reason:
            "This file has no readable text content. If you need to process this file, please use agent mode where you can use terminal tools to analyze binary or complex file formats.",
        });
      }
    }

    // Process each message and add document content where files exist
    for (const message of messages) {
      if (!message.parts) continue;

      const documentsForThisMessage: Array<{
        id: string;
        name: string;
        content: string;
      }> = [];
      const fileIdsToRemove = new Set<string>();
      const unprocessableFilesForThisMessage: Array<{
        name: string;
        reason: string;
      }> = [];

      // Collect all documents from file parts in this message
      for (const part of message.parts as any[]) {
        if (part.type === "file" && part.fileId) {
          // Check if it's an unprocessable file
          if (unprocessableFiles.has(part.fileId)) {
            const fileInfo = unprocessableFiles.get(part.fileId)!;

            unprocessableFilesForThisMessage.push(fileInfo);
            fileIdsToRemove.add(part.fileId);
          } else if (fileContentMap.has(part.fileId)) {
            const fileData = fileContentMap.get(part.fileId)!;

            documentsForThisMessage.push({
              id: part.fileId,
              name: fileData.name,
              content: fileData.content,
            });
            fileIdsToRemove.add(part.fileId);
          }
        }
      }

      // Build content to add to message
      let contentToAdd = "";

      // Add document content if there are processable files
      if (documentsForThisMessage.length > 0) {
        const documents = documentsForThisMessage
          .map((file) => {
            return `<document id="${file.id}">
<source>${file.name}</source>
<document_content>${file.content}</document_content>
</document>`;
          })
          .join("\n\n");

        contentToAdd = `<documents>\n${documents}\n</documents>`;
      }

      // Add notice about unprocessable files
      if (unprocessableFilesForThisMessage.length > 0) {
        const notices = unprocessableFilesForThisMessage
          .map(
            (file) => `<document>
<source>${file.name}</source>
<document_content>${file.reason}</document_content>
</document>`,
          )
          .join("\n\n");

        if (contentToAdd) {
          contentToAdd += "\n\n" + notices;
        } else {
          contentToAdd = `<documents>\n${notices}\n</documents>`;
        }
      }

      // Add the content and remove file parts
      if (contentToAdd) {
        // Add content as the first part of this message
        message.parts.unshift({
          type: "text",
          text: contentToAdd,
        });

        // Remove the file parts that were processed
        message.parts = message.parts.filter((part: any) => {
          if (part.type !== "file") return true;
          return !fileIdsToRemove.has(part.fileId);
        });
      }
    }
  } catch (error) {
    console.error("Failed to fetch and add document content:", {
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      fileIds,
    });
    // Continue processing without document content
  }
}

/**
 * Generic file-part pruner using a predicate for which file MIME types to keep.
 */
function pruneFileParts(
  messages: UIMessage[],
  shouldKeepFile: (mediaType: string | undefined) => boolean,
) {
  for (const message of messages) {
    if (!message.parts) continue;
    message.parts = message.parts.filter((part: any) => {
      if (part?.type !== "file") return true;
      return shouldKeepFile(part.mediaType);
    });
  }
}

/**
 * Removes non-image file parts from messages (used in agent mode after files are transformed to attachment tags)
 * Only keeps image file parts so the model can see them. PDFs and text files are removed.
 */
function removeNonMediaFileParts(messages: UIMessage[]) {
  pruneFileParts(messages, (mediaType) =>
    mediaType ? isSupportedImageMediaType(mediaType) : false,
  );
}

/**
 * Removes audio file parts from messages (used in ask mode to avoid provider errors)
 */
function removeAudioFileParts(messages: UIMessage[]) {
  pruneFileParts(messages, (mediaType) => {
    if (!mediaType) return true;
    return !mediaType.startsWith("audio/");
  });
}
