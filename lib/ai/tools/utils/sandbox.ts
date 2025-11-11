import { Sandbox } from "@e2b/code-interpreter";
import { safeWaitUntil } from "@/lib/utils/safe-wait-until";
import type { SandboxContext } from "@/types";

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";
const BASH_SANDBOX_TIMEOUT = 15 * 60 * 1000;

/**
 * Current sandbox version identifier.
 * Used to track sandbox compatibility and trigger automatic migration when Docker templates are updated.
 * Increment this version when making breaking changes to sandbox configuration or dependencies.
 * Old sandboxes without this version (or with mismatched versions) will be automatically deleted
 * and recreated on next connection attempt.
 */
const SANDBOX_VERSION = "v3";

/**
 * Ensures a sandbox connection is established and maintained
 * Reuses existing sandboxes when possible to maintain state and improve performance
 *
 * @param context - Sandbox context containing user ID and state management
 * @param options - Configuration options for sandbox connection
 * @returns Connected sandbox instance
 *
 * Flow:
 * 1. Returns existing sandbox if already initialized
 * 2. Lists existing sandboxes for the user
 * 3. Validates sandbox version metadata (auto-kills old versions)
 * 4a. If found with "running" state: pause first (3 retries), then resume
 * 4b. If found with "paused" state: resume directly (no retries needed)
 * 5. Pause operations use 5-second delays between retry attempts
 * 6. If pause fails after retries or no sandbox found, creates new one
 * 7. Returns active sandbox ready for use
 */
export const ensureSandboxConnection = async (
  context: SandboxContext,
  options: {
    initialSandbox?: Sandbox | null;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const { userID, setSandbox } = context;
  const { initialSandbox } = options;

  // Return existing sandbox if already connected
  if (initialSandbox) {
    return { sandbox: initialSandbox };
  }
  try {
    // Step 1: Look for existing sandbox for this user
    const paginator = Sandbox.list({
      query: {
        metadata: {
          userID,
          template: SANDBOX_TEMPLATE,
        },
      },
    });
    const existingSandbox = (await paginator.nextItems())[0];

    // Step 2: Always check version and auto-kill old sandboxes
    if (
      existingSandbox &&
      existingSandbox.metadata?.sandboxVersion !== SANDBOX_VERSION
    ) {
      console.log(
        `[${userID}] Sandbox version mismatch (expected ${SANDBOX_VERSION}), deleting old sandbox`,
      );
      try {
        await Sandbox.kill(existingSandbox.sandboxId);
      } catch (killError) {
        console.warn(`[${userID}] Failed to kill old sandbox:`, killError);
      }
      // Skip to creating new sandbox
    } else if (existingSandbox?.sandboxId) {
      // Step 3: Try to reuse existing sandbox if available
      const currentState = existingSandbox.state;

      if (currentState === "running") {
        // Step 4a: If running, get sandbox instance first, then pause and resume
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
              timeoutMs: BASH_SANDBOX_TIMEOUT,
            });
            setSandbox(sandbox);
            return { sandbox };
          }
        } catch (error) {
          console.error(
            `[${userID}] Error in pause-resume flow for sandbox ${existingSandbox.sandboxId}:`,
            error,
          );
          // Fall through to create new sandbox
        }
      } else if (currentState === "paused") {
        // Step 4b: If already paused, resume directly (no retries needed)
        try {
          const sandbox = await Sandbox.connect(existingSandbox.sandboxId, {
            timeoutMs: BASH_SANDBOX_TIMEOUT,
          });
          setSandbox(sandbox);
          return { sandbox };
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

    // Step 5: Create new sandbox (fallback for all failure cases)
    const sandbox = await Sandbox.create(SANDBOX_TEMPLATE, {
      timeoutMs: BASH_SANDBOX_TIMEOUT,
      // Enable secure mode to generate pre-signed URLs for file downloads
      // This allows unauthorized environments (like browsers) to securely access
      // sandbox files through signed URLs with optional expiration times
      secure: true,
      metadata: {
        userID,
        template: SANDBOX_TEMPLATE,
        secure: "true",
        sandboxVersion: SANDBOX_VERSION,
      },
    });

    setSandbox(sandbox);
    return { sandbox };
  } catch (error) {
    console.error("Error creating persistent sandbox:", error);
    throw new Error(
      `Failed creating persistent sandbox: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
};

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
