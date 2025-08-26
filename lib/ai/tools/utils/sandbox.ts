import { Sandbox } from "@e2b/code-interpreter";
import { safeWaitUntil } from "@/lib/utils/safe-wait-until";

/**
 * Creates or connects to a persistent sandbox instance
 * Reuses existing sandboxes when possible to maintain state and improve performance
 *
 * @param userID - User identifier for sandbox ownership
 * @param template - Sandbox environment template name
 * @param timeoutMs - Operation timeout in milliseconds
 * @returns Connected or newly created sandbox instance
 *
 * Flow:
 * 1. Lists existing sandboxes for the user
 * 2a. If found with "running" state: pause first (3 retries), then resume
 * 2b. If found with "paused" state: resume directly (no retries needed)
 * 3. Pause operations use 5-second delays between retry attempts
 * 4. If pause fails after retries or no sandbox found, creates new one
 * 5. Returns active sandbox ready for use
 */
export async function createOrConnectPersistentTerminal(
  userID: string,
  template: string,
  timeoutMs: number,
): Promise<Sandbox> {
  try {
    // Step 1: Look for existing sandbox for this user
    const paginator = Sandbox.list({
      query: {
        metadata: {
          userID,
          template,
        },
      },
    });
    const existingSandbox = (await paginator.nextItems())[0];

    // Step 2: Try to reuse existing sandbox if available
    if (existingSandbox?.sandboxId) {
      const currentState = existingSandbox.state;

      if (currentState === "running") {
        // Step 3a: If running, get sandbox instance first, then pause and resume
        try {
          // First, connect to the running sandbox
          const runningSandbox = await Sandbox.connect(
            existingSandbox.sandboxId,
          );

          // Try to pause with retry logic
          let pauseSuccess = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await runningSandbox.betaPause();
              pauseSuccess = true;
              break;
            } catch (error) {
              console.warn(
                `[${userID}] Sandbox pause attempt ${attempt}/3 failed:`,
                error,
              );

              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
              }
            }
          }

          if (!pauseSuccess) {
            console.error(
              `[${userID}] Failed to pause sandbox after 3 attempts, creating new one`,
            );
            // Fall through to create new sandbox
          } else {
            // Now resume the paused sandbox
            const sandbox = await Sandbox.connect(existingSandbox.sandboxId, {
              timeoutMs,
            });
            return sandbox;
          }
        } catch (error) {
          console.error(
            `[${userID}] Error in pause-resume flow for sandbox ${existingSandbox.sandboxId}:`,
            error,
          );
          // Fall through to create new sandbox
        }
      } else if (currentState === "paused") {
        // Step 3b: If already paused, resume directly (no retries needed)
        try {
          const sandbox = await Sandbox.connect(existingSandbox.sandboxId, {
            timeoutMs,
          });
          return sandbox;
        } catch (e) {
          // Handle specific error cases
          if (
            e instanceof Error &&
            (e.name === "NotFoundError" || e.message?.includes("not found"))
          ) {
            console.error(
              `[${userID}] Sandbox ${existingSandbox.sandboxId} expired/deleted, creating new one`,
            );
            // Clean up expired sandbox reference
            try {
              await Sandbox.kill(existingSandbox.sandboxId);
            } catch (killError) {
              console.warn(
                `[${userID}] Failed to clean up expired sandbox:`,
                killError,
              );
            }
          } else {
            console.error(
              `[${userID}] Unexpected error resuming sandbox ${existingSandbox.sandboxId}:`,
              e,
            );
          }
        }
      }
    }

    // Step 4: Create new sandbox (fallback for all failure cases)
    const sandbox = await Sandbox.create(template, {
      timeoutMs,
      metadata: {
        userID,
        template,
      },
    });

    return sandbox;
  } catch (error) {
    console.error(`[${userID}] Error in createOrConnectTerminal:`, error);
    throw error;
  }
}

/**
 * Initiates a background task to pause an active sandbox
 * Uses safeWaitUntil to handle the pause operation asynchronously without blocking
 *
 * @param sandbox - Active sandbox instance to pause
 * @returns sandboxId if pause initiated, null if invalid sandbox
 *
 * Purpose:
 * - Pauses sandbox to conserve resources when not actively in use
 * - Runs in background to avoid blocking the response
 * - Maintains sandbox state for future reuse
 * - Gracefully handles pause failures with logging
 */
export async function pauseSandbox(sandbox: Sandbox): Promise<string | null> {
  if (!sandbox?.sandboxId) {
    console.error("pauseSandbox: No sandbox ID provided for pausing");
    return null;
  }

  // Start background pause operation and return immediately
  safeWaitUntil(
    sandbox.betaPause().catch((error) => {
      console.error(
        `Background pause failed for sandbox ${sandbox.sandboxId}:`,
        error,
      );
    }),
  );

  return sandbox.sandboxId;
}
