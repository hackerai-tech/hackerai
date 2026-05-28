import "server-only";

import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { UIMessagePart, UIMessage } from "ai";
import { Id } from "@/convex/_generated/dataModel";
import {
  truncateMessagesToTokenLimit,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import type { SubscriptionTier } from "@/types";
import type { FileMessagePart } from "@/types/file";
import { logger } from "@/lib/logger";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";

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
  userId: string | undefined,
): Promise<Record<Id<"files">, number>> => {
  if (!fileIds.length) return {};
  if (!userId) {
    logger.warn("file_token_fetch_skipped_missing_user_id", {
      event: "file_token_fetch_skipped_missing_user_id",
      service: "chat-handler",
      file_count: fileIds.length,
    });
    return {};
  }

  try {
    const tokens = await getConvexClient().query(
      api.fileStorage.getFileTokensByFileIds,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        fileIds,
      },
    );

    return Object.fromEntries(
      fileIds.map((id, i) => [id, tokens[i] || 0]),
    ) as Record<Id<"files">, number>;
  } catch (error) {
    logger.warn("file_token_fetch_failed", {
      event: "file_token_fetch_failed",
      service: "chat-handler",
      error: stringifyRedactedError(error),
      file_count: fileIds.length,
    });
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
  mode?: import("@/types").ChatMode,
  userId?: string,
): Promise<{
  messages: UIMessage[];
  fileTokens: Record<Id<"files">, number>;
}> => {
  const maxTokens = getMaxTokensForSubscription(subscription, { mode });
  const fileTokens = skipFileTokens
    ? {}
    : userId
      ? await getFileTokensByIds(
          extractAllFileIdsFromMessages(messages),
          userId,
        )
      : {};

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
  userId?: string,
): Promise<UIMessage[]> => {
  const maxTokens = getMaxTokensForSubscription(subscription);
  const fileTokens =
    precomputedFileTokens ||
    (userId
      ? await getFileTokensByIds(
          extractAllFileIdsFromMessages(messages),
          userId,
        )
      : {});

  return truncateMessagesToTokenLimit(messages, fileTokens, maxTokens);
};
