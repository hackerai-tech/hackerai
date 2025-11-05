import type { Sandbox } from "@e2b/code-interpreter";

/**
 * Attempts to find the PID of a running process by command name.
 * Uses pgrep as the primary method with ps as a fallback.
 *
 * @param sandbox - The E2B sandbox instance
 * @param command - The full command string
 * @returns Promise<number | null> - The PID if found, null otherwise
 */
export async function findProcessPid(
  sandbox: Sandbox,
  command: string,
): Promise<number | null> {
  const commandFirstWord = command.split(" ")[0];

  try {
    // Try pgrep first (most reliable)
    const pgrepResult = await sandbox.commands.run(
      `pgrep -f "${commandFirstWord}"`,
      {
        user: "root" as const,
        cwd: "/home/user",
      },
    );

    if (pgrepResult.stdout?.trim()) {
      const pids = pgrepResult.stdout
        .trim()
        .split("\n")
        .map((p) => parseInt(p.trim()))
        .filter((p) => !isNaN(p));

      if (pids.length > 0) {
        // Get the most recent PID (highest number)
        const pid = Math.max(...pids);
        console.log(
          `[PID Discovery] Found process '${commandFirstWord}' with PID ${pid}`,
        );
        return pid;
      }
    }
  } catch (error) {
    console.warn(
      `[PID Discovery] pgrep failed for '${commandFirstWord}':`,
      error,
    );

    // Fallback: try using ps
    try {
      const psResult = await sandbox.commands.run(
        `ps aux | grep "${commandFirstWord}" | grep -v grep | awk '{print $2}' | head -1`,
        {
          user: "root" as const,
          cwd: "/home/user",
        },
      );

      if (psResult.stdout?.trim()) {
        const pid = parseInt(psResult.stdout.trim());
        if (!isNaN(pid)) {
          console.log(
            `[PID Discovery] Found process '${commandFirstWord}' with PID ${pid} (using ps fallback)`,
          );
          return pid;
        }
      }
    } catch (psError) {
      console.error(
        `[PID Discovery] Both pgrep and ps failed for '${commandFirstWord}'`,
      );
    }
  }

  console.warn(`[PID Discovery] Could not find PID for '${commandFirstWord}'`);
  return null;
}
