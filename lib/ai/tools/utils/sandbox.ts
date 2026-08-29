import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import { NotFoundError, getUserFacingE2BErrorMessage } from "./e2b-errors";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";
import { retryWithBackoff } from "./retry-with-backoff";
import { getE2BClusterRouting, type E2BClusterConfig } from "./e2b-cluster";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { BASH_SANDBOX_AUTOPAUSE_TIMEOUT } from "./e2b-lease";
export {
  BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
  E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS,
  E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
  E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
  refreshE2BSandboxLease,
  refreshE2BSandboxLeaseBestEffort,
  releaseE2BSandboxIdleLeaseBestEffort,
  startE2BSandboxLeaseHeartbeat,
  withE2BSandboxLeaseHeartbeat,
} from "./e2b-lease";

type SandboxReadyPath = SandboxBootInfo["path"];

// Retry config for E2B 429 rate limits
const RATE_LIMIT_COOLDOWN_MS = 1_000;
const MAX_CREATE_RETRIES = 3;
const MAX_DISCOVERY_RETRIES = 3;
const MAX_CONNECT_RETRIES = 3;

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
    triggerRegion?: TriggerRunRegion;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const { userID, setSandbox, onBoot } = context;
  const { initialSandbox, triggerRegion } = options;

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
    const { discoveryClusters, createCluster } =
      getE2BClusterRouting(triggerRegion);

    // Step 1: Look for an existing sandbox across configured clusters. US is
    // deliberately checked first so it wins ties between equally viable ones.
    type DiscoveredSandbox = {
      info: Awaited<
        ReturnType<ReturnType<typeof Sandbox.list>["nextItems"]>
      >[number];
      cluster: E2BClusterConfig;
    };
    const discoveredSandboxes: DiscoveredSandbox[] = [];
    for (const cluster of discoveryClusters) {
      const paginator = Sandbox.list({
        ...cluster.connectionOptions,
        query: {
          metadata: {
            userID,
            template: cluster.template,
          },
        },
      });
      const listedSandboxes = await retryWithBackoff(
        () => paginator.nextItems(),
        {
          maxRetries: MAX_DISCOVERY_RETRIES,
          baseDelayMs: 400,
          jitterMs: 40,
        },
      );
      discoveredSandboxes.push(
        ...listedSandboxes.map((info) => ({ info, cluster })),
      );
    }

    // Rank across both clusters so a compatible running sandbox always wins.
    // Discovery order keeps US as the tie-breaker for equally ranked entries.
    const existingSandbox =
      discoveredSandboxes.find(
        ({ info }) =>
          info.state === "running" &&
          info.metadata?.sandboxVersion === SANDBOX_VERSION,
      ) ??
      discoveredSandboxes.find(({ info }) => info.state === "running") ??
      discoveredSandboxes.find(
        ({ info }) =>
          info.state === "paused" &&
          info.metadata?.sandboxVersion === SANDBOX_VERSION,
      ) ??
      discoveredSandboxes[0];

    const existingSandboxInfo = existingSandbox?.info;
    const existingCluster = existingSandbox?.cluster;
    const hasVersionMismatch =
      existingSandboxInfo &&
      existingSandboxInfo.metadata?.sandboxVersion !== SANDBOX_VERSION;
    const canReplaceExistingSandbox =
      hasVersionMismatch && existingSandboxInfo.state === "paused";

    // Step 2: Migrate only an idle, paused sandbox. A running sandbox may
    // contain commands owned by another Agent run for the same user.
    if (canReplaceExistingSandbox && existingCluster) {
      console.log(
        `[${userID}] Sandbox version mismatch (expected ${SANDBOX_VERSION}), deleting old sandbox`,
      );
      try {
        if (existingCluster.connectionOptions) {
          await Sandbox.kill(
            existingSandboxInfo.sandboxId,
            existingCluster.connectionOptions,
          );
        } else {
          await Sandbox.kill(existingSandboxInfo.sandboxId);
        }
      } catch (killError) {
        logSandboxKillFailure(userID, "Failed to kill old sandbox", killError);
      }
      createPath = "create_after_version_mismatch";
      // Skip to creating new sandbox
    } else if (existingSandboxInfo?.sandboxId && existingCluster) {
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
            sandbox_id: existingSandboxInfo.sandboxId,
            sandbox_state: existingSandboxInfo.state,
            current_version:
              existingSandboxInfo.metadata?.sandboxVersion ?? "missing",
            expected_version: SANDBOX_VERSION,
          }),
        );
      }

      // Step 3: Try to reuse existing sandbox (works for both running and paused states)
      // With auto-pause, we don't need to manually pause before resuming
      // Sandbox.connect() handles both running and paused sandboxes automatically
      try {
        const sandbox = await retryWithBackoff(
          () =>
            Sandbox.connect(existingSandboxInfo.sandboxId, {
              ...existingCluster.connectionOptions,
              timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
            }),
          {
            maxRetries: MAX_CONNECT_RETRIES,
            baseDelayMs: 400,
            jitterMs: 40,
          },
        );
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
            `[${userID}] Sandbox ${existingSandboxInfo.sandboxId} expired/deleted, creating new one`,
          );
          createPath = "create_after_expired";
        } else {
          console.error(
            `[${userID}] Unexpected error resuming sandbox ${existingSandboxInfo.sandboxId}:`,
            e,
          );
          // The listed state can become stale while connect is pending. Never
          // destroy a shared user sandbox here: another run may have resumed
          // it by the time this failure is observed. The attachment path owns
          // bounded provider recovery after the E2B reconnect retries are
          // exhausted.
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
        const sandbox = await Sandbox.create(createCluster.template, {
          ...createCluster.connectionOptions,
          timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
          lifecycle: { onTimeout: "pause", autoResume: true },
          secure: true,
          metadata: {
            userID,
            template: createCluster.template,
            secure: "true",
            sandboxVersion: SANDBOX_VERSION,
            e2bCluster: createCluster.cluster,
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
