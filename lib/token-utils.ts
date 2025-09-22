import { UIMessage } from "ai";
import { countTokens, encode, decode } from "gpt-tokenizer";

export const MAX_TOKENS_PRO = 32000;
export const MAX_TOKENS_FREE = 16000;
export const MAX_TOKENS_ULTRA = 128000;

export type SubscriptionTier = "free" | "pro" | "ultra";

export const getMaxTokensForSubscription = (
  subscription: SubscriptionTier,
): number => {
  if (subscription === "ultra") return MAX_TOKENS_ULTRA;
  if (subscription === "pro") return MAX_TOKENS_PRO;
  return MAX_TOKENS_FREE;
};

// Token limits for different contexts
export const STREAM_MAX_TOKENS = 4096;
export const TOOL_DEFAULT_MAX_TOKENS = 4096;

// Truncation messages
export const TRUNCATION_MESSAGE = "\n\n[Output truncated because too long]";
export const FILE_READ_TRUNCATION_MESSAGE =
  "\n\n[Content truncated due to size limit. Use line ranges to read in chunks]";
export const TIMEOUT_MESSAGE = (seconds: number) =>
  `\n\nCommand output paused after ${seconds} seconds. Command continues in background.`;

/**
 * Extracts and counts tokens from message text and reasoning parts
 */
const getMessageTokenCount = (message: UIMessage): number => {
  const textContent = message.parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text || "")
    .join(" ");

  return countTokens(textContent);
};

/**
 * Extracts and counts tokens from message text, reasoning parts, and file tokens
 */
const getMessageTokenCountWithFiles = (
  message: UIMessage,
  fileTokens: Record<string, number> = {},
): number => {
  // Count text and reasoning tokens
  const textTokens = getMessageTokenCount(message);

  // Count file tokens
  const fileTokenCount = message.parts
    .filter((part) => part.type === "file")
    .reduce((total, part) => {
      const fileId = (part as any).fileId;
      return total + (fileId ? fileTokens[fileId] || 0 : 0);
    }, 0);

  return textTokens + fileTokenCount;
};

/**
 * Truncates messages to stay within token limit, keeping newest messages first
 */
export const truncateMessagesToTokenLimit = (
  messages: UIMessage[],
  fileTokens: Record<string, number> = {},
  maxTokens: number = MAX_TOKENS_PRO,
): UIMessage[] => {
  const tokenLimit = maxTokens;
  if (messages.length === 0) return messages;

  const result: UIMessage[] = [];
  let totalTokens = 0;

  // Process from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = getMessageTokenCountWithFiles(
      messages[i],
      fileTokens,
    );

    if (totalTokens + messageTokens > tokenLimit) break;

    totalTokens += messageTokens;
    result.unshift(messages[i]);
  }

  return result;
};

/**
 * Counts total tokens in all messages
 */
export const countMessagesTokens = (
  messages: UIMessage[],
  fileTokens: Record<string, number> = {},
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
