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
  stdout: string;
  stderr: string;
  exitCode?: number | null;
};

/**
 * Simple terminal output handler with token limits and timeout
 */
export const createTerminalHandler = (
  onOutput: (output: string, isStderr?: boolean) => void,
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
  let stdout = "";
  let stderr = "";
  let timeoutId: NodeJS.Timeout | null = null;

  // Set timeout if specified
  if (timeoutSeconds && timeoutSeconds > 0 && onTimeout) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      onTimeout();
    }, timeoutSeconds * 1000);
  }

  const handleOutput = (output: string, isStderr = false) => {
    // Always accumulate for final result
    if (isStderr) {
      stderr += output;
    } else {
      stdout += output;
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
          onOutput(truncatedOutput, isStderr);
          totalTokens += countTokens(truncatedOutput);
        }
      }

      onOutput(TRUNCATION_MESSAGE, isStderr);
      return;
    }

    totalTokens += tokens;
    onOutput(output, isStderr);
  };

  return {
    stdout: (output: string) => handleOutput(output, false),
    stderr: (output: string) => handleOutput(output, true),
    getResult: (): TerminalResult => {
      const timeoutMsg = timedOut ? TIMEOUT_MESSAGE(timeoutSeconds || 0) : "";
      const finalStderr = timeoutMsg ? `${stderr}${timeoutMsg}` : stderr;

      return truncateTerminalOutput(stdout, finalStderr);
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
export const truncateTerminalOutput = (
  stdout: string,
  stderr: string,
): TerminalResult => {
  const combined = stdout + stderr;
  if (countTokens(combined) <= TOOL_DEFAULT_MAX_TOKENS) {
    return { stdout, stderr };
  }

  // If only stdout, truncate it
  if (!stderr) {
    return { stdout: truncateContent(stdout), stderr: "" };
  }

  // If only stderr, truncate it
  if (!stdout) {
    return { stdout: "", stderr: truncateContent(stderr) };
  }

  // Both present - split budget proportionally with minimum allocation
  const stdoutTokens = countTokens(stdout);
  const stderrTokens = countTokens(stderr);
  const totalTokens = stdoutTokens + stderrTokens;
  const truncMsgTokens = countTokens(TRUNCATION_MESSAGE);
  const budget = TOOL_DEFAULT_MAX_TOKENS - truncMsgTokens;

  if (budget <= 0) return { stdout: "", stderr: TRUNCATION_MESSAGE };

  const minTokens = Math.min(200, Math.floor(budget / 4));
  let stdoutBudget = Math.floor((stdoutTokens / totalTokens) * budget);
  let stderrBudget = budget - stdoutBudget;

  // Ensure minimum allocation
  if (stdoutBudget < minTokens) {
    stdoutBudget = Math.min(minTokens, stdoutTokens, budget - minTokens);
    stderrBudget = budget - stdoutBudget;
  }
  if (stderrBudget < minTokens) {
    stderrBudget = Math.min(minTokens, stderrTokens, budget - minTokens);
    stdoutBudget = budget - stderrBudget;
  }

  const truncatedStdout = sliceByTokens(stdout, stdoutBudget);
  const truncatedStderr = sliceByTokens(stderr, stderrBudget);

  return {
    stdout: truncatedStdout,
    stderr: `${truncatedStderr}${TRUNCATION_MESSAGE}`,
  };
};
