import {
  recordResumeFailure,
  clearResumeFailures,
} from "@/lib/cloud-recovery/store";
import { readNetworkSettings } from "@/lib/cloud-network/service";
import { DEFAULT_NETWORK_POLICY, e2bNetwork } from "@/lib/cloud-network/policy";
import {
  CloudAcquisitionTimeoutError,
  CLOUD_RESUME_DEADLINE_MS,
  type ReportCloudAcquisitionStage,
} from "./cloud-acquisition-budget";
import { Sandbox, Template } from "@e2b/code-interpreter";
import { createHash } from "node:crypto";
import {
  CURRENT_E2B_SANDBOX_VERSION,
  isRecoverableE2BSandboxVersion,
  rememberE2BSandboxVersion,
} from "./e2b-sandbox-version";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import {
  NotFoundError,
  SandboxError,
  TimeoutError,
  classifyE2BError,
  getUserFacingE2BErrorMessage,
} from "./e2b-errors";
import { retryWithBackoff } from "./retry-with-backoff";
import {
  E2BRegionUnavailableError,
  getE2BClusterRouting,
  type E2BCluster,
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
const SANDBOX_VERSION = CURRENT_E2B_SANDBOX_VERSION;

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
    signal?: AbortSignal;
    reportStage?: ReportCloudAcquisitionStage;
    initialSandbox?: Sandbox | null;
    triggerRegion?: TriggerRunRegion;
    acquisitionId?: string;
    triggerRunId?: string;
    destinationId?: string;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const { userID, setSandbox, onBoot } = context;
  const { initialSandbox, triggerRegion, signal } = options;
  signal?.throwIfAborted();
  // The SDK aborts fetch with this shared deadline signal. Paused restores use
  // a longer SDK timeout as well; the total acquisition deadline remains authoritative.
  const requestOptions = { signal };

  // Return existing sandbox if already connected
  if (initialSandbox && !options.destinationId) {
    return { sandbox: initialSandbox };
  }
  const startedAt = performance.now();
  let phase: E2BAcquisitionPhase = "routing";
  let connectState: "running" | "paused" | null = null;
  let connectSelectionSource: "pinned" | "inventory" | null = null;
  let connectRequestTimeoutMs: number | null = null;
  let connectSandboxId: string | null = null;
  let connectCluster: E2BCluster | null = null;
  let createPath: SandboxReadyPath = "create_fresh";
  const reportBoot = (path: SandboxReadyPath, attempts: number): void => {
    onBoot?.({
      path,
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: attempts,
    });
  };
  let failedTarget:
    { sandboxId: string; template: string; sandboxVersion: string } | undefined;
  let connectGatewayTimeout: SandboxError | undefined;
  const connectSelectedSandbox = async (
    sandboxId: string,
    connectOptions: Parameters<typeof Sandbox.connect>[1],
  ) => {
    try {
      return await Sandbox.connect(sandboxId, connectOptions);
    } catch (error) {
      if (error instanceof SandboxError && error.statusCode === 504)
        connectGatewayTimeout = error;
      throw error;
    }
  };
  try {
    options.reportStage?.("routing");
    const { discoveryClusters, createCluster } =
      getE2BClusterRouting(triggerRegion);
    if (options.destinationId) {
      // A recovered workspace is pinned to one verified sandbox. Never let
      // discovery choose an older copy or create an empty replacement.
      phase = "connect";
      options.reportStage?.("workspace_identity");
      const info = await Sandbox.getInfo(options.destinationId, {
        ...createCluster.connectionOptions,
        ...requestOptions,
        requestTimeoutMs: 10_000,
      });
      if (
        !["running", "paused"].includes(info.state) ||
        info.metadata?.userID !== userID ||
        info.metadata?.template !== createCluster.template ||
        info.metadata?.e2bCluster !== createCluster.cluster ||
        !isRecoverableE2BSandboxVersion(info.metadata?.sandboxVersion)
      )
        throw new Error("Pinned E2B workspace identity mismatch");
      if (
        info.state === "paused" &&
        info.metadata?.template &&
        info.metadata?.sandboxVersion
      )
        failedTarget = {
          sandboxId: info.sandboxId,
          template: info.metadata.template,
          sandboxVersion: info.metadata.sandboxVersion,
        };
      const resumingPausedWorkspace = info.state === "paused";
      connectSandboxId = options.destinationId;
      connectCluster = createCluster.cluster;
      connectState = resumingPausedWorkspace ? "paused" : "running";
      connectSelectionSource = "pinned";
      connectRequestTimeoutMs = resumingPausedWorkspace
        ? CLOUD_RESUME_DEADLINE_MS
        : null;
      options.reportStage?.("connect", { resumingPausedWorkspace });
      const sandbox = await retryWithBackoff(
        () =>
          connectSelectedSandbox(options.destinationId!, {
            ...createCluster.connectionOptions,
            ...requestOptions,
            ...(resumingPausedWorkspace
              ? { requestTimeoutMs: CLOUD_RESUME_DEADLINE_MS, retries: 0 }
              : {}),
            timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
          }),
        {
          signal,
          // A failed restore can have an uncertain provider-side outcome.
          // Do not issue another resume automatically within this acquisition.
          maxRetries: resumingPausedWorkspace ? 1 : MAX_CONNECT_RETRIES,
          baseDelayMs: 400,
          jitterMs: 40,
        },
      );
      signal?.throwIfAborted();
      await clearResumeFailures(userID, sandbox.sandboxId).catch(() => {});
      signal?.throwIfAborted();
      rememberE2BSandboxVersion(sandbox, info.metadata?.sandboxVersion);
      setSandbox(sandbox);
      reportBoot("reuse_existing", 0);
      return { sandbox };
    }
    phase = "discovery";
    options.reportStage?.("discovery");

    // Step 1: Look only in the cluster selected for this request. Crossing
    // clusters here would defeat the regional execution policy.
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
        ...requestOptions,
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
          {
            signal,
            maxRetries: MAX_DISCOVERY_RETRIES,
            baseDelayMs: 400,
            jitterMs: 40,
          },
        );
        discoveredSandboxes.push(
          ...listedSandboxes.map((info) => ({ info, cluster })),
        );
      } while (paginator.hasNext);
    }

    // Prefer a running, supported workspace without forcing v12 users to
    // switch workspaces just because a newer image is available.
    const existingSandbox =
      discoveredSandboxes.find(
        ({ info }) =>
          info.state === "running" &&
          isRecoverableE2BSandboxVersion(info.metadata?.sandboxVersion),
      ) ??
      discoveredSandboxes.find(({ info }) => info.state === "running") ??
      discoveredSandboxes.find(
        ({ info }) =>
          info.state === "paused" &&
          isRecoverableE2BSandboxVersion(info.metadata?.sandboxVersion),
      ) ??
      discoveredSandboxes[0];

    const existingSandboxInfo = existingSandbox?.info;
    const existingCluster = existingSandbox?.cluster;
    const hasVersionMismatch =
      existingSandboxInfo &&
      !isRecoverableE2BSandboxVersion(
        existingSandboxInfo.metadata?.sandboxVersion,
      );
    // An old version can still contain files. Reconnect without destructive
    // replacement.
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

      if (
        existingSandboxInfo.state === "paused" &&
        existingSandboxInfo.metadata?.template === createCluster.template &&
        isRecoverableE2BSandboxVersion(
          existingSandboxInfo.metadata?.sandboxVersion,
        ) &&
        existingSandboxInfo.metadata?.e2bCluster === createCluster.cluster &&
        existingCluster.cluster === createCluster.cluster
      )
        failedTarget = {
          sandboxId: existingSandboxInfo.sandboxId,
          template: existingSandboxInfo.metadata.template,
          sandboxVersion: existingSandboxInfo.metadata.sandboxVersion,
        };
      // Step 3: Try to reuse existing sandbox (works for both running and paused states)
      // With auto-pause, we don't need to manually pause before resuming
      // Sandbox.connect() handles both running and paused sandboxes automatically
      try {
        phase = "connect";
        const resumingPausedWorkspace = existingSandboxInfo.state === "paused";
        connectSandboxId = existingSandboxInfo.sandboxId;
        connectCluster = existingCluster.cluster;
        connectState = resumingPausedWorkspace
          ? "paused"
          : existingSandboxInfo.state === "running"
            ? "running"
            : null;
        connectSelectionSource = "inventory";
        connectRequestTimeoutMs = resumingPausedWorkspace
          ? CLOUD_RESUME_DEADLINE_MS
          : null;
        options.reportStage?.("connect", { resumingPausedWorkspace });
        const sandbox = await retryWithBackoff(
          () =>
            connectSelectedSandbox(existingSandboxInfo.sandboxId, {
              ...existingCluster.connectionOptions,
              ...requestOptions,
              ...(resumingPausedWorkspace
                ? { requestTimeoutMs: CLOUD_RESUME_DEADLINE_MS, retries: 0 }
                : {}),
              timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
            }),
          {
            signal,
            maxRetries: resumingPausedWorkspace ? 1 : MAX_CONNECT_RETRIES,
            baseDelayMs: 400,
            jitterMs: 40,
          },
        );
        signal?.throwIfAborted();
        await clearResumeFailures(userID, sandbox.sandboxId).catch(() => {});
        signal?.throwIfAborted();
        rememberE2BSandboxVersion(
          sandbox,
          existingSandboxInfo.metadata?.sandboxVersion,
        );
        setSandbox(sandbox);
        reportBoot("reuse_existing", 0);
        return { sandbox };
      } catch (e) {
        signal?.throwIfAborted();
        // Handle specific error cases
        if (
          existingSandboxInfo.state !== "paused" &&
          (e instanceof NotFoundError ||
            (e instanceof Error && e.message?.includes("not found")))
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
    options.reportStage?.("create");
    // Select an explicitly tagged image so deploying app code before the new
    // image cannot label an old template v13. A missing tag keeps legacy v12
    // creation working; lookup failures are not permission to guess a version.
    const [templateName, templateTag = "default"] =
      createCluster.template.split(":");
    const tags = await Template.getTags(templateName, {
      ...createCluster.connectionOptions,
      ...requestOptions,
      requestTimeoutMs: 10_000,
    });
    const selectedBuild = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      templateTag,
    )
      ? templateTag
      : tags.find(({ tag }) => tag === templateTag)?.buildId;
    if (!selectedBuild)
      throw new Error("E2B template tag has no verified build");
    const versionBuild = tags.find(
      ({ tag }) => tag === SANDBOX_VERSION,
    )?.buildId;
    const createVersion =
      selectedBuild === versionBuild ? SANDBOX_VERSION : "v12";
    // Pin the resolved build, not a mutable tag that could change before create.
    const createTemplate = `${templateName}:${selectedBuild}`;
    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        console.warn(
          `[${userID}] E2B rate limit — retrying sandbox creation (${attempt + 1}/${MAX_CREATE_RETRIES}) after ${RATE_LIMIT_COOLDOWN_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
      }

      signal?.throwIfAborted();
      try {
        const networkSettings = await readNetworkSettings(userID);
        const sandbox = await Sandbox.create(createTemplate, {
          network: e2bNetwork(
            networkSettings?.policy ?? DEFAULT_NETWORK_POLICY,
          ),
          ...createCluster.connectionOptions,
          ...requestOptions,
          timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
          lifecycle: { onTimeout: "pause", autoResume: true },
          secure: true,
          metadata: {
            userID,
            template: createCluster.template,
            secure: "true",
            sandboxVersion: createVersion,
            e2bCluster: createCluster.cluster,
          },
        });

        signal?.throwIfAborted();
        rememberE2BSandboxVersion(sandbox, createVersion);
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
    if (failedTarget && options.acquisitionId && options.triggerRegion) {
      const status =
        error && typeof error === "object"
          ? ((error as { statusCode?: number; status?: number }).statusCode ??
            (error as { status?: number }).status)
          : undefined;
      await recordResumeFailure({
        userId: userID,
        ...failedTarget,
        region: options.triggerRegion,
        acquisitionId: options.acquisitionId,
        uncertain:
          signal?.aborted === true || !status || ![400, 422].includes(status),
        // E2B reports its own gateway timeout as SandboxError, not TimeoutError.
        // This is still uncertain: only the consent-gated customer path may
        // reconcile exact paused identity after the complete idle window.
        // Other provider failures and cancellation remain support-only.
        timeoutOnly:
          phase === "connect" &&
          (signal?.aborted
            ? signal.reason instanceof CloudAcquisitionTimeoutError &&
              signal.reason.acquisitionStage === "connect"
            : error instanceof TimeoutError
              ? !error.message.includes("sandbox timeout")
              : connectGatewayTimeout !== undefined &&
                error === connectGatewayTimeout),
      }).catch(() => {});
    }
    signal?.throwIfAborted();
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
    let connectTargetFingerprint: string | null = null;
    if (
      phase === "connect" &&
      connectCluster &&
      typeof connectSandboxId === "string" &&
      /^[a-z0-9][a-z0-9-]{0,127}$/i.test(connectSandboxId)
    ) {
      try {
        // Correlate provider-selected identities without logging their raw IDs.
        connectTargetFingerprint = createHash("sha256")
          .update(`e2b-connect:v1:${connectCluster}:${connectSandboxId}`)
          .digest("hex");
      } catch {
        // Diagnostic enrichment must not replace the acquisition failure.
      }
    }
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
        e2b_connect_state: phase === "connect" ? connectState : null,
        e2b_connect_selection_source:
          phase === "connect" ? connectSelectionSource : null,
        // Null means the SDK default was used, not a measured timeout of zero.
        e2b_connect_request_timeout_ms:
          phase === "connect" ? connectRequestTimeoutMs : null,
        e2b_connect_target_fingerprint: connectTargetFingerprint,
        e2b_connect_cluster: phase === "connect" ? connectCluster : null,
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
