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

// Max size for full output accumulation (5MB). Beyond this we stop buffering
// to avoid holding huge strings in memory. Output that exceeds this is lost.
const MAX_FULL_OUTPUT_CHARS = 5 * 1024 * 1024;

/**
 * Simple terminal output handler with token limits and timeout.
 * If onOutput returns a Promise, it is awaited so the run yields (e.g. for real-time stream delivery).
 */
export const createTerminalHandler = (
  onOutput: (output: string) => void | Promise<void>,
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
  // Use chunks array instead of string concatenation to avoid
  // creating increasingly large intermediate strings on each append
  const outputChunks: string[] = [];
  let totalChars = 0;
  let fullOutputCapped = false;
  let timeoutId: NodeJS.Timeout | null = null;

  // Set timeout if specified
  if (timeoutSeconds && timeoutSeconds > 0 && onTimeout) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      onTimeout();
    }, timeoutSeconds * 1000);
  }

  const handleOutput = async (output: string) => {
    // Accumulate output in chronological order, up to the memory cap
    if (!fullOutputCapped) {
      if (totalChars + output.length > MAX_FULL_OUTPUT_CHARS) {
        outputChunks.push(output.slice(0, MAX_FULL_OUTPUT_CHARS - totalChars));
        totalChars = MAX_FULL_OUTPUT_CHARS;
        fullOutputCapped = true;
      } else {
        outputChunks.push(output);
        totalChars += output.length;
      }
    }

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
          await onOutput(truncatedOutput);
          totalTokens += countTokens(truncatedOutput);
        }
      }

      await onOutput(TRUNCATION_MESSAGE);
      return;
    }

    totalTokens += tokens;
    await onOutput(output);
  };

  return {
    stdout: (output: string) => void handleOutput(output),
    stderr: (output: string) => void handleOutput(output),
    getResult: (pid?: number): TerminalResult => {
      const timeoutMsg = timedOut
        ? TIMEOUT_MESSAGE(timeoutSeconds || 0, pid)
        : "";
      let finalOutput = outputChunks.join("");
      if (timeoutMsg) {
        finalOutput += timeoutMsg;
      }

      const truncatedResult = truncateTerminalOutput(finalOutput);
      return {
        output: truncatedResult.output,
      };
    },
    /** Returns true if the output exceeded the token limit and was truncated */
    wasTruncated: (): boolean => truncated,
    /** Returns the full buffered output (for saving to file). May be capped at 5MB. */
    getFullOutput: (): string => outputChunks.join(""),
    /** Returns true if the full output exceeded the memory cap and was itself truncated */
    wasFullOutputCapped: (): boolean => fullOutputCapped,
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
