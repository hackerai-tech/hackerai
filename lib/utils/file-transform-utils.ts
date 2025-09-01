import "server-only";

import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Converts a file URL to base64 data
 * @param fileUrl - The URL of the file to convert
 * @returns Base64 string or null if conversion fails
 */
async function convertFileToBase64(fileUrl: string): Promise<string | null> {
  if (!fileUrl) return null;

  try {
    const response = await fetch(fileUrl);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString('base64');
  } catch (error) {
    console.error("Failed to convert file to base64:", error);
    return null;
  }
}

/**
 * Processes file parts in messages to transform URLs and convert PDFs to base64
 * @param messages - Array of messages to process
 * @returns Processed messages with transformed file URLs
 */
export async function transformStorageIdsToUrls(
  messages: UIMessage[],
): Promise<UIMessage[]> {
  if (!messages.length) return messages;

  // Create a deep copy to avoid mutation
  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];
  
  // Collect files that need processing
  const filesToProcess = new Map<string, {
    url?: string;
    mediaType?: string;
    positions: Array<{ messageIndex: number; partIndex: number }>;
  }>();

  // Scan all messages for file parts
  updatedMessages.forEach((message, messageIndex) => {
    if (!message.parts) return;

    message.parts.forEach((part: any, partIndex) => {
      if (part.type === "file" && part.fileId) {
        const shouldProcess = 
          part.mediaType === "application/pdf" || 
          !part.url || 
          !part.url.startsWith("http");

        if (shouldProcess) {
          if (!filesToProcess.has(part.fileId)) {
            filesToProcess.set(part.fileId, {
              url: part.url,
              mediaType: part.mediaType,
              positions: []
            });
          }
          filesToProcess.get(part.fileId)!.positions.push({ messageIndex, partIndex });
        }
      }
    });
  });

  if (filesToProcess.size === 0) return updatedMessages;

  try {
    // Fetch URLs for files that don't have them
    const fileIdsNeedingUrls = Array.from(filesToProcess.entries())
      .filter(([_, file]) => !file.url)
      .map(([fileId]) => fileId);

    const fetchedUrls = fileIdsNeedingUrls.length > 0 
      ? await convex.query(api.fileStorage.getFileUrlsByFileIds, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
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

      const finalUrl = file.mediaType === "application/pdf" 
        ? await convertPdfToBase64Url(file.url, fileId)
        : file.url;

      // Update all file parts with the final URL
      file.positions.forEach(({ messageIndex, partIndex }) => {
        const filePart = updatedMessages[messageIndex].parts![partIndex] as any;
        if (filePart.type === "file") {
          filePart.url = finalUrl;
        }
      });
    }

    return updatedMessages;
  } catch (error) {
    console.error("Failed to transform file URLs:", error);
    return messages;
  }
}

/**
 * Converts a PDF URL to base64 data URL
 * @param url - The PDF URL to convert
 * @param fileId - File ID for logging
 * @returns Base64 data URL or original URL if conversion fails
 */
async function convertPdfToBase64Url(url: string, fileId: string): Promise<string> {
  console.log(`Converting PDF to base64 for fileId: ${fileId}`);
  
  const base64Data = await convertFileToBase64(url);
  if (base64Data) {
    console.log(`Successfully converted PDF to base64, length: ${base64Data.length}`);
    return `data:application/pdf;base64,${base64Data}`;
  } else {
    console.log(`Failed to convert PDF to base64 for fileId: ${fileId}`);
    return url;
  }
}

/**
 * Fetch file content for non-media files and create document text parts
 * @param fileIds - Array of file IDs to fetch content for
 * @returns Object with formatted document content string and array of file IDs that have content
 */
export async function getDocumentContentForFiles(
  fileIds: string[],
): Promise<{ documentContent: string; fileIdsWithContent: string[] }> {
  if (fileIds.length === 0) {
    return { documentContent: "", fileIdsWithContent: [] };
  }

  try {
    // Fetch file content and metadata
    const fileContents = await convex.query(api.fileStorage.getFileContentByFileIds, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      fileIds: fileIds as Id<"files">[],
    });

    // Filter files that have content (non-image, non-PDF files)
    const documentsWithContent = fileContents.filter(file => file.content !== null);

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
      .join('\n\n');

    const documentContent = `<documents>\n${documents}\n</documents>`;
    const fileIdsWithContent = documentsWithContent.map(file => file.id);

    return { documentContent, fileIdsWithContent };
  } catch (error) {
    console.error("Failed to fetch file content:", error);
    return { documentContent: "", fileIdsWithContent: [] };
  }
}
