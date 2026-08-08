import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import { NotFoundError, getUserFacingE2BErrorMessage } from "./e2b-errors";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";
import {
  composeE2BNetworkPolicy,
  DEFAULT_AGENT_NETWORK_CONFIG,
  E2B_INBOUND_MODE_METADATA_KEY,
  getExistingE2BInboundMode,
} from "./e2b-network-policy";

type SandboxReadyPath = SandboxBootInfo["path"];

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";
export const BASH_SANDBOX_AUTOPAUSE_TIMEOUT = 7 * 60 * 1000;
export const E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS = 5 * 1000;
// Retry config for E2B 429 rate limits
const RATE_LIMIT_COOLDOWN_MS = 1_000;
const MAX_CREATE_RETRIES = 3;

function supportsE2BSnapshots(version: string | undefined): boolean {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 0 || minor >= 5;
}

export const refreshE2BSandboxLease = async (
  sandbox: Sandbox,
): Promise<number> => {
  await sandbox.setTimeout(BASH_SANDBOX_AUTOPAUSE_TIMEOUT, {
    requestTimeoutMs: E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
  });
  return BASH_SANDBOX_AUTOPAUSE_TIMEOUT;
};

type E2BSandboxLeaseRefreshSource =
  "foreground_heartbeat" | "default_manager_cache" | "hybrid_manager_cache";

const logLeaseRefreshFailure = (
  sandbox: Sandbox,
  source: E2BSandboxLeaseRefreshSource,
  error: unknown,
): void => {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "e2b_sandbox_lease_refresh_failed",
      service: "chat-handler",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      request_id: process.env.VERCEL_REQUEST_ID ?? null,
      sandbox_id: sandbox.sandboxId,
      source,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

export const refreshE2BSandboxLeaseBestEffort = async (
  sandbox: Sandbox,
  options: {
    source: E2BSandboxLeaseRefreshSource;
    logFailure?: boolean;
  },
): Promise<boolean> => {
  try {
    await refreshE2BSandboxLease(sandbox);
    return true;
  } catch (error) {
    if (options.logFailure !== false) {
      logLeaseRefreshFailure(sandbox, options.source, error);
    }
    return false;
  }
};

/**
 * Keeps the fixed per-user sandbox lease alive only while the caller is
 * actively waiting for foreground work. Every Trigger worker writes the same
 * seven-minute lease, so independently connected workers cannot shorten a
 * longer operation owned by another run.
 */
export const withE2BSandboxLeaseHeartbeat = async <T>(
  sandbox: Sandbox,
  operation: () => Promise<T>,
): Promise<T> => {
  let refreshInFlight = false;
  let heartbeatFailureLogged = false;
  const refresh = async (): Promise<void> => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const refreshed = await refreshE2BSandboxLeaseBestEffort(sandbox, {
        source: "foreground_heartbeat",
        logFailure: !heartbeatFailureLogged,
      });
      heartbeatFailureLogged = !refreshed;
    } finally {
      refreshInFlight = false;
    }
  };

  // Acquisition already creates, connects, or refreshes the seven-minute
  // lease. Delay the first heartbeat so foreground startup does not make a
  // duplicate E2B API request.
  const heartbeat = setInterval(() => {
    void refresh();
  }, E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS);
  (
    heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
  }
};

const logSandboxKillFailure = (
  userID: string,
  message: string,
  error: unknown,
): void => {
  if (isExpectedAlreadyGoneCleanupError(error)) {
    console.debug(`[${userID}] ${message}:`, error);
  } else {
    console.warn(`[${userID}] ${message}:`, error);
  }
};

/**
 * Current sandbox version identifier.
 * Used to track sandbox compatibility and trigger automatic migration when Docker templates are updated.
 * Increment this version when making breaking changes to sandbox configuration or dependencies.
 * Old sandboxes without this version (or with mismatched versions) will be automatically deleted
 * and recreated on next connection attempt.
 */
// v8: upgraded sandbox CPU (4 cores) and memory (2GB)
// v9: added temporary HTTP interception support
// v10: added whois, Chromium, and agent-browser browser automation
// v11: removed preinstalled interception CLI from the sandbox image
// v12: increased sandbox memory from 2GB to 4GB
const SANDBOX_VERSION = "v12";

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
 * 3. Replaces old sandbox versions only after they have auto-paused
 * 4. If found: connect to existing sandbox (works for both running and paused states)
 * 5. If not found: creates a new sandbox with auto-pause enabled
 * 6. Auto-pause automatically pauses sandbox after the configured lease expires
 * 7. Returns active sandbox ready for use
 */
export const ensureSandboxConnection = async (
  context: SandboxContext,
  options: {
    initialSandbox?: Sandbox | null;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const {
    userID,
    setSandbox,
    onBoot,
    networkConfig,
    acquireNetworkMigrationLease,
  } = context;
  const { initialSandbox } = options;
  const effectiveNetworkConfig = networkConfig ?? DEFAULT_AGENT_NETWORK_CONFIG;
  const networkPolicy = composeE2BNetworkPolicy(effectiveNetworkConfig);
  let releaseNetworkMigrationLease: (() => Promise<void>) | undefined;

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
    const existingSandboxes = await paginator.nextItems();
    const existingSandbox =
      existingSandboxes.find(
        (candidate) =>
          candidate.metadata?.sandboxVersion === SANDBOX_VERSION &&
          getExistingE2BInboundMode(candidate.metadata) ===
            effectiveNetworkConfig.inboundMode,
      ) ?? existingSandboxes[0];

    const hasVersionMismatch =
      existingSandbox &&
      existingSandbox.metadata?.sandboxVersion !== SANDBOX_VERSION;
    const hasInboundModeMismatch =
      existingSandbox &&
      getExistingE2BInboundMode(existingSandbox.metadata) !==
        effectiveNetworkConfig.inboundMode;
    const canReplaceExistingSandbox =
      hasVersionMismatch && existingSandbox.state === "paused";
    const canMigrateInboundPolicy =
      !hasVersionMismatch &&
      hasInboundModeMismatch &&
      existingSandbox.state === "paused";
    let createTemplate = SANDBOX_TEMPLATE;
    let inboundMigration:
      { oldSandboxId: string; snapshotId: string } | undefined;

    // Step 2: Migrate only an idle, paused sandbox. A running sandbox may
    // contain commands owned by another Agent run for the same user.
    if (canReplaceExistingSandbox) {
      console.log(
        `[${userID}] Sandbox version mismatch (expected ${SANDBOX_VERSION}), deleting old sandbox`,
      );
      try {
        await Sandbox.kill(existingSandbox.sandboxId);
      } catch (killError) {
        logSandboxKillFailure(userID, "Failed to kill old sandbox", killError);
      }
      createPath = "create_after_version_mismatch";
      // Skip to creating new sandbox
    } else if (canMigrateInboundPolicy) {
      if (!acquireNetworkMigrationLease) {
        throw new Error(
          "Cloud Agent inbound access cannot change because the migration coordinator is unavailable. Try again shortly.",
        );
      }
      releaseNetworkMigrationLease =
        (await acquireNetworkMigrationLease()) ?? undefined;
      if (!releaseNetworkMigrationLease) {
        throw new Error(
          "Cloud Agent inbound access is already being applied by another Agent run. Try again shortly.",
        );
      }
      if (!supportsE2BSnapshots(existingSandbox.envdVersion)) {
        throw new Error(
          "Cloud Agent inbound access cannot change without resetting this older sandbox. Delete the sandbox in Settings > Data Controls, then try again.",
        );
      }

      // E2B inbound access is create-only. Snapshot an idle sandbox and use
      // that snapshot as the new template so files and memory survive the
      // replacement. The old sandbox remains intact until creation succeeds.
      const sandboxToMigrate = await Sandbox.connect(
        existingSandbox.sandboxId,
        {
          timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
        },
      );
      const snapshot = await sandboxToMigrate.createSnapshot();
      createTemplate = snapshot.snapshotId;
      inboundMigration = {
        oldSandboxId: existingSandbox.sandboxId,
        snapshotId: snapshot.snapshotId,
      };
      createPath = "create_after_network_change";
    } else if (hasInboundModeMismatch) {
      throw new Error(
        "Cloud Agent inbound access is changing. Wait for current Agent work to finish, then try again; the running sandbox will not be interrupted.",
      );
    } else if (existingSandbox?.sandboxId) {
      if (hasVersionMismatch) {
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            event: "e2b_sandbox_version_migration_deferred",
            service: "chat-handler",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            request_id: process.env.VERCEL_REQUEST_ID ?? null,
            user_id: userID,
            sandbox_id: existingSandbox.sandboxId,
            sandbox_state: existingSandbox.state,
            current_version:
              existingSandbox.metadata?.sandboxVersion ?? "missing",
            expected_version: SANDBOX_VERSION,
          }),
        );
      }

      // Step 3: Try to reuse existing sandbox (works for both running and paused states)
      // With auto-pause, we don't need to manually pause before resuming
      // Sandbox.connect() handles both running and paused sandboxes automatically
      try {
        const sandbox = await Sandbox.connect(existingSandbox.sandboxId, {
          timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
        });
        if (networkConfig) {
          await sandbox.updateNetwork(networkPolicy.update);
        }
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
        } else {
          console.error(
            `[${userID}] Unexpected error resuming sandbox ${existingSandbox.sandboxId}:`,
            e,
          );
          // Never destroy a shared user sandbox for a transient connection
          // error. Another Agent run may still own active commands inside it.
          throw e;
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
        const sandbox = await Sandbox.create(createTemplate, {
          timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
          lifecycle: { onTimeout: "pause" },
          secure: true,
          ...(networkConfig ? { network: networkPolicy.create } : {}),
          metadata: {
            userID,
            template: SANDBOX_TEMPLATE,
            secure: "true",
            sandboxVersion: SANDBOX_VERSION,
            ...(networkConfig
              ? {
                  [E2B_INBOUND_MODE_METADATA_KEY]:
                    effectiveNetworkConfig.inboundMode,
                }
              : {}),
          },
        });

        if (inboundMigration) {
          try {
            await Sandbox.kill(inboundMigration.oldSandboxId);
          } catch (killError) {
            logSandboxKillFailure(
              userID,
              "Failed to kill sandbox after network migration",
              killError,
            );
          }
          try {
            await Sandbox.deleteSnapshot(inboundMigration.snapshotId);
          } catch (snapshotError) {
            console.warn(
              `[${userID}] Failed to delete temporary network migration snapshot:`,
              snapshotError,
            );
          }
        }

        setSandbox(sandbox);
        reportBoot(createPath, attempt + 1);
        return { sandbox };
      } catch (createError) {
        lastError = createError;
        const isRateLimit =
          createError instanceof Error &&
          (createError.message?.includes("429") ||
            createError.message?.includes("Rate limit"));
        if (!isRateLimit) {
          if (inboundMigration) {
            try {
              await Sandbox.deleteSnapshot(inboundMigration.snapshotId);
            } catch (snapshotError) {
              console.warn(
                `[${userID}] Failed to delete temporary network migration snapshot after create failure:`,
                snapshotError,
              );
            }
          }
          throw createError;
        }
      }
    }
    if (inboundMigration) {
      try {
        await Sandbox.deleteSnapshot(inboundMigration.snapshotId);
      } catch (snapshotError) {
        console.warn(
          `[${userID}] Failed to delete temporary network migration snapshot after create failure:`,
          snapshotError,
        );
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
  } finally {
    await releaseNetworkMigrationLease?.();
  }
};
