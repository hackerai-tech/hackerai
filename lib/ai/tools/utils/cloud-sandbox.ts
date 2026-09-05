import type { AnySandbox, SandboxBootInfo } from "@/types";
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
    cloud_sandbox_acquisition_failed_event_version: 4,
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

  if (preferredProvider === "miosa") {
    try {
      if (options.initialSandbox && isE2BSandbox(options.initialSandbox)) {
        throw new MiosaEnrollmentError("existing_e2b_workspace");
      }
      const result = await ensureMiosaCloudSandboxConnection(options);
      recordRolloutExposure(options);
      return { ...result, provider: "miosa" };
    } catch (error) {
      if (error instanceof MiosaEnrollmentError) {
        phLogger.event("miosa_cloud_sandbox_enrollment_denied", {
          userId: options.userId,
          chat_id: options.context?.chatId,
          trigger_run_id: options.context?.triggerRunId,
          subscription_tier: options.context?.subscription,
          reason: error.reason,
          sandbox_provider: "e2b",
          sandbox_type: "cloud",
          miosa_cloud_sandbox_enrollment_denied_event_version: 1,
        });
      } else {
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
          error_name: error instanceof Error ? error.name : "UnknownError",
          cloud_sandbox_provider_fallback_event_version: 2,
        });
      }
    }
  } else {
    recordRolloutExposure(options);
  }

  try {
    const result = await ensureE2BCloudSandboxConnection(options);
    return { ...result, provider: "e2b" };
  } catch (error) {
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
      const { Sandbox } = await import("@e2b/code-interpreter");
      const paginator = Sandbox.list({
        ...cluster.connectionOptions,
        query: { metadata: { userID: userId } },
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
