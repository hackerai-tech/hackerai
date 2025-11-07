import type { Sandbox } from "@e2b/code-interpreter";
import { retryWithBackoff } from "./retry-with-backoff";

/**
 * Wait for sandbox to become available and ready to execute commands.
 *
 * Performs both status check AND actual command execution test to ensure
 * sandbox is truly ready, not just "running" but unresponsive.
 *
 * @param sandbox - Sandbox instance to check
 * @param maxRetries - Maximum number of health check attempts (default: 5)
 * @returns Promise that resolves when sandbox is ready
 * @throws Error if sandbox doesn't become ready after all retries
 */
export async function waitForSandboxReady(
  sandbox: Sandbox,
  maxRetries: number = 5,
): Promise<void> {
  await retryWithBackoff(
    async () => {
      // First check if sandbox is running
      const running = await sandbox.isRunning();
      if (!running) {
        throw new Error("Sandbox is not running");
      }

      // Then verify it can actually execute commands with a simple test
      try {
        await sandbox.commands.run("echo ready", {
          user: "root" as const,
          cwd: "/home/user",
          timeoutMs: 3000, // 3 second timeout for health check
        });
      } catch (error) {
        throw new Error(
          `Sandbox running but not ready to execute commands: ${error instanceof Error ? error.message : error}`,
        );
      }
    },
    {
      maxRetries,
      baseDelayMs: 1000, // 1s, 2s, 4s, 8s, 16s (~31s total for 5 retries)
      jitterMs: 100,
      isPermanentError: () => false, // Retry all errors - sandbox might be starting
      logger: (message, error) => {
        // Only log final failure (when it gives up)
        if (message.includes("failed after")) {
          console.error(`[Sandbox Health] ${message}`, error);
        }
      },
    },
  );
}
