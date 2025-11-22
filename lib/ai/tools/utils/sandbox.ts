import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxContext } from "@/types";

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";
const BASH_SANDBOX_TIMEOUT = 15 * 60 * 1000; // 15 minutes connection timeout
const BASH_SANDBOX_AUTOPAUSE_TIMEOUT = 7 * 60 * 1000; // 7 minutes auto-pause inactivity timeout

/**
 * Current sandbox version identifier.
 * Used to track sandbox compatibility and trigger automatic migration when Docker templates are updated.
 * Increment this version when making breaking changes to sandbox configuration or dependencies.
 * Old sandboxes without this version (or with mismatched versions) will be automatically deleted
 * and recreated on next connection attempt.
 */
const SANDBOX_VERSION = "v6";

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
 * 4. If found: connect to existing sandbox (works for both running and paused states)
 * 5. If not found or connection fails: creates new sandbox with auto-pause enabled
 * 6. Auto-pause automatically pauses sandbox after inactivity timeout (15 minutes)
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
      // Step 3: Try to reuse existing sandbox (works for both running and paused states)
      // With auto-pause, we don't need to manually pause before resuming
      // Sandbox.connect() handles both running and paused sandboxes automatically
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

    // Step 5: Create new sandbox (fallback for all failure cases)
    // Use betaCreate with autoPause - sandbox will automatically pause after timeout
    // This eliminates the need for manual pause operations and their failure modes
    const sandbox = await Sandbox.betaCreate(SANDBOX_TEMPLATE, {
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
      autoPause: true, // Auto-pause after inactivity timeout
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
