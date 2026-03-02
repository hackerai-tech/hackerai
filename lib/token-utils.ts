import { UIMessage, UIMessagePart } from "ai";
import type { ModelMessage } from "ai";
import { countTokens, encode, decode } from "gpt-tokenizer";
import type { SubscriptionTier } from "@/types";
import type { Id } from "@/convex/_generated/dataModel";

export const MAX_TOKENS_FREE = 16000;
export const MAX_TOKENS_PAID = 128000;
/**
 * Maximum total tokens allowed across all files
 */
export const MAX_TOKENS_FILE = 24000;

export const getMaxTokensForSubscription = (
  subscription: SubscriptionTier,
): number => {
  if (subscription === "free") return MAX_TOKENS_FREE;
  return MAX_TOKENS_PAID;
};

// Token limits for different contexts
export const STREAM_MAX_TOKENS = 4096;
export const TOOL_DEFAULT_MAX_TOKENS = 4096;

// Truncation messages
export const TRUNCATION_MESSAGE =
  "\n\n[... OUTPUT TRUNCATED - middle content removed ...]\n\n";
export const FILE_READ_TRUNCATION_MESSAGE =
  "\n\n[Content truncated due to size limit. Use line ranges to read in chunks]\n\n";
export const TIMEOUT_MESSAGE = (seconds: number, pid?: number) =>
  pid
    ? `\n\nCommand output paused after ${seconds} seconds. Command continues in background with PID: ${pid}`
    : `\n\nCommand output paused after ${seconds} seconds. Command continues in background.`;

export const FULL_OUTPUT_SAVED_MESSAGE = (
  filePath: string,
  charCount: number,
  capped?: boolean,
) =>
  capped
    ? `\n[Output too large - first ${charCount} chars saved to: ${filePath}]`
    : `\n[Full output (${charCount} chars) saved to: ${filePath}]`;

/**
 * Count tokens for a single message part, excluding providerMetadata/callProviderMetadata
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

  // For other part types, exclude provider metadata (e.g., OpenRouter reasoning_details)
  const partAny = part as any;
  const hasMetadata = partAny.providerMetadata || partAny.callProviderMetadata;

  if (hasMetadata) {
    const { providerMetadata, callProviderMetadata, ...partWithoutMetadata } =
      partAny;
    return countTokens(JSON.stringify(partWithoutMetadata));
  }

  return countTokens(JSON.stringify(part));
};

/**
 * Count tokens for a message, excluding step-start and reasoning parts
 */
const getMessageTokenCountWithFiles = (
  message: UIMessage,
  fileTokens: Record<Id<"files">, number> = {},
): number => {
  const partsWithoutReasoning = message.parts.filter(
    (part) => part.type !== "step-start" && part.type !== "reasoning",
  );

  const totalTokens = partsWithoutReasoning.reduce(
    (sum, part) => sum + countPartTokens(part, fileTokens),
    0,
  );

  return totalTokens;
};

/**
 * Truncates messages to stay within token limit, keeping newest messages first
 */
export const truncateMessagesToTokenLimit = (
  messages: UIMessage[],
  fileTokens: Record<Id<"files">, number> = {},
  maxTokens: number = MAX_TOKENS_FREE,
): UIMessage[] => {
  if (messages.length === 0) return messages;

  const result: UIMessage[] = [];
  let totalTokens = 0;

  // Process from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = getMessageTokenCountWithFiles(
      messages[i],
      fileTokens,
    );

    if (totalTokens + messageTokens > maxTokens) break;

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
  fileTokens: Record<Id<"files">, number> = {},
): number => {
  return messages.reduce(
    (total, message) =>
      total + getMessageTokenCountWithFiles(message, fileTokens),
    0,
  );
};

/**
 * Truncates content by token count using 25% head + 75% tail strategy.
 * This preserves both the command start (context) and the end (final results/errors),
 * which is typically more useful for debugging than keeping only the beginning.
 */
export const truncateContent = (
  content: string,
  marker: string = TRUNCATION_MESSAGE,
  maxTokens: number = TOOL_DEFAULT_MAX_TOKENS,
): string => {
  const tokens = encode(content);
  if (tokens.length <= maxTokens) return content;

  const markerTokens = countTokens(marker);
  if (maxTokens <= markerTokens) {
    return maxTokens <= 0 ? "" : decode(encode(marker).slice(-maxTokens));
  }

  const budgetForContent = maxTokens - markerTokens;

  // 25% head + 75% tail strategy
  const headBudget = Math.floor(budgetForContent * 0.25);
  const tailBudget = budgetForContent - headBudget;

  const headTokens = tokens.slice(0, headBudget);
  const tailTokens = tokens.slice(-tailBudget);

  return decode(headTokens) + marker + decode(tailTokens);
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

/**
 * Count tokens for a single ModelMessage.
 */
function countSingleModelMessageTokens(msg: ModelMessage): number {
  if (typeof msg.content === "string") {
    return countTokens(msg.content);
  }
  let total = 0;
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === "string") {
        total += countTokens(part);
      } else if (typeof part === "object" && part !== null) {
        if (
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          total += countTokens((part as { text: string }).text);
        } else {
          total += countTokens(JSON.stringify(part));
        }
      }
    }
  }
  return total;
}

/**
 * Returns true if the ModelMessage is a summary injection
 * (`<context_summary>` or `<step_summary>`).
 */
function isSummaryModelMessage(msg: ModelMessage): boolean {
  if (msg.role !== "user") return false;
  const textContent = getModelMessageLeadingText(msg);
  return (
    textContent.startsWith("<context_summary>") ||
    textContent.startsWith("<step_summary>")
  );
}

function getModelMessageLeadingText(msg: ModelMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  for (const part of msg.content) {
    if (typeof part === "string") return part;
    if (
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof (part as { text: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return "";
}

/**
 * Count tokens in ModelMessage[] — the actual messages sent to the LLM.
 */
export function countModelMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += countSingleModelMessageTokens(msg);
  }
  return total;
}

/**
 * Compute context usage breakdown from ModelMessage[] — separating summary
 * messages (`<context_summary>`, `<step_summary>`) from regular messages.
 * Use this to get accurate token counts from what is actually sent to the LLM.
 */
export function computeModelMessagesUsage(
  messages: ModelMessage[],
  systemTokens: number,
  maxTokens: number,
): {
  systemTokens: number;
  summaryTokens: number;
  messagesTokens: number;
  maxTokens: number;
} {
  let summaryTokens = 0;
  let messagesTokens = 0;
  for (const msg of messages) {
    const tokens = countSingleModelMessageTokens(msg);
    if (isSummaryModelMessage(msg)) {
      summaryTokens += tokens;
    } else {
      messagesTokens += tokens;
    }
  }
  return { systemTokens, summaryTokens, messagesTokens, maxTokens };
}
