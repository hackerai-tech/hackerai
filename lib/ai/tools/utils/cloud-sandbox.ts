import type { AnySandbox, SandboxBootInfo } from "@/types";
import type { SubscriptionTier } from "@/types";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider";
import { ensureSandboxConnection } from "./sandbox";
import { isE2BSandbox } from "./sandbox-types";
import { phLogger } from "@/lib/posthog/server";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getConfiguredE2BClustersForCleanup } from "./e2b-cluster";

export type CloudSandboxAcquisitionContext = {
  provider?: CloudSandboxProvider;
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

export async function ensureCloudSandboxConnection(options: {
  userId: string;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}): Promise<{ sandbox: AnySandbox }> {
  const startedAt = Date.now();
  try {
    return await ensureE2BCloudSandboxConnection(options);
  } catch (error) {
    phLogger.event("cloud_sandbox_acquisition_failed", {
      userId: options.userId,
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      provider: "e2b",
      cloud_sandbox_transport: "e2b_sdk",
      subscription: options.context?.subscription,
      subscription_tier: options.context?.subscription,
      agent_run_kind: options.context?.runKind ?? "parent",
      trigger_region: options.context?.triggerRegion,
      failure_stage: "ensure_cloud_sandbox",
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError",
      cloud_sandbox_acquisition_failed_event_version: 2,
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

  for (const cluster of getConfiguredE2BClustersForCleanup()) {
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
  }

  return totals;
}
