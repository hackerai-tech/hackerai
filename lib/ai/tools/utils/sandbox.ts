import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import {
  NotFoundError,
  classifyE2BError,
  getUserFacingE2BErrorMessage,
} from "./e2b-errors";
import { retryWithBackoff } from "./retry-with-backoff";
import {
  E2BRegionUnavailableError,
  getE2BClusterRouting,
  type E2BClusterConfig,
} from "./e2b-cluster";
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
type E2BAcquisitionPhase = "routing" | "discovery" | "connect" | "create";

const SAFE_E2B_CODES = new Set([
  "RATE_LIMIT",
  "TIMEOUT",
  "NOT_FOUND",
  "AUTHENTICATION_ERROR",
  "TEMPLATE_ERROR",
  "INVALID_ARGUMENT",
  "SANDBOX_ERROR",
  "NOT_ENOUGH_SPACE",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "RESOURCE_EXHAUSTED",
]);

export class E2BAcquisitionError extends Error {
  constructor(
    message: string,
    readonly diagnostics: {
      e2b_phase: E2BAcquisitionPhase;
      e2b_error_category: ReturnType<typeof classifyE2BError>;
      e2b_error_code?: string;
      e2b_http_status?: number;
    },
  ) {
    super(message);
    this.name = "E2BAcquisitionError";
  }
}

// Retry config for E2B 429 rate limits
const RATE_LIMIT_COOLDOWN_MS = 1_000;
const MAX_CREATE_RETRIES = 3;
const MAX_DISCOVERY_RETRIES = 3;
const MAX_CONNECT_RETRIES = 3;

// Used to prefer a compatible workspace; version changes never authorize deletion.
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
 * 3. Preserves old templates and versions, including paused user files
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
    acquisitionId?: string;
    triggerRunId?: string;
    destinationId?: string;
    createOnly?: boolean;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const { userID, setSandbox, onBoot } = context;
  const { initialSandbox, triggerRegion } = options;

  // Return existing sandbox if already connected
  if (initialSandbox && !options.destinationId && !options.createOnly) {
    return { sandbox: initialSandbox };
  }
  const startedAt = performance.now();
  let phase: E2BAcquisitionPhase = "routing";
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
    if (options.destinationId) {
      // A recovered workspace is pinned to one verified sandbox. Never let
      // discovery choose an older copy or create an empty replacement.
      phase = "connect";
      const info = await Sandbox.getInfo(options.destinationId, {
        ...createCluster.connectionOptions,
        requestTimeoutMs: 10000,
      });
      if (
        !["running", "paused"].includes(info.state) ||
        info.metadata?.userID !== userID ||
        info.metadata?.template !== createCluster.template ||
        info.metadata?.e2bCluster !== createCluster.cluster ||
        info.metadata?.sandboxVersion !== SANDBOX_VERSION
      )
        throw new Error("Pinned E2B workspace identity mismatch");
      const sandbox = await retryWithBackoff(
        () =>
          Sandbox.connect(options.destinationId!, {
            ...createCluster.connectionOptions,
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
    }
    phase = "discovery";

    // Step 1: Look only in the cluster selected for this request. Crossing
    // clusters here would defeat the regional execution policy.
    type DiscoveredSandbox = {
      info: Awaited<
        ReturnType<ReturnType<typeof Sandbox.list>["nextItems"]>
      >[number];
      cluster: E2BClusterConfig;
    };
    const discoveredSandboxes: DiscoveredSandbox[] = [];
    for (const cluster of options.createOnly ? [] : discoveryClusters) {
      const paginator = Sandbox.list({
        ...cluster.connectionOptions,
        query: {
          metadata: {
            userID,
          },
          state: ["running", "paused"],
        },
      });
      let pages = 0;
      do {
        if (++pages > 100) throw new Error("E2B inventory pagination limit");
        const listedSandboxes = await retryWithBackoff(
          () => paginator.nextItems(),
          { maxRetries: MAX_DISCOVERY_RETRIES, baseDelayMs: 400, jitterMs: 40 },
        );
        discoveredSandboxes.push(
          ...listedSandboxes.map((info) => ({ info, cluster })),
        );
      } while (paginator.hasNext);
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
    // An old version can still contain files. Reconnect without destructive
    // replacement, including after a denied Miosa migration check.
    if (existingSandboxInfo?.sandboxId && existingCluster) {
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
        phase = "connect";
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
    phase = "create";
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
            ...(options.createOnly && {
              workspacePurpose: "migration-fallback",
            }),
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
    const candidate =
      error && typeof error === "object"
        ? (error as { code?: unknown; status?: unknown; statusCode?: unknown })
        : {};
    const status = candidate.status ?? candidate.statusCode;
    const diagnostics = {
      e2b_phase: phase,
      e2b_error_category: classifyE2BError(error),
      ...(typeof candidate.code === "string" &&
      SAFE_E2B_CODES.has(candidate.code)
        ? { e2b_error_code: candidate.code }
        : {}),
      ...(typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
        ? { e2b_http_status: status }
        : {}),
    };
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "e2b_sandbox_acquisition_failed",
        service: "agent-worker",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: process.env.VERCEL_REQUEST_ID ?? null,
        acquisition_id: options.acquisitionId ?? null,
        trigger_run_id: options.triggerRunId ?? null,
        user_id: userID,
        ...diagnostics,
        duration_ms: Math.round(performance.now() - startedAt),
      }),
    );

    if (error instanceof E2BRegionUnavailableError) throw error;

    // Surface specific error messages for known E2B errors
    const userMessage = getUserFacingE2BErrorMessage(error);
    if (userMessage) {
      throw new E2BAcquisitionError(userMessage, diagnostics);
    }

    throw new E2BAcquisitionError(
      "Cloud sandbox is temporarily unavailable. Please retry shortly.",
      diagnostics,
    );
  }
};
