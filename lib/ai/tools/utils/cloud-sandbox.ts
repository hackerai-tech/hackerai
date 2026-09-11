import type { AnySandbox, SandboxBootInfo } from "@/types";
import { Sandbox } from "@e2b/code-interpreter";
import type { SubscriptionTier } from "@/types";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider";
import type { CloudSandboxSelectionReason } from "./cloud-sandbox-provider";
import { ensureSandboxConnection } from "./sandbox";
import { isE2BSandbox, isMiosaSandbox } from "./sandbox-types";
import {
  ensureMiosaSandboxConnection,
  terminateMiosaSandboxesForUser,
} from "./miosa-sandbox";
import { phLogger } from "@/lib/posthog/server";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getConfiguredE2BClustersForCleanup } from "./e2b-cluster";
import {
  assertFreshMiosaEnrollment,
  MiosaEnrollmentError,
} from "./miosa-enrollment";
import { miosaErrorDiagnostics } from "./miosa-acquisition-diagnostics";

export type CloudSandboxAcquisitionContext = {
  provider?: CloudSandboxProvider;
  selectionReason?: CloudSandboxSelectionReason;
  subscription?: SubscriptionTier;
  chatId?: string;
  triggerRunId?: string;
  runKind?: "parent" | "subagent";
  triggerRegion?: TriggerRunRegion;
};

const ensureE2BCloudSandboxConnection = (options: {
  userId: string;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}) =>
  ensureSandboxConnection(
    {
      userID: options.userId,
      setSandbox: options.setSandbox,
      onBoot: options.onBoot,
    },
    {
      initialSandbox:
        options.initialSandbox && isE2BSandbox(options.initialSandbox)
          ? options.initialSandbox
          : null,
      triggerRegion: options.context?.triggerRegion,
    },
  );

const ensureMiosaCloudSandboxConnection = (options: {
  userId: string;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}) =>
  ensureMiosaSandboxConnection(
    {
      userID: options.userId,
      setSandbox: options.setSandbox,
      onBoot: options.onBoot,
    },
    {
      initialSandbox:
        options.initialSandbox && isMiosaSandbox(options.initialSandbox)
          ? options.initialSandbox
          : null,
      beforeCreate: () =>
        assertFreshMiosaEnrollment({
          userId: options.userId,
          subscription: options.context?.subscription,
        }),
      onDiagnostic: (diagnostic) => {
        const fields = {
          ...diagnostic,
          chat_id: options.context?.chatId,
          trigger_run_id: options.context?.triggerRunId,
          agent_run_kind: options.context?.runKind ?? "parent",
          trigger_region: options.context?.triggerRegion,
          sandbox_provider: "miosa",
          sandbox_type: "cloud",
          miosa_sandbox_acquisition_step_event_version: 1,
        };
        // Explicit console output keeps the evidence in Trigger's run trace
        // even when PostHog's log drain is enabled or ingestion is delayed.
        console.info("MIOSA sandbox acquisition step", {
          ...fields,
          timestamp: new Date().toISOString(),
        });
        phLogger.event("miosa_sandbox_acquisition_step", {
          ...fields,
          userId: options.userId,
        });
      },
    },
  );

const recordAcquisitionFailure = (options: {
  userId: string;
  provider: CloudSandboxProvider;
  startedAt: number;
  error: unknown;
  context?: CloudSandboxAcquisitionContext;
}): void => {
  phLogger.event("cloud_sandbox_acquisition_failed", {
    userId: options.userId,
    chat_id: options.context?.chatId,
    trigger_run_id: options.context?.triggerRunId,
    provider: options.provider,
    sandbox_type: "cloud",
    sandbox_provider: options.provider,
    cloud_sandbox_transport:
      options.provider === "miosa" ? "miosa_sdk" : "e2b_sdk",
    subscription: options.context?.subscription,
    subscription_tier: options.context?.subscription,
    agent_run_kind: options.context?.runKind ?? "parent",
    trigger_region: options.context?.triggerRegion,
    failure_stage: "ensure_cloud_sandbox",
    duration_ms: Date.now() - options.startedAt,
    error_name:
      options.error instanceof Error ? options.error.name : "UnknownError",
    ...(options.provider === "miosa"
      ? miosaErrorDiagnostics(options.error)
      : {}),
    cloud_sandbox_acquisition_failed_event_version: 5,
  });
};

const recordRolloutExposure = (options: {
  userId: string;
  context?: CloudSandboxAcquisitionContext;
}): void => {
  const reason = options.context?.selectionReason;
  if (reason !== "miosa_rollout" && reason !== "miosa_rollout_control") {
    return;
  }
  const variant = reason === "miosa_rollout" ? "miosa" : "e2b";
  phLogger.event("miosa_cloud_sandbox_rollout_exposed", {
    userId: options.userId,
    ...(options.context?.triggerRunId && {
      eventUuid: `${options.context.triggerRunId}:miosa-cloud-sandbox-rollout-v1`,
    }),
    chat_id: options.context?.chatId,
    trigger_run_id: options.context?.triggerRunId,
    variant,
    subscription_tier: options.context?.subscription,
    agent_run_kind: options.context?.runKind ?? "parent",
    miosa_cloud_sandbox_rollout_exposed_event_version: 1,
  });
};

export async function ensureCloudSandboxConnection(options: {
  userId: string;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}): Promise<{ sandbox: AnySandbox; provider: CloudSandboxProvider }> {
  const startedAt = Date.now();
  const preferredProvider = options.context?.provider ?? "e2b";
  let bootInfo: SandboxBootInfo | undefined;
  let fallbackUsed = false;
  let enrollmentDeniedReason: MiosaEnrollmentError["reason"] | undefined;
  const onBoot = options.onBoot;
  options = {
    ...options,
    onBoot: (info) => {
      bootInfo = info;
      onBoot?.(info);
    },
  };
  // One outcome per acquisition, including failed attempts and the full wait
  // across providers. Aggregate by run ID, not raw event count, for run metrics.
  const recordOutcome = (
    provider: CloudSandboxProvider,
    outcome: "success" | "error",
  ) => {
    phLogger.event("cloud_sandbox_acquisition_completed", {
      userId: options.userId,
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      agent_run_kind: options.context?.runKind ?? "parent",
      subscription_tier: options.context?.subscription,
      trigger_region: options.context?.triggerRegion,
      preferred_provider: preferredProvider,
      provider_selection_reason:
        options.context?.selectionReason ?? "configured",
      sandbox_provider: provider,
      sandbox_type: "cloud",
      outcome,
      fallback_used: fallbackUsed,
      enrollment_denied_reason: enrollmentDeniedReason,
      duration_ms: Date.now() - startedAt,
      sandbox_boot_path: bootInfo?.path,
      image_version: bootInfo?.image_version,
      sandbox_create_attempts: bootInfo?.create_attempts,
      cloud_sandbox_acquisition_completed_event_version: 1,
    });
  };

  if (preferredProvider === "miosa") {
    try {
      if (options.initialSandbox && isE2BSandbox(options.initialSandbox)) {
        throw new MiosaEnrollmentError("existing_e2b_workspace");
      }
      const result = await ensureMiosaCloudSandboxConnection(options);
      recordRolloutExposure(options);
      recordOutcome("miosa", "success");
      return { ...result, provider: "miosa" };
    } catch (error) {
      if (error instanceof MiosaEnrollmentError) {
        enrollmentDeniedReason = error.reason;
        phLogger.event("miosa_cloud_sandbox_enrollment_denied", {
          userId: options.userId,
          chat_id: options.context?.chatId,
          trigger_run_id: options.context?.triggerRunId,
          subscription_tier: options.context?.subscription,
          reason: error.reason,
          discovery_cluster: error.discoveryFailure?.cluster,
          discovery_failure_kind: error.discoveryFailure?.kind,
          discovery_http_status: error.discoveryFailure?.httpStatus,
          discovery_elapsed_ms: error.discoveryFailure?.elapsedMs,
          sandbox_provider: "e2b",
          sandbox_type: "cloud",
          miosa_cloud_sandbox_enrollment_denied_event_version: 2,
        });
      } else {
        fallbackUsed = true;
        recordRolloutExposure(options);
        recordAcquisitionFailure({
          userId: options.userId,
          provider: "miosa",
          startedAt,
          error,
          context: options.context,
        });
        phLogger.event("cloud_sandbox_provider_fallback", {
          userId: options.userId,
          chat_id: options.context?.chatId,
          trigger_run_id: options.context?.triggerRunId,
          from_provider: "miosa",
          to_provider: "e2b",
          sandbox_type: "cloud",
          sandbox_provider: "e2b",
          fallback_stage: "acquisition",
          error_name: miosaErrorDiagnostics(error).error_name,
          cloud_sandbox_provider_fallback_event_version: 3,
        });
      }
    }
  } else {
    recordRolloutExposure(options);
  }

  try {
    const result = await ensureE2BCloudSandboxConnection(options);
    recordOutcome("e2b", "success");
    return { ...result, provider: "e2b" };
  } catch (error) {
    recordOutcome("e2b", "error");
    recordAcquisitionFailure({
      userId: options.userId,
      provider: "e2b",
      startedAt,
      error,
      context: options.context,
    });
    throw error;
  }
}

export async function terminateCloudSandboxesForUser(userId: string): Promise<{
  total: number;
  killed: number;
  alreadyGone: number;
}> {
  const totals = { total: 0, killed: 0, alreadyGone: 0 };
  const failures: unknown[] = [];

  if (process.env.MIOSA_API_KEY) {
    try {
      const result = await terminateMiosaSandboxesForUser(userId);
      totals.total += result.total;
      totals.killed += result.killed;
      totals.alreadyGone += result.alreadyGone;
    } catch (error) {
      failures.push(error);
      console.error("Failed to clean up MIOSA sandboxes:", error);
    }
  }

  for (const cluster of getConfiguredE2BClustersForCleanup()) {
    try {
      const paginator = Sandbox.list({
        ...cluster.connectionOptions,
        // Never rely on a cluster's default list filter during data deletion.
        query: { metadata: { userID: userId }, state: ["running", "paused"] },
      });
      const sandboxes = [];
      do {
        sandboxes.push(...(await paginator.nextItems()));
      } while (paginator.hasNext);
      let killed = 0;
      let alreadyGone = 0;
      const { isExpectedMissingResourceCleanupError } =
        await import("@/lib/utils/cleanup-errors");
      for (const sandbox of sandboxes) {
        try {
          if (cluster.connectionOptions) {
            await Sandbox.kill(sandbox.sandboxId, cluster.connectionOptions);
          } else {
            await Sandbox.kill(sandbox.sandboxId);
          }
          killed++;
        } catch (error) {
          if (isExpectedMissingResourceCleanupError(error)) {
            alreadyGone++;
            console.debug(
              `Sandbox ${sandbox.sandboxId} was already gone during delete`,
              error,
            );
            continue;
          }
          console.error(`Failed to kill sandbox ${sandbox.sandboxId}:`, error);
          throw error;
        }
      }
      totals.total += sandboxes.length;
      totals.killed += killed;
      totals.alreadyGone += alreadyGone;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Cloud sandbox cleanup failed");
  }
  return totals;
}
