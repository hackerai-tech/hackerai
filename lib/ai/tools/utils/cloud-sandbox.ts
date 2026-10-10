import type { AnySandbox, SandboxBootInfo, SubscriptionTier } from "@/types";
import { randomUUID } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import type {
  CloudSandboxProvider,
  CloudSandboxSelectionReason,
} from "./cloud-sandbox-provider";
import { ensureSandboxConnection, E2BAcquisitionError } from "./sandbox";
import { isE2BSandbox } from "./sandbox-types";
import { phLogger } from "@/lib/posthog/server";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import {
  getConfiguredE2BClustersForCleanup,
  getE2BClusterRouting,
} from "./e2b-cluster";
import {
  readCloudWorkspaceState,
  assertCloudWorkspaceAvailable,
  CloudWorkspaceUnavailableError,
  claimCloudWorkspaceCleanup,
  registerE2BWorkspaceLease,
} from "./cloud-workspace-guard";

export type CloudSandboxAcquisitionContext = {
  signal?: AbortSignal;
  onTimeout?: () => void;
  acquisitionId?: string;
  provider?: CloudSandboxProvider;
  selectionReason?: CloudSandboxSelectionReason;
  subscription?: SubscriptionTier;
  chatId?: string;
  triggerRunId?: string;
  runKind?: "parent" | "subagent";
  triggerRegion?: TriggerRunRegion;
  environment?: string;
};

export async function ensureCloudSandboxConnection(options: {
  userId: string;
  signal?: AbortSignal;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}): Promise<{ sandbox: Sandbox; provider: CloudSandboxProvider }> {
  const startedAt = Date.now();
  const acquisitionId = randomUUID();
  let bootInfo: SandboxBootInfo | undefined;
  let selectionReason = options.context?.selectionReason ?? "e2b_only";
  const recordOutcome = (outcome: "success" | "error") => {
    const fields = {
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      acquisition_id: acquisitionId,
      agent_run_kind: options.context?.runKind ?? "parent",
      subscription_tier: options.context?.subscription,
      trigger_region: options.context?.triggerRegion,
      preferred_provider: "e2b",
      provider_selection_reason: selectionReason,
      sandbox_provider: "e2b",
      sandbox_type: "cloud",
      outcome,
      fallback_used: false,
      duration_ms: Date.now() - startedAt,
      sandbox_boot_path: bootInfo?.path,
      image_version: bootInfo?.image_version,
      sandbox_create_attempts: bootInfo?.create_attempts,
      cloud_sandbox_acquisition_completed_event_version: 1,
    };
    if (outcome === "error")
      console.warn("Cloud sandbox acquisition completed", fields);
    else console.info("Cloud sandbox acquisition completed", fields);
    phLogger.event("cloud_sandbox_acquisition_completed", {
      ...fields,
      userId: options.userId,
    });
  };

  try {
    options.signal?.throwIfAborted();
    const state = await readCloudWorkspaceState(options.userId);
    options.signal?.throwIfAborted();
    if (state) {
      if (
        state.phase !== "e2b" ||
        !options.context?.triggerRegion ||
        getE2BClusterRouting(state.region).createCluster.cluster !==
          getE2BClusterRouting(options.context.triggerRegion).createCluster
            .cluster
      )
        throw new CloudWorkspaceUnavailableError();
      selectionReason = "recovered_workspace";
    }
    const result = await ensureSandboxConnection(
      {
        userID: options.userId,
        // Publish only after the workspace guard is rechecked below.
        setSandbox: () => {},
        onBoot: (info) => {
          bootInfo = info;
          options.onBoot?.(info);
        },
      },
      {
        signal: options.signal,
        initialSandbox:
          options.initialSandbox && isE2BSandbox(options.initialSandbox)
            ? options.initialSandbox
            : null,
        triggerRegion: options.context?.triggerRegion,
        acquisitionId,
        triggerRunId: options.context?.triggerRunId,
        destinationId: state?.phase === "e2b" ? state.destinationId : undefined,
      },
    );
    await assertCloudWorkspaceAvailable(
      options.userId,
      result.sandbox.sandboxId,
    );
    registerE2BWorkspaceLease(result.sandbox, options.userId);
    options.signal?.throwIfAborted();
    options.setSandbox(result.sandbox);
    recordOutcome("success");
    return { ...result, provider: "e2b" };
  } catch (error) {
    recordOutcome("error");
    phLogger.event("cloud_sandbox_acquisition_failed", {
      userId: options.userId,
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      acquisition_id: acquisitionId,
      provider: "e2b",
      sandbox_type: "cloud",
      sandbox_provider: "e2b",
      cloud_sandbox_transport: "e2b_sdk",
      subscription: options.context?.subscription,
      subscription_tier: options.context?.subscription,
      agent_run_kind: options.context?.runKind ?? "parent",
      trigger_region: options.context?.triggerRegion,
      failure_stage: "ensure_cloud_sandbox",
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof E2BAcquisitionError ? error.diagnostics : {}),
      cloud_sandbox_acquisition_failed_event_version: 6,
    });
    throw error;
  }
}

export async function terminateCloudSandboxesForUser(
  userId: string,
  options: { permanent?: boolean } = {},
): Promise<{ total: number; killed: number; alreadyGone: number }> {
  const cleanup = await claimCloudWorkspaceCleanup(userId, !!options.permanent);
  let success = false;
  try {
    if (cleanup.migration && !process.env.E2B_API_KEY?.trim())
      throw new CloudWorkspaceUnavailableError();
    const totals = { total: 0, killed: 0, alreadyGone: 0 };
    const failures: unknown[] = [];
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
            console.error(
              `Failed to kill sandbox ${sandbox.sandboxId}:`,
              error,
            );
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
    if (failures.length > 1)
      throw new AggregateError(failures, "Cloud sandbox cleanup failed");
    success = true;
    return totals;
  } finally {
    await cleanup.finish(success);
  }
}
