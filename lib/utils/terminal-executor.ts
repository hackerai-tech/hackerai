import { countTokens } from "gpt-tokenizer";
import {
  STREAM_MAX_TOKENS,
  TOOL_DEFAULT_MAX_TOKENS,
  TRUNCATION_MESSAGE,
  TIMEOUT_MESSAGE,
  truncateContent,
  sliceByTokens,
} from "@/lib/token-utils";

export type TerminalResult = {
  output?: string; // New combined output format
  stdout?: string; // Legacy format for backward compatibility
  stderr?: string; // Legacy format for backward compatibility
  exitCode?: number | null;
};

/**
 * Simple terminal output handler with token limits and timeout
 */
export const createTerminalHandler = (
  onOutput: (output: string) => void,
  options: {
    maxTokens?: number;
    timeoutSeconds?: number;
    onTimeout?: () => void;
  } = {},
) => {
  const { maxTokens = STREAM_MAX_TOKENS, timeoutSeconds, onTimeout } = options;

  let totalTokens = 0;
  let truncated = false;
  let timedOut = false;
  let combinedOutput = "";
  let timeoutId: NodeJS.Timeout | null = null;

  // Set timeout if specified
  if (timeoutSeconds && timeoutSeconds > 0 && onTimeout) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      onTimeout();
    }, timeoutSeconds * 1000);
  }

  const handleOutput = (output: string) => {
    // Accumulate output in chronological order
    combinedOutput += output;

    // Don't stream if truncated or timed out
    if (truncated || timedOut) return;

    const tokens = countTokens(output);
    if (totalTokens + tokens > maxTokens) {
      truncated = true;

      // Calculate how much content we can still fit
      const remainingTokens = maxTokens - totalTokens;
      const truncationTokens = countTokens(TRUNCATION_MESSAGE);

      if (remainingTokens > truncationTokens) {
        // We can fit some content plus the truncation message
        const contentBudget = remainingTokens - truncationTokens;
        const truncatedOutput = sliceByTokens(output, contentBudget);
        if (truncatedOutput.trim()) {
          onOutput(truncatedOutput);
          totalTokens += countTokens(truncatedOutput);
        }
      }

      onOutput(TRUNCATION_MESSAGE);
      return;
    }

    totalTokens += tokens;
    onOutput(output);
  };

  return {
    stdout: (output: string) => handleOutput(output),
    stderr: (output: string) => handleOutput(output),
    getResult: (pid?: number): TerminalResult => {
      const timeoutMsg = timedOut
        ? TIMEOUT_MESSAGE(timeoutSeconds || 0, pid)
        : "";
      let finalOutput = combinedOutput;
      if (timeoutMsg) {
        finalOutput += timeoutMsg;
      }

      const truncated = truncateTerminalOutput(finalOutput);
      return {
        output: truncated.output,
      };
    },
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
};

/**
 * Truncates terminal output to fit within token limits
 */
export function truncateTerminalOutput(output: string): TerminalResult {
  if (countTokens(output) <= TOOL_DEFAULT_MAX_TOKENS) {
    return { output };
  }
  return { output: truncateContent(output) };
}
