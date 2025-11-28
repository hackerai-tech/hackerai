import type { AnySandbox } from "@/types";

/**
 * Attempts to find the PID of a running process by command name.
 * Uses pgrep as the primary method with ps as a fallback.
 *
 * @param sandbox - The sandbox instance (E2B or ConvexSandbox)
 * @param command - The full command string
 * @returns Promise<number | null> - The PID if found, null otherwise
 */
export async function findProcessPid(
  sandbox: AnySandbox,
  command: string,
): Promise<number | null> {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    console.warn("[PID Discovery] Command string empty after trimming");
    return null;
  }

  // Use a meaningful portion of the command for better matching
  // Limit to first 100 chars to avoid issues with very long commands
  const searchPattern = normalizedCommand.slice(0, 100);
  // Escape single quotes for shell safety: replace ' with '\''
  const escapedPattern = searchPattern.replace(/'/g, "'\\''");

  try {
    // Try pgrep with full command pattern (more accurate than just first word)
    // pgrep -f matches against the full command line
    const pgrepResult = await sandbox.commands.run(
      `pgrep -f '${escapedPattern}'`,
      {
        timeoutMs: 5000, // 5 second timeout for PID discovery
      },
    );

    if (pgrepResult.stdout?.trim()) {
      const pids = pgrepResult.stdout
        .trim()
        .split("\n")
        .map((p) => parseInt(p.trim()))
        .filter((p) => !isNaN(p));

      if (pids.length > 0) {
        // Get the most recent PID (highest number, likely the actual process vs parent shells)
        const pid = Math.max(...pids);
        return pid;
      }
    }
  } catch (error) {
    // pgrep failure is expected when process has already finished - don't log as warning
    // Fallback: use ps with full command line matching
    try {
      // ps -eo pid,cmd shows PID and full command
      // This is more accurate than ps aux which truncates commands
      const psResult = await sandbox.commands.run(
        `ps -eo pid,cmd | grep '${escapedPattern}' | grep -v grep | awk '{print $1}' | head -1`,
        {
          timeoutMs: 5000, // 5 second timeout for PID discovery
        },
      );

      if (psResult.stdout?.trim()) {
        const pid = parseInt(psResult.stdout.trim());
        if (!isNaN(pid)) {
          return pid;
        }
      }
    } catch (psError) {
      // Both methods failing means process already finished - this is normal, not an error
    }
  }

  // Process not found - likely already finished, which is normal
  return null;
}
