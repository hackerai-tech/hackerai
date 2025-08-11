import { UIMessage } from "ai";
import { countTokens } from "gpt-tokenizer";

const MAX_TOKENS = 32000;

/**
 * Extracts and counts tokens from message text and reasoning parts
 */
const getMessageTokenCount = (message: UIMessage): number => {
  const textContent = message.parts
    .filter((part: { type: string; text?: string }) => part.type === "text" || part.type === "reasoning")
    .map((part: { type: string; text?: string }) => part.text || "")
    .join(" ");

  return countTokens(textContent);
};

/**
 * Truncates messages to stay within token limit, keeping newest messages first
 */
export const truncateMessagesToTokenLimit = (
  messages: UIMessage[],
  maxTokens: number = MAX_TOKENS,
): UIMessage[] => {
  if (messages.length === 0) return messages;

  const result: UIMessage[] = [];
  let totalTokens = 0;

  // Process from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = getMessageTokenCount(messages[i]);

    if (totalTokens + messageTokens > maxTokens) break;

    totalTokens += messageTokens;
    result.unshift(messages[i]);
  }

  return result;
};

/**
 * Counts total tokens in all messages
 */
export const countMessagesTokens = (messages: UIMessage[]): number => {
  return messages.reduce(
    (total, message) => total + getMessageTokenCount(message),
    0,
  );
};
