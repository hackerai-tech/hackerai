import { UIMessage } from "ai";
import { countTokens, encode, decode } from "gpt-tokenizer";

const MAX_TOKENS = 32000;

// Token limits for different contexts
export const STREAM_MAX_TOKENS = 2048;
export const TOOL_DEFAULT_MAX_TOKENS = 4096;

// Truncation message
const TRUNCATION_MESSAGE = "...\n\n[Output truncated because too long]";
const FILE_READ_TRUNCATION_MESSAGE =
  "\n\n[Content truncated due to size limit. Use line ranges to read in chunks]";

/**
 * Extracts and counts tokens from message text and reasoning parts
 */
const getMessageTokenCount = (message: UIMessage): number => {
  const textContent = message.parts
    .filter(
      (part: { type: string; text?: string }) =>
        part.type === "text" || part.type === "reasoning",
    )
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

/**
 * Truncates content by token count to stay within specified limits
 * @param output - The content to truncate
 * @param maxTokens - Maximum number of tokens allowed (defaults to TOOL_DEFAULT_MAX_TOKENS)
 * @returns Truncated content with appropriate message if truncation occurred
 */
export const truncateContentByTokens = (
  output: string,
  tool: string,
): string => {
  const truncationMessage =
    tool === "read-file" ? FILE_READ_TRUNCATION_MESSAGE : TRUNCATION_MESSAGE;
  const tokens = encode(output);

  if (tokens.length <= TOOL_DEFAULT_MAX_TOKENS) {
    return output;
  }

  // Reserve tokens for truncation message
  const truncationTokens = countTokens(truncationMessage);
  const availableTokens = TOOL_DEFAULT_MAX_TOKENS - truncationTokens;

  // Split available tokens between beginning and end (60% start, 40% end)
  const startTokens = Math.floor(availableTokens * 0.6);
  const endTokens = availableTokens - startTokens;

  const startPart = decode(tokens.slice(0, startTokens));
  const endPart = decode(tokens.slice(-endTokens));

  return `${startPart}${truncationMessage}${endPart}`;
};

/**
 * Creates a token-aware handler that tracks cumulative tokens and truncates when limit is reached
 * @param originalHandler - The original handler function to wrap
 * @param maxTokens - Maximum tokens allowed (defaults to STREAM_MAX_TOKENS)
 * @returns Object with the wrapped handler and truncation state
 */
export const createTokenAwareHandler = (
  originalHandler: (output: string) => void,
  maxTokens: number = STREAM_MAX_TOKENS,
) => {
  let totalTokens = 0;
  let truncated = false;

  const handler = (output: string) => {
    if (truncated) return;

    const outputTokens = countTokens(output);
    if (totalTokens + outputTokens > maxTokens) {
      truncated = true;
      originalHandler(TRUNCATION_MESSAGE);
      return;
    }

    totalTokens += outputTokens;
    originalHandler(output);
  };

  return {
    handler,
    getTotalTokens: () => totalTokens,
    isTruncated: () => truncated,
  };
};

/**
 * Creates shared token-aware handlers for stdout and stderr that share the same token limit
 * @param stdoutHandler - The original stdout handler function
 * @param stderrHandler - The original stderr handler function
 * @param maxTokens - Maximum tokens allowed for combined output (defaults to STREAM_MAX_TOKENS)
 * @returns Object with wrapped handlers and shared truncation state
 */
export const createSharedTokenAwareHandlers = (
  stdoutHandler: (output: string) => void,
  stderrHandler: (output: string) => void,
  maxTokens: number = STREAM_MAX_TOKENS,
) => {
  let totalTokens = 0;
  let truncated = false;

  const createHandler = (originalHandler: (output: string) => void) => {
    return (output: string) => {
      if (truncated) return;

      const outputTokens = countTokens(output);
      if (totalTokens + outputTokens > maxTokens) {
        truncated = true;
        originalHandler(TRUNCATION_MESSAGE);
        return;
      }

      totalTokens += outputTokens;
      originalHandler(output);
    };
  };

  return {
    stdoutHandler: createHandler(stdoutHandler),
    stderrHandler: createHandler(stderrHandler),
    getTotalTokens: () => totalTokens,
    isTruncated: () => truncated,
  };
};

/**
 * Truncates combined stdout and stderr content by token count
 * @param stdout - The stdout content
 * @param stderr - The stderr content
 * @param tool - The tool name for appropriate truncation message
 * @returns Object with truncated stdout and stderr
 */
export const truncateCombinedOutput = (
  stdout: string,
  stderr: string,
  tool: string,
): { stdout: string; stderr: string } => {
  const combinedContent = stdout + stderr;
  const combinedTokens = countTokens(combinedContent);

  if (combinedTokens <= TOOL_DEFAULT_MAX_TOKENS) {
    return { stdout, stderr };
  }

  // If combined content exceeds limit, truncate proportionally
  const stdoutTokens = countTokens(stdout);
  const stderrTokens = countTokens(stderr);

  if (stdoutTokens === 0) {
    return {
      stdout: "",
      stderr: truncateContentByTokens(stderr, tool),
    };
  }

  if (stderrTokens === 0) {
    return {
      stdout: truncateContentByTokens(stdout, tool),
      stderr: "",
    };
  }

  // Proportional truncation
  const stdoutRatio = stdoutTokens / combinedTokens;
  const stderrRatio = stderrTokens / combinedTokens;

  const maxStdoutTokens = Math.floor(TOOL_DEFAULT_MAX_TOKENS * stdoutRatio);
  const maxStderrTokens = TOOL_DEFAULT_MAX_TOKENS - maxStdoutTokens;

  const truncationMessage =
    tool === "read-file" ? FILE_READ_TRUNCATION_MESSAGE : TRUNCATION_MESSAGE;

  const truncateToLimit = (content: string, limit: number): string => {
    const tokens = encode(content);
    if (tokens.length <= limit) return content;

    // Reserve tokens for truncation message
    const truncationTokens = countTokens(truncationMessage);
    const availableTokens = limit - truncationTokens;

    // Split available tokens between beginning and end (60% start, 40% end)
    const startTokens = Math.floor(availableTokens * 0.6);
    const endTokens = availableTokens - startTokens;

    const startPart = decode(tokens.slice(0, startTokens));
    const endPart = decode(tokens.slice(-endTokens));

    return `${startPart}${truncationMessage}${endPart}`;
  };

  return {
    stdout: truncateToLimit(stdout, maxStdoutTokens),
    stderr: truncateToLimit(stderr, maxStderrTokens),
  };
};
