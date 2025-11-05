import type { Sandbox } from "@e2b/code-interpreter";

/**
 * Verifies that a process has been terminated by checking if it still exists.
 * Uses the `ps -p ${pid}` command pattern established in BackgroundProcessTracker.
 *
 * @param sandbox - The E2B sandbox instance
 * @param pid - Process ID to check
 * @param maxAttempts - Number of verification attempts (default: 3)
 * @param delayMs - Delay between attempts in milliseconds (default: 100)
 * @returns Promise<boolean> - true if process is terminated, false if still running
 */
export async function verifyProcessTerminated(
  sandbox: Sandbox,
  pid: number,
  maxAttempts: number = 3,
  delayMs: number = 100,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await sandbox.commands.run(`ps -p ${pid}`, {
        user: "root" as const,
        cwd: "/home/user",
      });

      // Process is still running if PID appears in output
      const isRunning = result.stdout.includes(pid.toString());

      if (!isRunning) {
        if (attempt > 1) {
          console.log(
            `[Process Termination] PID ${pid}: Verified terminated after ${attempt} attempts`,
          );
        }
        return true; // Process successfully terminated
      }

      // Wait before next attempt (skip delay on last attempt)
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      // Command error usually means process doesn't exist
      console.log(
        `[Process Termination] PID ${pid}: Process not found (attempt ${attempt})`,
      );
      return true;
    }
  }

  console.warn(
    `[Process Termination] PID ${pid}: Still running after ${maxAttempts} verification attempts`,
  );
  return false; // Process still running
}

/**
 * Force kills a process using SIGKILL via E2B's native kill command.
 * This is the fallback when graceful termination fails.
 *
 * @param sandbox - The E2B sandbox instance
 * @param pid - Process ID to force kill
 * @returns Promise<boolean> - true if kill command succeeded, false otherwise
 */
export async function forceKillProcess(
  sandbox: Sandbox,
  pid: number,
): Promise<boolean> {
  try {
    console.log(`[Process Termination] PID ${pid}: Attempting force kill (SIGKILL)`);

    // Use E2B's native kill method which uses SIGKILL
    const killed = await sandbox.commands.kill(pid);

    if (killed) {
      console.log(`[Process Termination] PID ${pid}: Force kill successful`);
    } else {
      console.warn(
        `[Process Termination] PID ${pid}: Force kill returned false (process may not exist)`,
      );
    }

    return killed;
  } catch (error) {
    console.error(
      `[Process Termination] PID ${pid}: Force kill failed:`,
      error,
    );
    return false;
  }
}

/**
 * Attempts to terminate a process with verification and fallback.
 * First tries graceful kill, then verifies, then force kills if needed.
 *
 * @param sandbox - The E2B sandbox instance
 * @param execution - The execution object with kill() method (optional for foreground commands)
 * @param pid - Process ID (if available)
 * @returns Promise<void>
 */
export async function terminateProcessReliably(
  sandbox: Sandbox,
  execution: any,
  pid: number | null | undefined,
): Promise<void> {
  // If we have PID but no execution object (foreground commands during abort), use direct kill
  if (pid && (!execution || !execution.kill)) {
    console.log(
      `[Process Termination] PID ${pid}: No execution handle, using direct kill`,
    );
    await forceKillProcess(sandbox, pid);
    const finalCheck = await verifyProcessTerminated(sandbox, pid, 2, 150);
    if (!finalCheck) {
      console.error(
        `[Process Termination] PID ${pid}: Process still running after direct kill!`,
      );
    }
    return;
  }

  // If no way to kill, nothing to do
  if (!execution || !execution.kill) {
    console.log(
      "[Process Termination] No execution object, kill method, or PID available",
    );
    return;
  }

  try {
    // Step 1: Try graceful kill via execution.kill()
    console.log(
      `[Process Termination] ${pid ? `PID ${pid}` : "Unknown PID"}: Attempting graceful kill`,
    );
    await execution.kill();

    // Step 2: If we have a PID, verify termination
    if (pid) {
      const isTerminated = await verifyProcessTerminated(sandbox, pid);

      // Step 3: If still running, force kill
      if (!isTerminated) {
        console.warn(
          `[Process Termination] PID ${pid}: Graceful kill failed, using force kill`,
        );
        await forceKillProcess(sandbox, pid);

        // Final verification after force kill
        const finalCheck = await verifyProcessTerminated(sandbox, pid, 2, 150);
        if (!finalCheck) {
          console.error(
            `[Process Termination] PID ${pid}: Process still running after force kill!`,
          );
        }
      } else {
        console.log(
          `[Process Termination] PID ${pid}: Graceful kill succeeded`,
        );
      }
    } else {
      console.log(
        "[Process Termination] No PID available for verification, graceful kill attempted",
      );
    }
  } catch (error) {
    console.error(
      `[Process Termination] ${pid ? `PID ${pid}` : "Unknown PID"}: Error during termination:`,
      error,
    );

    // Last resort: try force kill if we have a PID
    if (pid) {
      try {
        await forceKillProcess(sandbox, pid);
      } catch (forceError) {
        console.error(
          `[Process Termination] PID ${pid}: Force kill also failed:`,
          forceError,
        );
      }
    }
  }
}
