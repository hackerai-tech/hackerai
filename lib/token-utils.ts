import { UIMessage, UIMessagePart } from "ai";
import { countTokens, encode, decode } from "gpt-tokenizer";
import type { SubscriptionTier } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";

export const MAX_TOKENS_FREE = 16000;
export const MAX_TOKENS_PRO_AND_TEAM = 32000;
export const MAX_TOKENS_ULTRA = 100000;
/**
 * Maximum total tokens allowed across all files
 */
export const MAX_TOKENS_FILE = 24000;

export const getMaxTokensForSubscription = (
  subscription: SubscriptionTier,
): number => {
  if (subscription === "ultra") return MAX_TOKENS_ULTRA;
  if (subscription === "pro" || subscription === "team")
    return MAX_TOKENS_PRO_AND_TEAM;
  return MAX_TOKENS_FREE;
};

// Token limits for different contexts
export const STREAM_MAX_TOKENS = 2048;
export const TOOL_DEFAULT_MAX_TOKENS = 2048;

// Truncation messages
export const TRUNCATION_MESSAGE = "\n\n[Output truncated because too long]";
export const FILE_READ_TRUNCATION_MESSAGE =
  "\n\n[Content truncated due to size limit. Use line ranges to read in chunks]";
export const TIMEOUT_MESSAGE = (seconds: number) =>
  `\n\nCommand output paused after ${seconds} seconds. Command continues in background.`;

/**
 * Count tokens for a single message part
 */
const countPartTokens = (
  part: UIMessagePart<any, any>,
  fileTokens: Record<Id<"files">, number> = {},
): number => {
  if (part.type === "text" && "text" in part) {
    return countTokens((part as { text?: string }).text || "");
  }
  if (
    part.type === "file" &&
    "fileId" in part &&
    (part as { fileId?: Id<"files"> }).fileId
  ) {
    const fileId = (part as { fileId: Id<"files"> }).fileId;
    return fileTokens[fileId] || 0;
  }
  // For tool-call, tool-result, and other part types, count their JSON structure
  return countTokens(JSON.stringify(part));
};

/**
 * Extracts and counts tokens from message text and file tokens (excluding reasoning blocks)
 */
const getMessageTokenCountWithFiles = (
  message: UIMessage,
  fileTokens: Record<Id<"files">, number> = {},
): number => {
  // Filter out reasoning blocks before counting tokens
  const partsWithoutReasoning = message.parts.filter(
    (part) => part.type !== "step-start" && part.type !== "reasoning",
  );

  // Count tokens for all parts
  const totalTokens = partsWithoutReasoning.reduce(
    (sum, part) => sum + countPartTokens(part, fileTokens),
    0,
  );

  return totalTokens;
};

/**
 * Checks if a part is a tool result (including custom tool types)
 * Tool results can be:
 * - Standard: type === "tool-result"
 * - Custom tools: type starts with "tool-" but not "tool-call"
 */
const isToolResultPart = (part: UIMessagePart<any, any>): boolean => {
  const type = part.type;

  if (type === "tool-result") return true;

  if (
    typeof type === "string" &&
    type.startsWith("tool-") &&
    type !== "tool-call"
  ) {
    return true;
  }

  return false;
};

/**
 * Strips tool results from a message, keeping tool calls and other content
 * This preserves conversation flow while reducing token usage
 */
const stripToolResultsFromMessage = (message: UIMessage): UIMessage => {
  const strippedParts = message.parts.map((part) => {
    if (isToolResultPart(part)) {
      const stripped = { ...part };
      const strippedAny = stripped as any;

      const placeholder = "[removed]";

      if (strippedAny.result !== undefined) {
        strippedAny.result = placeholder;
      }
      if (strippedAny.content !== undefined) {
        strippedAny.content = placeholder;
      }
      if (strippedAny.text !== undefined) {
        strippedAny.text = placeholder;
      }
      if (strippedAny.output !== undefined) {
        strippedAny.output = placeholder;
      }
      if (strippedAny.state !== undefined) {
        strippedAny.state = "completed";
      }

      return stripped;
    }
    return part;
  });

  return {
    ...message,
    parts: strippedParts,
  };
};

/**
 * Truncates messages to stay within token limit, keeping newest messages first
 * Also tries stripping tool results from older messages before dropping them entirely
 */
export const truncateMessagesToTokenLimit = (
  messages: UIMessage[],
  fileTokens: Record<Id<"files">, number> = {},
  maxTokens: number = MAX_TOKENS_FREE,
): UIMessage[] => {
  if (messages.length === 0) return messages;

  // Calculate total tokens in all messages before truncation
  const totalTokensBeforeTruncation = countMessagesTokens(messages, fileTokens);

  // If we're already under budget, no need to truncate
  if (totalTokensBeforeTruncation <= maxTokens) {
    return messages;
  }

  const result: UIMessage[] = [];
  let totalTokens = 0;

  // First pass: Process from newest to oldest, keeping messages intact
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = getMessageTokenCountWithFiles(
      messages[i],
      fileTokens,
    );

    if (totalTokens + messageTokens > maxTokens) break;

    totalTokens += messageTokens;
    result.unshift(messages[i]);
  }

  // If we dropped messages, try to fit more messages by stripping tool results
  // This preserves conversation context for all users
  const droppedMessageCount = messages.length - result.length;

  if (droppedMessageCount > 0) {
    // Try adding back dropped messages with tool results stripped
    const droppedMessages = messages.slice(0, droppedMessageCount);
    const additionalMessages: UIMessage[] = [];

    // Process dropped messages from newest to oldest (closest to our result)
    for (let i = droppedMessages.length - 1; i >= 0; i--) {
      const originalMessage = droppedMessages[i];
      const strippedMessage = stripToolResultsFromMessage(originalMessage);
      const messageTokens = getMessageTokenCountWithFiles(
        strippedMessage,
        fileTokens,
      );

      // Only add if it fits in our remaining budget
      if (totalTokens + messageTokens <= maxTokens) {
        totalTokens += messageTokens;
        additionalMessages.unshift(strippedMessage);
      } else {
        // No more room even with stripped results
        break;
      }
    }

    if (additionalMessages.length > 0) {
      result.unshift(...additionalMessages);
    }
  }

  return result;
};

/**
 * Counts total tokens in all messages
 */
export const countMessagesTokens = (
  messages: UIMessage[],
  fileTokens: Record<Id<"files">, number> = {},
): number => {
  return messages.reduce(
    (total, message) =>
      total + getMessageTokenCountWithFiles(message, fileTokens),
    0,
  );
};

/**
 * Truncates content by token count to stay within specified limits
 */
export const truncateContent = (
  content: string,
  suffix: string = TRUNCATION_MESSAGE,
): string => {
  const tokens = encode(content);
  if (tokens.length <= TOOL_DEFAULT_MAX_TOKENS) return content;

  const suffixTokens = countTokens(suffix);
  if (TOOL_DEFAULT_MAX_TOKENS <= suffixTokens) {
    return TOOL_DEFAULT_MAX_TOKENS <= 0
      ? ""
      : decode(encode(suffix).slice(-TOOL_DEFAULT_MAX_TOKENS));
  }

  const budgetForContent = TOOL_DEFAULT_MAX_TOKENS - suffixTokens;
  return decode(tokens.slice(0, budgetForContent)) + suffix;
};

/**
 * Slices content to fit within a specific token budget
 */
export const sliceByTokens = (content: string, maxTokens: number): string => {
  if (maxTokens <= 0) return "";

  const tokens = encode(content);
  if (tokens.length <= maxTokens) return content;

  return decode(tokens.slice(0, maxTokens));
};

/**
 * Counts tokens for user input including text and uploaded files
 */
export const countInputTokens = (
  input: string,
  uploadedFiles: Array<{ tokens?: number }> = [],
): number => {
  const textTokens = countTokens(input);
  const fileTokens = uploadedFiles.reduce(
    (total, file) => total + (file.tokens || 0),
    0,
  );
  return textTokens + fileTokens;
};

/**
 * Legacy wrapper for backward compatibility
 */
export function truncateOutput(args: {
  content: string;
  mode?: "read-file" | "generic";
}): string {
  const { content, mode } = args;
  const suffix =
    mode === "read-file" ? FILE_READ_TRUNCATION_MESSAGE : TRUNCATION_MESSAGE;
  return truncateContent(content, suffix);
}
