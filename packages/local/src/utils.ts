/**
 * Utility functions for the local sandbox client.
 * Extracted for testability.
 */

// Align with LLM context limits (~4096 tokens ≈ 12288 chars)
export const MAX_OUTPUT_SIZE = 12288;

// Truncation marker for 25% head + 75% tail strategy
export const TRUNCATION_MARKER =
  "\n\n[... OUTPUT TRUNCATED - middle content removed to fit context limits ...]\n\n";

/**
 * Truncates output using 25% head + 75% tail strategy.
 * This preserves both the command start (context) and the end (final results/errors).
 */
export function truncateOutput(
  content: string,
  maxSize: number = MAX_OUTPUT_SIZE,
): string {
  if (content.length <= maxSize) return content;

  const markerLength = TRUNCATION_MARKER.length;
  const budgetForContent = maxSize - markerLength;

  // 25% head + 75% tail strategy
  const headBudget = Math.floor(budgetForContent * 0.25);
  const tailBudget = budgetForContent - headBudget;

  const head = content.slice(0, headBudget);
  const tail = content.slice(-tailBudget);

  return head + TRUNCATION_MARKER + tail;
}

export interface ShellConfig {
  shell: string;
  shellFlag: string;
}

/**
 * Get the default shell for a given platform.
 * On Windows, uses cmd.exe (not PowerShell, which aliases curl to Invoke-WebRequest
 * and breaks POSIX-style flags like -fsSL). On Unix-like systems, uses bash.
 */
export function getDefaultShell(platform: string): ShellConfig {
  if (platform === "win32") {
    return { shell: "cmd.exe", shellFlag: "/C" };
  }
  // Unix-like systems (Linux, macOS, etc.)
  return { shell: "/bin/bash", shellFlag: "-c" };
}
