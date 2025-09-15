import "server-only";

import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

/**
 * Processes file parts in messages to transform URLs and convert PDFs to base64
 * @param messages - Array of messages to process
 * @returns Object with processed messages and media file information
 */
export async function transformStorageIdsToUrls(
  messages: UIMessage[],
): Promise<{
  messages: UIMessage[];
  hasMediaFiles: boolean;
  hasBase64Files: boolean;
}> {
  if (!messages.length)
    return { messages, hasMediaFiles: false, hasBase64Files: false };

  // Create a deep copy to avoid mutation
  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];

  // Track media file types
  let hasMediaFiles = false;
  let hasBase64Files = false;

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
      if (part.type === "file" && part.fileId) {
        // Check for media files
        if (part.mediaType) {
          if (
            part.mediaType.startsWith("image/") ||
            part.mediaType === "application/pdf"
          ) {
            hasMediaFiles = true;
          }
        }

        const shouldProcess = !part.url || !part.url.startsWith("http");

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
    return { messages: updatedMessages, hasMediaFiles, hasBase64Files };
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

    // Process each file: always use storage URL, never convert to base64
    for (const [, file] of filesToProcess) {
      if (!file.url) continue;

      const finalUrl = file.url;

      // Update all file parts with the final URL
      file.positions.forEach(({ messageIndex, partIndex }) => {
        const filePart = updatedMessages[messageIndex].parts![partIndex] as any;
        if (filePart.type === "file") {
          filePart.url = finalUrl;
        }
      });
    }

    return { messages: updatedMessages, hasMediaFiles, hasBase64Files };
  } catch (error) {
    console.error("Failed to transform file URLs:", error);
    return { messages, hasMediaFiles, hasBase64Files };
  }
}

/**
 * Fetch file content for non-media files and create document text parts
 * @param fileIds - Array of file IDs to fetch content for
 * @returns Object with formatted document content string and array of file IDs that have content
 */
export async function getDocumentContentForFiles(
  fileIds: Id<"files">[],
): Promise<{
  documentContent: string;
  fileIdsWithContent: Array<Id<"files">>;
}> {
  if (fileIds.length === 0) {
    return { documentContent: "", fileIdsWithContent: [] };
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

    // Filter files that have content (non-image, non-PDF files)
    const documentsWithContent = fileContents.filter(
      (file) => file.content !== null,
    );

    if (documentsWithContent.length === 0) {
      return { documentContent: "", fileIdsWithContent: [] };
    }

    // Format documents according to the specified format
    const documents = documentsWithContent
      .map((file) => {
        return `<document id="${file.id}">
<source>${file.name}</source>
<document_content>${file.content}</document_content>
</document>`;
      })
      .join("\n\n");

    const documentContent = `<documents>\n${documents}\n</documents>`;
    const fileIdsWithContent = documentsWithContent.map((file) => file.id);

    return { documentContent, fileIdsWithContent };
  } catch (error) {
    console.error("Failed to fetch file content:", error);
    return { documentContent: "", fileIdsWithContent: [] };
  }
}

/**
 * Adds document content to the beginning of the first user message and removes non-media file parts
 * @param messages - Array of messages to process
 * @param documentContent - Formatted document content string
 * @param fileIdsWithContent - Array of file IDs that have content (to be removed from file parts)
 */
export function addDocumentContentAndRemoveFileParts(
  messages: UIMessage[],
  documentContent: string,
  fileIdsWithContent: Array<Id<"files">>,
) {
  if (!documentContent || messages.length === 0) {
    return;
  }

  // Create a set for faster lookup
  const fileIdsToRemove = new Set(fileIdsWithContent);

  // Process all messages to remove non-media file parts
  for (const message of messages) {
    if (message.parts) {
      message.parts = message.parts.filter((part: any) => {
        // Keep non-file parts
        if (part.type !== "file") {
          return true;
        }

        // Keep file parts that are not in the fileIdsWithContent list (i.e., media files)
        return !fileIdsToRemove.has(part.fileId);
      });
    }
  }

  // Find the first user message and add document content
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      const message = messages[i];

      // Ensure message.parts exists
      if (!message.parts) {
        message.parts = [];
      }

      // Add document content as the first text part
      message.parts.unshift({
        type: "text",
        text: documentContent,
      });
      break;
    }
  }
}
