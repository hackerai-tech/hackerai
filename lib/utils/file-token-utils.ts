import "server-only";

import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { UIMessagePart, UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";
import {
  truncateMessagesToTokenLimit,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import type { SubscriptionTier } from "@/types";
import type { FileMessagePart } from "@/types/file";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * Type guard to check if a message part is a file part
 */
export const isFilePart = (part: any): part is FileMessagePart =>
  part && typeof part === "object" && part.type === "file";

/**
 * Extracts file IDs from message parts
 */
export const extractFileIdsFromParts = (
  parts: UIMessagePart<any, any>[],
): Id<"files">[] =>
  parts
    .filter(isFilePart)
    .map((part: any) => part.fileId as Id<"files">)
    .filter(Boolean);

/**
 * Fetches token counts for given file IDs from storage
 * @returns Record mapping file IDs to their token counts
 */
export const getFileTokensByIds = async (
  fileIds: Id<"files">[],
): Promise<Record<Id<"files">, number>> => {
  if (!fileIds.length) return {};

  try {
    const tokens = await convex.query(api.fileStorage.getFileTokensByFileIds, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      fileIds,
    });

    return Object.fromEntries(
      fileIds.map((id, i) => [id, tokens[i] || 0]),
    ) as Record<Id<"files">, number>;
  } catch (error) {
    console.error("Failed to fetch file tokens:", error);
    return {};
  }
};

/**
 * Extracts all unique file IDs from an array of messages
 */
export const extractAllFileIdsFromMessages = (
  messages: UIMessage[],
): Id<"files">[] => {
  const fileIds = new Set<Id<"files">>();
  messages.forEach((msg) => {
    if (msg.parts) {
      extractFileIdsFromParts(msg.parts).forEach((id) => fileIds.add(id));
    }
  });
  return Array.from(fileIds);
};

/**
 * Truncates messages to fit within subscription token limits, including file tokens
 * @param skipFileTokens - Skip file token counting (for agent mode where files go to sandbox)
 * @returns Object with truncated messages and the computed fileTokens map
 */
export const truncateMessagesWithFileTokens = async (
  messages: UIMessage[],
  subscription: SubscriptionTier = "pro",
  skipFileTokens: boolean = false,
): Promise<{
  messages: UIMessage[];
  fileTokens: Record<Id<"files">, number>;
}> => {
  const maxTokens = getMaxTokensForSubscription(subscription);
  const fileTokens = skipFileTokens
    ? {}
    : await getFileTokensByIds(extractAllFileIdsFromMessages(messages));

  return {
    messages: truncateMessagesToTokenLimit(messages, fileTokens, maxTokens),
    fileTokens,
  };
};

/**
 * Truncates messages using precomputed file token map when available
 */
export const truncateMessagesWithPrecomputedTokens = async (
  messages: UIMessage[],
  subscription: SubscriptionTier = "pro",
  precomputedFileTokens?: Record<Id<"files">, number>,
): Promise<UIMessage[]> => {
  const maxTokens = getMaxTokensForSubscription(subscription);
  const fileTokens =
    precomputedFileTokens ||
    (await getFileTokensByIds(extractAllFileIdsFromMessages(messages)));

  return truncateMessagesToTokenLimit(messages, fileTokens, maxTokens);
};
