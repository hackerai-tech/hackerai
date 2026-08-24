import type { AnySandbox, SandboxBootInfo } from "@/types";
import type { SubscriptionTier } from "@/types";
import {
  getCloudSandboxProvider,
  type CloudSandboxProvider,
} from "./cloud-sandbox-provider";
import { ensureSandboxConnection } from "./sandbox";
import { isAwsLambdaMicrovmSandbox, isE2BSandbox } from "./sandbox-types";
import { phLogger } from "@/lib/posthog/server";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";

export type CloudSandboxAcquisitionContext = {
  provider?: CloudSandboxProvider;
  subscription?: SubscriptionTier;
  chatId?: string;
  triggerRunId?: string;
  runKind?: "parent" | "subagent";
  triggerRegion?: TriggerRunRegion;
};

export type CloudSandboxSuspensionSummary = {
  total: number;
  suspended: number;
  alreadySuspended: number;
  terminated: number;
  alreadyGone: number;
  workspacesSaved: number;
};

export async function ensureCloudSandboxConnection(options: {
  userId: string;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}): Promise<{ sandbox: AnySandbox }> {
  const provider = options.context?.provider ?? getCloudSandboxProvider();
  const startedAt = Date.now();
  try {
    if (provider === "aws-lambda-microvm") {
      if (isAwsLambdaMicrovmSandbox(options.initialSandbox ?? null)) {
        return { sandbox: options.initialSandbox! };
      }
      const { ensureAwsLambdaMicrovmConnection } =
        await import("./aws-lambda-microvm");
      const sandbox = await ensureAwsLambdaMicrovmConnection(
        options.userId,
        options.onBoot,
        options.context?.triggerRegion,
        options.context?.triggerRunId,
      );
      options.setSandbox(sandbox);
      return { sandbox };
    }

    return await ensureSandboxConnection(
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
      },
    );
  } catch (error) {
    phLogger.event("cloud_sandbox_acquisition_failed", {
      userId: options.userId,
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      provider,
      cloud_sandbox_transport:
        provider === "aws-lambda-microvm" ? "aws_websocket" : "e2b_sdk",
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
  const provider = getCloudSandboxProvider();
  const totals = { total: 0, killed: 0, alreadyGone: 0 };

  // Cloud provider selection can change during a rollback. Clean up persisted
  // AWS sessions independently of the provider currently selected.
  if (process.env.CONVEX_SERVICE_ROLE_KEY) {
    const { terminateAwsLambdaMicrovmForUser } =
      await import("./aws-lambda-microvm");
    const aws = await terminateAwsLambdaMicrovmForUser(userId);
    totals.total += aws.total;
    totals.killed += aws.killed;
    totals.alreadyGone += aws.alreadyGone;
  } else if (provider === "aws-lambda-microvm") {
    throw new Error(
      "CONVEX_SERVICE_ROLE_KEY is required to delete AWS Lambda MicroVMs",
    );
  }

  // E2B does not persist provider rows in Convex, so query it whenever its
  // credentials remain configured (including during an AWS migration).
  if (process.env.E2B_API_KEY) {
    const paginator = (await import("@e2b/code-interpreter")).Sandbox.list({
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
    const { Sandbox } = await import("@e2b/code-interpreter");
    for (const sandbox of sandboxes) {
      try {
        await Sandbox.kill(sandbox.sandboxId);
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

  if (process.env.CONVEX_SERVICE_ROLE_KEY) {
    const { deleteAwsLambdaMicrovmWorkspace } =
      await import("./aws-lambda-microvm-workspace");
    await deleteAwsLambdaMicrovmWorkspace(
      userId,
      process.env.CONVEX_SERVICE_ROLE_KEY,
    );
  }
  return totals;
}

export async function suspendCloudSandboxesForUser(
  userId: string,
): Promise<CloudSandboxSuspensionSummary> {
  if (getCloudSandboxProvider() !== "aws-lambda-microvm") {
    return {
      total: 0,
      suspended: 0,
      alreadySuspended: 0,
      terminated: 0,
      alreadyGone: 0,
      workspacesSaved: 0,
    };
  }

  const { suspendAwsLambdaMicrovmsForUser } =
    await import("./aws-lambda-microvm");
  return suspendAwsLambdaMicrovmsForUser(userId);
}
