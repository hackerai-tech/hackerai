import "server-only";

import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { UIMessage } from "ai";
import type { ChatMode } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import { isSupportedImageMediaType } from "./file-utils";
import type { SandboxFile } from "./sandbox-file-utils";
import { collectSandboxFiles } from "./sandbox-file-utils";
import { extractAllFileIdsFromMessages } from "./file-token-utils";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

type FilePart = {
  type: "file";
  fileId?: string;
  url?: string;
  mediaType?: string;
  name?: string;
  filename?: string;
};

function isFilePart(part: any): part is FilePart {
  return part && typeof part === "object" && part.type === "file";
}

function containsPdfAttachments(messages: UIMessage[]): boolean {
  return messages.some((message: any) =>
    (message.parts || []).some(
      (part: any) => isFilePart(part) && part.mediaType === "application/pdf",
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
    const response = await fetch(url);
    if (!response.ok) {
      return url;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Data = buffer.toString("base64");

    return `data:${mediaType};base64,${base64Data}`;
  } catch (error) {
    console.error("Failed to convert file to base64:", error);
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
  if (!messages.length)
    return {
      messages,
      hasMediaFiles: false,
      sandboxFiles: [],
      containsPdfFiles: false,
    };

  // Create a deep copy to avoid mutation
  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];

  // Track media file types
  let hasMediaFiles = false;
  const sandboxFiles: SandboxFile[] = [];


  // Collect files that need processing
  const filesToProcess = new Map<
    string,
    {
      url?: string;
      mediaType?: string;
      positions: Array<{ messageIndex: number; partIndex: number }>;
    }
  >();

  // Scan all messages for file parts
  updatedMessages.forEach((message, messageIndex) => {
    if (!message.parts) return;

    message.parts.forEach((part: any, partIndex) => {
      if (isFilePart(part) && part.fileId) {
        // Check for media files (supported images and PDFs)
        if (part.mediaType) {
          if (
            isSupportedImageMediaType(part.mediaType) ||
            part.mediaType === "application/pdf"
          ) {
            hasMediaFiles = true;
          }
        }

        const shouldProcess =
          part.mediaType === "application/pdf" ||
          !part.url ||
          !part.url.startsWith("http");

        if (shouldProcess) {
          if (!filesToProcess.has(part.fileId)) {
            filesToProcess.set(part.fileId, {
              url: part.url,
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
    // In agent mode, collect sandbox files BEFORE document conversion removes file parts
    if (mode === "agent") {
      collectSandboxFiles(updatedMessages, sandboxFiles);
    }
    if (mode !== "agent" && fileIds.length > 0) {
      await addDocumentContentToMessages(updatedMessages, fileIds);
    }
    if (mode === "agent") {
      removeNonMediaFileParts(updatedMessages);
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
    // Fetch URLs for files that don't have them
    const fileIdsNeedingUrls = Array.from(filesToProcess.entries())
      .filter(([_, file]) => !file.url)
      .map(([fileId]) => fileId);

    const fetchedUrls =
      fileIdsNeedingUrls.length > 0
        ? await convex.query(api.fileStorage.getFileUrlsByFileIds, {
            serviceKey,
            fileIds: fileIdsNeedingUrls as Id<"files">[],
          })
        : [];

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
        finalUrl = await convertUrlToBase64DataUrl(
          file.url,
          "application/pdf",
        );
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
    // In agent mode, collect sandbox files BEFORE document conversion removes file parts
    if (mode === "agent") {
      collectSandboxFiles(updatedMessages, sandboxFiles);
    }
    if (mode !== "agent" && fileIds.length > 0) {
      await addDocumentContentToMessages(updatedMessages, fileIds);
    }
    if (mode === "agent") {
      removeNonMediaFileParts(updatedMessages);
    }

    return {
      messages: updatedMessages,
      hasMediaFiles,
      sandboxFiles,
      containsPdfFiles,
    };
  } catch (error) {
    console.error("Failed to transform file URLs:", error);
    return {
      messages,
      hasMediaFiles,
      sandboxFiles: [],
      containsPdfFiles: false,
    };
  }
}

// removed convertPdfToBase64Url in favor of convertUrlToBase64DataUrl

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
    for (const file of fileContents) {
      if (file.content !== null) {
        fileContentMap.set(file.id, { name: file.name, content: file.content });
      }
    }

    if (fileContentMap.size === 0) {
      return;
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

      // Collect all documents from file parts in this message
      for (const part of message.parts as any[]) {
        if (
          part.type === "file" &&
          part.fileId &&
          fileContentMap.has(part.fileId)
        ) {
          const fileData = fileContentMap.get(part.fileId)!;
          documentsForThisMessage.push({
            id: part.fileId,
            name: fileData.name,
            content: fileData.content,
          });
          fileIdsToRemove.add(part.fileId);
        }
      }

      // If there are documents for this message, add them and remove file parts
      if (documentsForThisMessage.length > 0) {
        // Format documents
        const documents = documentsForThisMessage
          .map((file) => {
            return `<document id="${file.id}">
<source>${file.name}</source>
<document_content>${file.content}</document_content>
</document>`;
          })
          .join("\n\n");

        const documentContent = `<documents>\n${documents}\n</documents>`;

        // Add document content as the first part of this message
        message.parts.unshift({
          type: "text",
          text: documentContent,
        });

        // Remove the file parts that were converted to documents
        message.parts = message.parts.filter((part: any) => {
          if (part.type !== "file") return true;
          return !fileIdsToRemove.has(part.fileId);
        });
      }
    }
  } catch (error) {
    console.error("Failed to fetch and add document content:", error);
  }
}

/**
 * Removes non-image file parts from messages (used in agent mode after files are transformed to attachment tags)
 * Only keeps image file parts so the model can see them. PDFs and text files are removed.
 * @param messages - Array of messages to process
 */
function removeNonMediaFileParts(messages: UIMessage[]) {
  for (const message of messages) {
    if (message.parts) {
      message.parts = message.parts.filter((part: any) => {
        // Keep non-file parts
        if (part.type !== "file") return true;

        // Only keep image file parts for the model to process
        if (isSupportedImageMediaType(part.mediaType)) {
          return true;
        }

        // Remove PDFs and text/document file parts (uploaded to sandbox and referenced via attachment tags)
        return false;
      });
    }
  }
}
