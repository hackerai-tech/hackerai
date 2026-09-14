import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxInfo } from "e2b";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import type { E2BClusterConfig } from "./e2b-cluster";
import {
  emptyWorkspaceProbeCommand,
  parseEmptyWorkspaceFingerprint,
} from "./empty-workspace-probe";
import {
  claimCloudMigration,
  CloudMigrationUnavailableError,
} from "./cloud-migration-state";
import { getPostHogFeatureFlagForUser, phLogger } from "@/lib/posthog/server";
import { miosaIdentityMetadata } from "./miosa-identity";

export const EMPTY_E2B_MIGRATION_FLAG =
  "miosa_empty_e2b_workspace_migration_v1";

export type ExistingE2BWorkspace = {
  info: SandboxInfo;
  cluster: E2BClusterConfig;
};

// Baselines are operator-reviewed deployment configuration, NEVER values read
// from the customer's VM. A missing/changed template is conservatively skipped.
function getBaseline(templateId: string): string | null {
  try {
    const raw = process.env.MIOSA_EMPTY_E2B_BASELINES_JSON;
    if (!raw || raw.length > 16384) return null;
    const baselines: unknown = JSON.parse(raw);
    if (!Array.isArray(baselines) || baselines.length > 100) return null;
    if (
      !baselines.every(
        (value) =>
          value &&
          value.version === 1 &&
          typeof value.templateId === "string" &&
          /^[a-f0-9]{64}$/.test(value.digest) &&
          Object.keys(value).sort().join(",") === "digest,templateId,version",
      )
    )
      return null;
    const matches = baselines.filter(
      (value) => value.templateId === templateId,
    );
    return matches.length === 1 ? matches[0].digest : null;
  } catch {
    return null;
  }
}

/** Called only after complete cross-cluster discovery and the paid-plan gate.
 * Success permanently pins future acquisition to Miosa BEFORE it can be created.
 * Failure leaves the source intact. Uncertain commit stays fenced for recovery. */
export async function tryMigrateEmptyE2BWorkspace(options: {
  userId: string;
  workspaces: ExistingE2BWorkspace[];
  triggerRegion?: TriggerRunRegion;
}): Promise<boolean> {
  const { userId, workspaces, triggerRegion } = options;
  const startedAt = Date.now();
  const report = (reason: string) =>
    phLogger.event("miosa_empty_e2b_migration_checked", {
      userId,
      reason,
      workspace_count: workspaces.length,
      duration_ms: Date.now() - startedAt,
      miosa_empty_e2b_migration_event_version: 1,
    });
  const environment = miosaIdentityMetadata(userId).environment;
  if (
    environment === "unknown" ||
    !(await getPostHogFeatureFlagForUser(EMPTY_E2B_MIGRATION_FLAG, userId, {
      hackerai_environment: environment,
    }))
  )
    return false;
  // Multiple workspaces and other regions are deferred, even if one looks empty.
  if (
    workspaces.length !== 1 ||
    workspaces[0].cluster.cluster !== "us" ||
    !triggerRegion ||
    triggerRegion === "eu-central-1"
  ) {
    report("unsupported_inventory");
    return false;
  }
  const { info, cluster } = workspaces[0];
  if (info.state !== "paused" || info.volumeMounts?.length) {
    report("active_or_mounted");
    return false;
  }
  const baseline = getBaseline(info.templateId);
  if (!baseline) {
    report("missing_baseline");
    return false;
  }

  const claim = await claimCloudMigration(
    userId,
    info.sandboxId,
    triggerRegion,
  );
  let commitStarted = false;
  try {
    const current = await Sandbox.getInfo(info.sandboxId, {
      ...cluster.connectionOptions,
      requestTimeoutMs: 5000,
    });
    if (
      current.state !== "paused" ||
      current.templateId !== info.templateId ||
      current.metadata.userID !== userId ||
      current.lifecycle?.onTimeout !== "pause" ||
      current.volumeMounts?.length
    ) {
      report("state_changed");
      return false;
    }
    const sandbox = await Sandbox.connect(info.sandboxId, {
      ...cluster.connectionOptions,
      timeoutMs: 120000,
      requestTimeoutMs: 5000,
    });
    // Paused does not mean idle: background commands can survive pause/resume.
    if ((await sandbox.commands.list({ requestTimeoutMs: 5000 })).length) {
      report("active_commands");
      return false;
    }
    const probe = async () => {
      const result = await sandbox.commands.run(emptyWorkspaceProbeCommand, {
        user: "root",
        cwd: "/",
        timeoutMs: 50000,
      });
      return result.exitCode === 0
        ? parseEmptyWorkspaceFingerprint(result.stdout)
        : null;
    };
    const first = await probe();
    if (!first || first.digest !== baseline) {
      report("files_or_unknown");
      return false;
    }
    // A second complete read catches writes/renames during the first traversal.
    const second = await probe();
    if (
      !second ||
      second.digest !== baseline ||
      (await sandbox.commands.list({ requestTimeoutMs: 5000 })).length
    ) {
      report("state_changed");
      return false;
    }
    commitStarted = true;
    await claim.commit();
    report("empty_verified");
    return true;
  } catch {
    if (commitStarted) throw new CloudMigrationUnavailableError();
    report("inspection_unavailable");
    return false;
  } finally {
    if (!commitStarted) {
      try {
        await claim.abandon();
      } catch {
        throw new CloudMigrationUnavailableError();
      }
    }
    // Do not kill, reset or force-pause the source. Its bounded lease auto-pauses
    // after inspection; an independently renewed active lease remains intact.
  }
}
