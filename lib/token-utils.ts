import { UIMessage } from "ai";
import { countTokens, encode, decode } from "gpt-tokenizer";
import type { SubscriptionTier } from "@/types";

export const MAX_TOKENS_FREE = 16000;
export const MAX_TOKENS_PRO = 32000;
export const MAX_TOKENS_ULTRA = 100000;
/**
 * Maximum total tokens allowed across all files
 */
export const MAX_TOKENS_FILE = 24000;

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
  maxTokens: number = MAX_TOKENS_FREE,
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

// =====================
// Step-level token utils for model messages
// =====================

type ModelMessage = {
  role: string;
  content: any;
};

const extractTextFromModelContent = (content: any): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part?.text === "string"
            ? part.text
            : "",
      )
      .join(" ");
  }
  if (content && typeof content === "object") {
    if (typeof (content as any).text === "string") return (content as any).text;
  }
  return "";
};

export const countModelMessagesTokens = (messages: Array<ModelMessage>): number => {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return messages.reduce((total, msg) => {
    const text = extractTextFromModelContent((msg as any).content);
    return total + countTokens(text);
  }, 0);
};

export const truncateModelMessagesToTokenLimit = (
  messages: Array<ModelMessage>,
  maxTokens: number,
  preserveLastN: number = 2,
): Array<ModelMessage> => {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (preserveLastN < 0) preserveLastN = 0;

  // Identify leading system messages (keep contiguous systems at the start)
  let systemCount = 0;
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as any).role === "system") systemCount++;
    else break;
  }

  const systemMsgs = messages.slice(0, systemCount);
  const tailMsgs = preserveLastN > 0 ? messages.slice(-preserveLastN) : [];
  const middleMsgs = messages.slice(systemCount, messages.length - tailMsgs.length);

  // Base tokens: system + tail (always keep these)
  let kept: Array<ModelMessage> = [...systemMsgs];
  let baseTokens = countModelMessagesTokens([...systemMsgs, ...tailMsgs]);

  // If base already exceeds budget, still return system + tail to preserve context
  if (baseTokens >= maxTokens) {
    return [...systemMsgs, ...tailMsgs];
  }

  // Fill remaining budget from the most recent middle messages backwards
  const keptMiddle: Array<ModelMessage> = [];
  for (let i = middleMsgs.length - 1; i >= 0; i--) {
    const candidate = middleMsgs[i];
    const candidateTokens = countModelMessagesTokens([candidate]);
    if (baseTokens + candidateTokens <= maxTokens) {
      keptMiddle.push(candidate);
      baseTokens += candidateTokens;
    } else {
      break;
    }
  }

  kept.push(...keptMiddle.reverse());
  kept.push(...tailMsgs);

  return kept;
};
