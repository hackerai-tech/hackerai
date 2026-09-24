import type { SubscriptionTier } from "@/types";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getPostHogFeatureFlagForUser, phLogger } from "@/lib/posthog/server";
import { miosaIdentityMetadata, miosaExternalUserId } from "./miosa-identity";
import type { ExistingE2BWorkspace } from "./miosa-enrollment";

export const E2B_FILE_MIGRATION_FLAG = "miosa_e2b_file_migration_v1";
export const E2B_FILE_MIGRATION_TASK = "miosa-e2b-file-migration";

function resolveMigrationEnvironment(userId: string, environment?: string) {
  const selected = environment?.trim().toLowerCase();
  return selected && ["production", "preview", "development"].includes(selected)
    ? selected
    : miosaIdentityMetadata(userId).environment;
}

export async function isE2BFileMigrationEnabled(
  userId: string,
  environment?: string,
) {
  const resolvedEnvironment = resolveMigrationEnvironment(userId, environment);
  return (
    resolvedEnvironment !== "unknown" &&
    (await getPostHogFeatureFlagForUser(E2B_FILE_MIGRATION_FLAG, userId, {
      hackerai_environment: resolvedEnvironment,
    })) === true
  );
}

/** Acquisition only schedules work. This request continues on E2B; a delayed
 * worker must independently win the idle fence before it touches either VM. */
export async function queueE2BFileMigration(options: {
  userId: string;
  subscription?: SubscriptionTier;
  triggerRegion?: TriggerRunRegion;
  environment?: string;
  workspaces: ExistingE2BWorkspace[];
}): Promise<false> {
  const { userId, subscription, triggerRegion, environment, workspaces } =
    options;
  if (
    !subscription ||
    subscription === "free" ||
    !triggerRegion ||
    triggerRegion === "eu-central-1" ||
    workspaces.length !== 1 ||
    workspaces[0].cluster.cluster !== "us" ||
    workspaces[0].info.metadata.template !== workspaces[0].cluster.template ||
    workspaces[0].info.volumeMounts?.length
  )
    return false;
  try {
    if (!(await isE2BFileMigrationEnabled(userId, environment))) return false;
    const { tasks, idempotencyKeys } = await import("@trigger.dev/sdk");
    // Raw keys are scoped to the parent Agent run inside Trigger. All Agents
    // nominating this source must share a key within the execution environment.
    const idempotencyKey = await idempotencyKeys.create(
      `${E2B_FILE_MIGRATION_TASK}:${miosaExternalUserId(userId)}:${workspaces[0].info.sandboxId}`,
      { scope: "global" },
    );
    await tasks.trigger(
      E2B_FILE_MIGRATION_TASK,
      {
        userId,
        subscription,
        triggerRegion,
        sourceId: workspaces[0].info.sandboxId,
      },
      {
        delay: "20m",
        region: triggerRegion,
        idempotencyKey,
        // Cover the initial delay, idle waits, three two-hour attempts and
        // retry backoff. The durable fence still protects against later jobs.
        idempotencyKeyTTL: "12h",
      },
    );
  } catch {
    // Scheduling is best effort and must never interrupt the existing workspace.
    phLogger.event("miosa_e2b_file_migration_checked", {
      userId,
      reason: "queue_unavailable",
      migration_event_version: 1,
    });
  }
  return false;
}
