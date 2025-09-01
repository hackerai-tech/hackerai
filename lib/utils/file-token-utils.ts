import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { ConvexHttpClient } from "convex/browser";
import { UIMessagePart } from "ai";
import { UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";
import { truncateMessagesToTokenLimit } from "@/lib/token-utils";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Extract file IDs from message parts
 * @param parts - Array of message parts
 * @returns Array of file IDs found in file parts
 */
export function extractFileIdsFromParts(
  parts: UIMessagePart<any, any>[],
): string[] {
  const fileIds: string[] = [];

  for (const part of parts) {
    if (part.type === "file") {
      // Check if fileId exists directly
      if ((part as any).fileId) {
        fileIds.push((part as any).fileId);
      }
    }
  }

  return fileIds;
}

/**
 * Fetch file tokens for given file IDs
 * @param fileIds - Array of file IDs
 * @returns Record mapping file IDs to their token counts
 */
export async function getFileTokensByIds(
  fileIds: string[],
): Promise<Record<string, number>> {
  if (fileIds.length === 0) {
    return {};
  }

  try {
    const tokens = await convex.query(api.fileStorage.getFileTokensByFileIds, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      fileIds: fileIds as Id<"files">[],
    });

    // Create a mapping from fileId to token count
    const fileTokenMap: Record<string, number> = {};
    for (let i = 0; i < fileIds.length; i++) {
      fileTokenMap[fileIds[i]] = tokens[i] || 0;
    }

    return fileTokenMap;
  } catch (error) {
    console.error("Failed to fetch file tokens:", error);
    // Return empty map if fetching fails
    return {};
  }
}

/**
 * Extract all file IDs from an array of messages
 * @param messages - Array of messages to extract file IDs from
 * @returns Array of unique file IDs found in all messages
 */
export function extractAllFileIdsFromMessages(messages: UIMessage[]): string[] {
  const fileIds = new Set<string>();

  for (const message of messages) {
    if (message.parts) {
      const messageFileIds = extractFileIdsFromParts(message.parts);
      messageFileIds.forEach((id) => fileIds.add(id));
    }
  }

  return Array.from(fileIds);
}

/**
 * Truncate messages with file tokens included - combines file ID extraction,
 * token fetching, and message truncation in one efficient operation
 * @param messages - Array of messages to truncate
 * @param maxTokens - Maximum token limit (optional, uses default from token-utils)
 * @returns Truncated messages array
 */
export async function truncateMessagesWithFileTokens(
  messages: UIMessage[],
  maxTokens?: number,
): Promise<UIMessage[]> {
  // Extract file IDs from all messages
  const fileIds = extractAllFileIdsFromMessages(messages);

  // Fetch file tokens for all file IDs
  const fileTokens = await getFileTokensByIds(fileIds);

  // Truncate messages with file tokens included
  return truncateMessagesToTokenLimit(messages, maxTokens, fileTokens);
}
