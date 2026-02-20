import "server-only";

import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { UIMessage } from "ai";
import type { ChatMode, FileContent } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import { isSupportedImageMediaType } from "./file-utils";
import type { SandboxFile } from "./sandbox-file-utils";
import { collectSandboxFiles } from "./sandbox-file-utils";
import { extractAllFileIdsFromMessages, isFilePart } from "./file-token-utils";
import { MAX_TOKENS_FILE } from "../token-utils";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

const containsPdfAttachments = (messages: UIMessage[]): boolean =>
  messages.some((msg: any) =>
    (msg.parts || []).some(
      (part: any) => isFilePart(part) && part.mediaType === "application/pdf",
    ),
  );

const isMediaFile = (mediaType?: string) =>
  mediaType &&
  (isSupportedImageMediaType(mediaType) || mediaType === "application/pdf");

const convertUrlToBase64DataUrl = async (
  url: string,
  mediaType: string,
): Promise<string> => {
  if (!url) return url;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.error(`Failed to fetch file (${response.status}): ${url}`);
      return url;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${mediaType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error("Failed to convert file to base64:", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return url;
  } finally {
    clearTimeout(timeoutId);
  }
};

const collectFilesToProcess = (
  messages: UIMessage[],
  mode: ChatMode,
): {
  hasMedia: boolean;
  files: Map<
    string,
    {
      url?: string;
      mediaType?: string;
      positions: Array<{ messageIndex: number; partIndex: number }>;
    }
  >;
} => {
  let hasMedia = false;
  const files = new Map<
    string,
    {
      url?: string;
      mediaType?: string;
      positions: Array<{ messageIndex: number; partIndex: number }>;
    }
  >();

  messages.forEach((msg, messageIndex) => {
    if (!msg.parts) return;

    (msg.parts as any[]).forEach((part, partIndex) => {
      if (!isFilePart(part) || !part.fileId) return;

      if (isMediaFile(part.mediaType)) hasMedia = true;

      const shouldProcess =
        mode === "agent" ||
        mode === "agent-long" ||
        part.mediaType === "application/pdf" ||
        isMediaFile(part.mediaType);

      if (shouldProcess) {
        if (!files.has(part.fileId)) {
          files.set(part.fileId, { mediaType: part.mediaType, positions: [] });
        }
        files.get(part.fileId)!.positions.push({ messageIndex, partIndex });
      }
    });
  });

  return { hasMedia, files };
};

const fetchFileUrls = async (fileIds: string[]): Promise<(string | null)[]> => {
  if (!fileIds.length) return [];

  try {
    return await convex.action(api.s3Actions.getFileUrlsByFileIdsAction, {
      serviceKey,
      fileIds: fileIds as Id<"files">[],
    });
  } catch (error) {
    console.error("Failed to fetch file URLs:", {
      error: error instanceof Error ? error.message : String(error),
      fileCount: fileIds.length,
    });
    return [];
  }
};

const applyUrlsToFileParts = async (
  messages: UIMessage[],
  filesToProcess: Map<
    string,
    {
      url?: string;
      mediaType?: string;
      positions: Array<{ messageIndex: number; partIndex: number }>;
    }
  >,
  mode: ChatMode,
) => {
  const fileIdsNeedingUrls = Array.from(filesToProcess.entries())
    .filter(([_, file]) => !file.url)
    .map(([fileId]) => fileId);

  const fetchedUrls = await fetchFileUrls(fileIdsNeedingUrls);

  fileIdsNeedingUrls.forEach((fileId, index) => {
    const file = filesToProcess.get(fileId);
    if (file && fetchedUrls[index]) {
      file.url = fetchedUrls[index];
    }
  });

  for (const [_, file] of filesToProcess) {
    if (!file.url) continue;

    // Only convert PDFs to base64 in "ask" mode for inline viewing.
    // In "agent" mode, we want the original URL for sandbox curl download.
    const finalUrl =
      mode === "ask" && file.mediaType === "application/pdf"
        ? await convertUrlToBase64DataUrl(file.url, "application/pdf").catch(
            () => file.url!,
          )
        : file.url;

    file.positions.forEach(({ messageIndex, partIndex }) => {
      const filePart = messages[messageIndex].parts![partIndex] as any;
      if (filePart.type === "file") filePart.url = finalUrl;
    });
  }
};

/**
 * Removes file parts that don't have a URL (failed to fetch).
 * These would cause AI_InvalidPromptError since file parts require actual content.
 */
const removeFilePartsWithoutUrls = (messages: UIMessage[]) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = msg.parts.filter(
      (part: any) => part?.type !== "file" || !!part.url,
    );
  });
};

const applyModeSpecificTransforms = async (
  messages: UIMessage[],
  mode: ChatMode,
  sandboxFiles: SandboxFile[],
  uploadBasePath?: string,
) => {
  const fileIds = extractAllFileIdsFromMessages(messages);

  if (mode === "agent" || mode === "agent-long") {
    collectSandboxFiles(messages, sandboxFiles, uploadBasePath);
    removeNonMediaFileParts(messages);
  } else {
    const nonMediaFileIds = filterNonMediaFileIds(messages, fileIds);
    if (nonMediaFileIds.length > 0) {
      await addDocumentContentToMessages(messages, nonMediaFileIds);
    }
    removeAudioFileParts(messages);
  }

  // Remove any file parts that failed to get URLs to prevent AI_InvalidPromptError
  removeFilePartsWithoutUrls(messages);
};

/**
 * Processes all file attachments in messages for AI model consumption
 *
 * Transforms file parts based on chat mode:
 * - **Ask mode**: Converts non-media files to document content, keeps images/PDFs as file parts
 * - **Agent / Agent-long mode**: Prepares all files for sandbox upload, keeps only images as file parts
 *
 * Processing steps:
 * 1. Generates fresh URLs for files (prevents expiration)
 * 2. Converts PDFs to base64 for inline viewing
 * 3. Detects media files (images/PDFs)
 * 4. Applies mode-specific transforms:
 *    - Ask: Injects document content for text files, removes audio
 *    - Agent/Agent-long: Collects files for sandbox, adds attachment tags, removes non-images
 *
 * @param messages - Messages to process
 * @param mode - Chat mode ("ask", "agent", or "agent-long")
 * @param uploadBasePath - Override for agent mode (/home/user/upload or /tmp/hackerai-upload for local dangerous)
 * @returns Processed messages with file metadata and sandbox files for upload
 */
export const processMessageFiles = async (
  messages: UIMessage[],
  mode: ChatMode = "ask",
  uploadBasePath?: string,
): Promise<{
  messages: UIMessage[];
  hasMediaFiles: boolean;
  sandboxFiles: SandboxFile[];
  containsPdfFiles: boolean;
}> => {
  if (!messages.length) {
    return {
      messages,
      hasMediaFiles: false,
      sandboxFiles: [],
      containsPdfFiles: false,
    };
  }

  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];
  const sandboxFiles: SandboxFile[] = [];

  const { hasMedia, files } = collectFilesToProcess(updatedMessages, mode);

  if (files.size > 0) {
    await applyUrlsToFileParts(updatedMessages, files, mode);
  }

  await applyModeSpecificTransforms(
    updatedMessages,
    mode,
    sandboxFiles,
    uploadBasePath,
  );

  return {
    messages: updatedMessages,
    hasMediaFiles: hasMedia,
    sandboxFiles,
    containsPdfFiles: containsPdfAttachments(updatedMessages),
  };
};

const filterNonMediaFileIds = (
  messages: UIMessage[],
  fileIds: Id<"files">[],
): Id<"files">[] => {
  const mediaFileIds = new Set<string>();

  messages.forEach((msg) => {
    if (!msg.parts) return;
    (msg.parts as any[]).forEach((part) => {
      if (part.type === "file" && part.fileId && isMediaFile(part.mediaType)) {
        mediaFileIds.add(part.fileId);
      }
    });
  });

  return fileIds.filter((fileId) => !mediaFileIds.has(fileId));
};

const formatDocument = (
  id: string,
  name: string,
  content: string,
) => `<document id="${id}">
<source>${name}</source>
<document_content>${content}</document_content>
</document>`;

const formatUnprocessableDocument = (name: string, reason: string) =>
  `<document>
<source>${name}</source>
<document_content>${reason}</document_content>
</document>`;

const addDocumentContentToMessages = async (
  messages: UIMessage[],
  fileIds: Id<"files">[],
): Promise<void> => {
  if (!fileIds.length || !messages.length) return;

  try {
    const fileContents = await convex.query(
      api.fileStorage.getFileContentByFileIds,
      { serviceKey, fileIds },
    );

    const processableFiles = new Map<
      string,
      { name: string; content: string }
    >();
    const unprocessableFiles = new Map<
      string,
      { name: string; reason: string }
    >();

    fileContents.forEach((file: FileContent) => {
      // Check if file exceeds token limit for ask mode
      if (file.tokenSize > MAX_TOKENS_FILE) {
        unprocessableFiles.set(file.id, {
          name: file.name,
          reason: `This file is too large for ask mode (${file.tokenSize.toLocaleString()} tokens, limit: ${MAX_TOKENS_FILE.toLocaleString()} tokens). Please use agent mode to access this file, where you can use terminal tools to analyze it.`,
        });
      } else if (file.content?.trim()) {
        processableFiles.set(file.id, {
          name: file.name,
          content: file.content,
        });
      } else {
        unprocessableFiles.set(file.id, {
          name: file.name,
          reason:
            "This file has no readable text content. If you need to process this file, please use agent mode where you can use terminal tools to analyze binary or complex file formats.",
        });
      }
    });

    messages.forEach((msg) => {
      if (!msg.parts) return;

      const documents: string[] = [];
      const fileIdsToRemove = new Set<string>();

      (msg.parts as any[]).forEach((part) => {
        if (part.type !== "file" || !part.fileId) return;

        if (unprocessableFiles.has(part.fileId)) {
          const { name, reason } = unprocessableFiles.get(part.fileId)!;
          documents.push(formatUnprocessableDocument(name, reason));
          fileIdsToRemove.add(part.fileId);
        } else if (processableFiles.has(part.fileId)) {
          const { name, content } = processableFiles.get(part.fileId)!;
          documents.push(formatDocument(part.fileId, name, content));
          fileIdsToRemove.add(part.fileId);
        }
      });

      if (documents.length > 0) {
        msg.parts.unshift({
          type: "text",
          text: `<documents>\n${documents.join("\n\n")}\n</documents>`,
        });
        msg.parts = msg.parts.filter(
          (part: any) =>
            part.type !== "file" || !fileIdsToRemove.has(part.fileId),
        );
      }
    });
  } catch (error) {
    console.error("Failed to fetch and add document content:", {
      error: error instanceof Error ? error.message : String(error),
      fileIds,
    });
  }
};

const pruneFileParts = (
  messages: UIMessage[],
  shouldKeep: (mediaType?: string) => boolean,
) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = msg.parts.filter(
      (part: any) => part?.type !== "file" || shouldKeep(part.mediaType),
    );
  });
};

const removeNonMediaFileParts = (messages: UIMessage[]) =>
  pruneFileParts(
    messages,
    (mediaType) => !!mediaType && isSupportedImageMediaType(mediaType),
  );

const removeAudioFileParts = (messages: UIMessage[]) =>
  pruneFileParts(messages, (mediaType) => !mediaType?.startsWith("audio/"));
