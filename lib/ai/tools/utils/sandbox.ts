import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import { NotFoundError, getUserFacingE2BErrorMessage } from "./e2b-errors";

type SandboxReadyPath = SandboxBootInfo["path"];

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";
const BASH_SANDBOX_RESUME_TIMEOUT = 5 * 60 * 1000; // 5 minutes for resuming paused sandbox
const BASH_SANDBOX_AUTOPAUSE_TIMEOUT = 7 * 60 * 1000; // 7 minutes auto-pause inactivity timeout
// Retry config for E2B 429 rate limits
const RATE_LIMIT_COOLDOWN_MS = 1_000;
const MAX_CREATE_RETRIES = 3;

/**
 * Current sandbox version identifier.
 * Used to track sandbox compatibility and trigger automatic migration when Docker templates are updated.
 * Increment this version when making breaking changes to sandbox configuration or dependencies.
 * Old sandboxes without this version (or with mismatched versions) will be automatically deleted
 * and recreated on next connection attempt.
 */
// v8: upgraded sandbox CPU (4 cores) and memory (2GB)
// v9: added Caido proxy (caido-cli install, lazy start via ensureCaido, HTTP_PROXY env vars)
const SANDBOX_VERSION = "v9";

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
  const { userID, setSandbox, onBoot } = context;
  const { initialSandbox } = options;

  // Return existing sandbox if already connected
  if (initialSandbox) {
    return { sandbox: initialSandbox };
  }
  const startedAt = performance.now();
  let createPath: SandboxReadyPath = "create_fresh";
  const reportBoot = (path: SandboxReadyPath, attempts: number): void => {
    onBoot?.({
      path,
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: attempts,
    });
  };
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
      createPath = "create_after_version_mismatch";
      // Skip to creating new sandbox
    } else if (existingSandbox?.sandboxId) {
      // Step 3: Try to reuse existing sandbox (works for both running and paused states)
      // With auto-pause, we don't need to manually pause before resuming
      // Sandbox.connect() handles both running and paused sandboxes automatically
      try {
        const sandbox = await Sandbox.connect(existingSandbox.sandboxId, {
          timeoutMs: BASH_SANDBOX_RESUME_TIMEOUT,
        });
        setSandbox(sandbox);
        reportBoot("reuse_existing", 0);
        return { sandbox };
      } catch (e) {
        // Handle specific error cases
        if (
          e instanceof NotFoundError ||
          (e instanceof Error && e.message?.includes("not found"))
        ) {
          console.error(
            `[${userID}] Sandbox ${existingSandbox.sandboxId} expired/deleted, creating new one`,
          );
          createPath = "create_after_expired";
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
          createPath = "create_after_broken";
          // Kill the broken sandbox so Sandbox.list() doesn't keep finding it
          try {
            await Sandbox.kill(existingSandbox.sandboxId);
          } catch (killError) {
            console.warn(
              `[${userID}] Failed to clean up broken sandbox:`,
              killError,
            );
          }
        }
      }
    }

    // Step 5: Create new sandbox with retry on E2B 429 rate limits
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
      if (attempt > 0) {
        console.warn(
          `[${userID}] E2B rate limit — retrying sandbox creation (${attempt + 1}/${MAX_CREATE_RETRIES}) after ${RATE_LIMIT_COOLDOWN_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
      }

      try {
        const sandbox = await Sandbox.betaCreate(SANDBOX_TEMPLATE, {
          timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
          autoPause: true,
          secure: true,
          metadata: {
            userID,
            template: SANDBOX_TEMPLATE,
            secure: "true",
            sandboxVersion: SANDBOX_VERSION,
          },
        });

        setSandbox(sandbox);
        reportBoot(createPath, attempt + 1);
        return { sandbox };
      } catch (createError) {
        lastError = createError;
        const isRateLimit =
          createError instanceof Error &&
          (createError.message?.includes("429") ||
            createError.message?.includes("Rate limit"));
        if (!isRateLimit) throw createError;
      }
    }
    throw lastError;
  } catch (error) {
    console.error("Error creating persistent sandbox:", error);

    // Surface specific error messages for known E2B errors
    const userMessage = getUserFacingE2BErrorMessage(error);
    if (userMessage) {
      throw new Error(userMessage);
    }

    throw new Error(
      `Failed creating persistent sandbox: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
};
