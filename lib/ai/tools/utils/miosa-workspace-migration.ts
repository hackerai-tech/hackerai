import { createHash } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import type { SubscriptionTier } from "@/types";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { phLogger } from "@/lib/posthog/server";
import {
  claimCloudMigration,
  CloudMigrationUnavailableError,
  readCloudMigrationState,
} from "./cloud-migration-state";
import {
  assertFreshMiosaEnrollment,
  type ExistingE2BWorkspace,
} from "./miosa-enrollment";
import {
  createMiosaClient,
  ensureMiosaSandboxConnection,
  type MiosaSandbox,
} from "./miosa-sandbox";
import { miosaExternalUserId } from "./miosa-identity";
import { isE2BFileMigrationEnabled } from "./miosa-workspace-migration-queue";
import { transferCommand } from "./workspace-transfer-program";
import { MIOSA_NATIVE_TEMPLATE_ID } from "./miosa-runtime";
import { waitForMiosaReadiness } from "./miosa-readiness";

const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
const CHUNK_BYTES = 4 * 1024 ** 2;
const digestPattern = /^[a-f0-9]{64}$/;
const migrationStages = [
  "source_inspection",
  "source_connection",
  "source_export",
  "destination_creation",
  "archive_transfer",
  "restore_verification",
  "source_verification",
  "cutover_preparation",
  "persistence_verification",
  "destination_cleanup",
  "commit",
] as const;
type MigrationStage = (typeof migrationStages)[number];
type MigrationFailureKind = "invalid_response" | "operation_failed" | "timeout";
type Capture = {
  digest: string;
  homeDigest: string;
  entries: number;
  bytes: number;
  archiveDigest: string;
  archiveBytes: number;
};

function migrationFailureKind(error: unknown): MigrationFailureKind {
  if (error instanceof SyntaxError) return "invalid_response";
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /\b(?:timeout|timed out)\b/i.test(error.message))
  )
    return "timeout";
  return "operation_failed";
}

function parseCapture(stdout: string): Capture {
  if (stdout.length > 1024) throw new Error("Invalid capture");
  const value = JSON.parse(stdout);
  if (
    value.version !== 1 ||
    !digestPattern.test(value.digest) ||
    !digestPattern.test(value.homeDigest) ||
    !digestPattern.test(value.archiveDigest) ||
    !Number.isSafeInteger(value.entries) ||
    value.entries < 1 ||
    value.entries > 250000 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > 12 * 1024 ** 3 ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes < 1 ||
    value.archiveBytes > MAX_ARCHIVE_BYTES
  )
    throw new Error("Invalid capture");
  return value;
}

/** Bounded in-memory chunks; no content, URLs or credentials in task payloads,
 * local files, logs, object storage, or child task results. */
export async function transferArchive(
  source: Sandbox,
  target: MiosaSandbox,
  stage: string,
  capture: Capture,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const hash = createHash("sha256");
  let bytes = 0;
  let pending = Buffer.alloc(CHUNK_BYTES);
  let used = 0;
  // The Miosa file API only accepts its supported upload roots. The destination
  // is still private; consume each uniquely named /tmp chunk into the root-only
  // staging directory and remove it before accepting another chunk.
  const uploadPath = `${stage.replace(/^\/\./, "/tmp/")}-chunk`;
  const flush = async () => {
    if (!used) return;
    await target.sdkSandbox.files.write(uploadPath, pending.subarray(0, used));
    const result = await target.sdkSandbox.exec.run(
      `umask 077; cat '${uploadPath}' >> '${stage}/source.tar.gz' && unlink '${uploadPath}'`,
      { timeoutSec: 60 },
    );
    if (result.exitCode !== 0) throw new Error("Transfer failed");
    used = 0;
    pending = Buffer.alloc(CHUNK_BYTES);
  };
  try {
    reader = (
      await source.files.read(`${stage}/source.tar.gz`, {
        format: "stream",
        user: "root",
        signal: controller.signal,
        requestTimeoutMs: 10000,
        streamIdleTimeoutMs: 60000,
      })
    ).getReader();
    while (true) {
      if (controller.signal.aborted) throw new Error("Transfer timeout");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > capture.archiveBytes || bytes > MAX_ARCHIVE_BYTES)
        throw new Error("Transfer size mismatch");
      hash.update(value);
      let offset = 0;
      while (offset < value.length) {
        const length = Math.min(CHUNK_BYTES - used, value.length - offset);
        pending.set(value.subarray(offset, offset + length), used);
        offset += length;
        used += length;
        if (used === CHUNK_BYTES) await flush();
      }
    }
    await flush();
    if (
      bytes !== capture.archiveBytes ||
      hash.digest("hex") !== capture.archiveDigest
    )
      throw new Error("Transfer digest mismatch");
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

export type E2BFileMigrationRequest = {
  userId: string;
  sourceId: string;
  subscription: SubscriptionTier;
  triggerRegion: TriggerRunRegion;
};

export async function migrateE2BWorkspace(request: E2BFileMigrationRequest) {
  const { userId, sourceId, triggerRegion } = request;
  const startedAt = Date.now();
  const report = (
    reason: string,
    properties: Record<string, unknown> = {},
    result: Record<string, unknown> = {},
  ) => {
    phLogger.event("miosa_e2b_file_migration_checked", {
      userId,
      reason,
      duration_ms: Date.now() - startedAt,
      migration_event_version: 2,
      ...properties,
    });
    return { reason, ...result };
  };
  if (
    triggerRegion === "eu-central-1" ||
    !(await isE2BFileMigrationEnabled(userId))
  )
    return report("not_selected");
  // Only native destinations have matching filesystem/command paths.
  if (
    (process.env.MIOSA_TEMPLATE_ID?.trim() || MIOSA_NATIVE_TEMPLATE_ID) !==
    MIOSA_NATIVE_TEMPLATE_ID
  )
    return report("unsupported_destination");
  if (await readCloudMigrationState(userId)) return report("already_claimed");
  const client = await createMiosaClient();
  const { NotFoundError } = await import("@miosa/sdk");
  try {
    await client.sandboxes.getByName(`${miosaExternalUserId(userId)}-v2`);
    return report("existing_miosa_workspace");
  } catch (error) {
    if (!(error instanceof NotFoundError))
      return report("destination_lookup_unavailable");
  }
  let workspaces: ExistingE2BWorkspace[] = [];
  await assertFreshMiosaEnrollment({
    userId,
    subscription: request.subscription,
    onExisting: async (found) => {
      workspaces = found;
      return true;
    },
  });
  if (
    workspaces.length !== 1 ||
    workspaces[0].cluster.cluster !== "us" ||
    workspaces[0].info.sandboxId !== sourceId ||
    workspaces[0].info.metadata.template !== workspaces[0].cluster.template ||
    workspaces[0].info.state !== "paused" ||
    workspaces[0].info.volumeMounts?.length
  )
    return report("unsupported_or_active_inventory");
  const claim = await claimCloudMigration(userId, sourceId, triggerRegion);
  if (!claim) return report("workspace_in_use");
  const stage = `/.hackerai-migration-${claim.token}`;
  let source: Sandbox | undefined;
  let target: MiosaSandbox | undefined;
  let sourceStageCreated = false;
  let commitStarted = false;
  let preparedName: string | undefined;
  let migrationStage: MigrationStage = "source_inspection";
  let stageStartedAt = Date.now();
  const stageDurationsMs: Partial<Record<MigrationStage, number>> = {};
  const startStage = (stage: MigrationStage) => {
    stageDurationsMs[migrationStage] = Date.now() - stageStartedAt;
    migrationStage = stage;
    stageStartedAt = Date.now();
  };
  const finishStage = () => {
    stageDurationsMs[migrationStage] = Date.now() - stageStartedAt;
  };
  try {
    const connection = workspaces[0].cluster.connectionOptions;
    const current = await Sandbox.getInfo(sourceId, {
      ...connection,
      requestTimeoutMs: 5000,
    });
    if (
      current.state !== "paused" ||
      current.metadata.userID !== userId ||
      current.metadata.template !== workspaces[0].cluster.template ||
      current.templateId !== workspaces[0].info.templateId ||
      current.lifecycle?.onTimeout !== "pause" ||
      current.volumeMounts?.length
    )
      return report("state_changed");
    startStage("source_connection");
    source = await Sandbox.connect(sourceId, {
      ...connection,
      timeoutMs: 2 * 60 * 60 * 1000,
      requestTimeoutMs: 10000,
    });
    if ((await source.commands.list()).length) return report("active_commands");
    startStage("source_export");
    sourceStageCreated = true;
    const exported = await source.commands.run(
      transferCommand("export", stage),
      { user: "root", cwd: "/", timeoutMs: 21 * 60 * 1000 },
    );
    if (exported.exitCode !== 0) throw new Error("Export failed");
    const capture = parseCapture(exported.stdout);
    startStage("destination_creation");
    preparedName = `${miosaExternalUserId(userId)}-migration-${claim.token}`;
    ({ sandbox: target } = await ensureMiosaSandboxConnection(
      { userID: userId, setSandbox: () => {} },
      { migrationName: preparedName },
    ));
    if (target.runtime !== "native") throw new Error("Unsupported destination");
    const initialized = await target.sdkSandbox.exec.run(
      `mkdir -m 700 '${stage}'`,
      { timeoutSec: 15 },
    );
    if (initialized.exitCode !== 0) throw new Error("Staging failed");
    startStage("archive_transfer");
    await transferArchive(source, target, stage, capture);
    startStage("restore_verification");
    const restored = await target.sdkSandbox.exec.run(
      transferCommand("restore", stage),
      { timeoutSec: 21 * 60 },
    );
    if (restored.exitCode !== 0 || restored.stdout.length > 1024)
      throw new Error("Restore failed");
    const proof = JSON.parse(restored.stdout);
    if (
      proof.archiveDigest !== capture.archiveDigest ||
      proof.homeDigest !== capture.homeDigest
    )
      throw new Error("Verification failed");
    startStage("source_verification");
    const verified = await source.commands.run(
      transferCommand("verify-source", stage),
      { user: "root", cwd: "/", timeoutMs: 21 * 60 * 1000 },
    );
    if (
      verified.exitCode !== 0 ||
      verified.stdout.length > 1024 ||
      JSON.parse(verified.stdout).digest !== capture.digest ||
      (await source.commands.list()).length
    )
      return report("source_changed");
    if (!(await isE2BFileMigrationEnabled(userId)))
      return report("rollout_stopped");
    startStage("cutover_preparation");
    const installed = await target.sdkSandbox.exec.run(
      transferCommand("install", stage),
      { timeoutSec: 60 },
    );
    if (installed.exitCode !== 0) throw new Error("Install failed");
    // The archive remains private to this user's VM, under a predictable path.
    const retained = await target.sdkSandbox.exec.run(
      `mkdir -p /var/lib/hackerai-migration && mv '${stage}/source.tar.gz' /var/lib/hackerai-migration/e2b-filesystem.tar.gz`,
      { timeoutSec: 60 },
    );
    if (retained.exitCode !== 0) throw new Error("Archive retention failed");
    const sourceCleanup = await source.commands.run(
      `python3 -I -c 'import shutil; shutil.rmtree("${stage}")'`,
      { user: "root", cwd: "/", timeoutMs: 60000 },
    );
    if (sourceCleanup.exitCode !== 0) throw new Error("Source cleanup failed");
    sourceStageCreated = false;
    // Under the exclusive fence, pause the source before publishing the copy.
    await source.betaPause();
    await target.sdkSandbox.pause();
    await target.sdkSandbox.resume();
    startStage("persistence_verification");
    await waitForMiosaReadiness(target.sdkSandbox, { fastStart: true });
    const retainedProof = await target.sdkSandbox.exec.run(
      `sha256sum /var/lib/hackerai-migration/e2b-filesystem.tar.gz`,
      { timeoutSec: 180 },
    );
    if (
      retainedProof.exitCode !== 0 ||
      retainedProof.stdout.split(/\s/)[0] !== capture.archiveDigest
    )
      throw new Error("Persistence verification failed");
    const homeProof = await target.sdkSandbox.exec.run(
      transferCommand("verify-home", stage),
      { timeoutSec: 21 * 60 },
    );
    if (
      homeProof.exitCode !== 0 ||
      homeProof.stdout.length > 1024 ||
      JSON.parse(homeProof.stdout).homeDigest !== capture.homeDigest
    )
      throw new Error("Workspace persistence verification failed");
    startStage("destination_cleanup");
    const cleaned = await target.sdkSandbox.exec.run(
      `python3 -I -c 'import shutil; shutil.rmtree("${stage}")'`,
      { timeoutSec: 60 },
    );
    if (cleaned.exitCode !== 0) throw new Error("Destination cleanup failed");
    if (!(await isE2BFileMigrationEnabled(userId)))
      return report("rollout_stopped");
    startStage("commit");
    commitStarted = true;
    await claim.commit(target.sandboxId);
    finishStage();
    return report("files_verified_and_committed", {
      file_entries: capture.entries,
      archive_bytes: capture.archiveBytes,
      stage_durations_ms: stageDurationsMs,
    });
  } catch (error) {
    if (commitStarted) throw new CloudMigrationUnavailableError();
    finishStage();
    const failureKind = migrationFailureKind(error);
    return report(
      "transfer_unavailable",
      {
        failure_stage: migrationStage,
        failure_kind: failureKind,
        failed_stage_duration_ms: stageDurationsMs[migrationStage],
        stage_durations_ms: stageDurationsMs,
      },
      {
        failureStage: migrationStage,
        failureKind,
        failedStageDurationMs: stageDurationsMs[migrationStage],
      },
    );
  } finally {
    if (!commitStarted) {
      // A failed or uncertain create may exist even without a returned SDK.
      // Do not release the fence until that exact private destination is gone.
      if (preparedName) {
        const client = await createMiosaClient();
        const { NotFoundError } = await import("@miosa/sdk");
        try {
          await (await client.sandboxes.getByName(preparedName)).destroy();
        } catch (error) {
          if (!(error instanceof NotFoundError))
            throw new CloudMigrationUnavailableError();
        }
      }
      if (source && sourceStageCreated) {
        try {
          const cleanup = await source.commands.run(
            `python3 -I -c 'import os, shutil; p="${stage}"; shutil.rmtree(p) if os.path.lexists(p) else None'`,
            { user: "root", cwd: "/", timeoutMs: 60000 },
          );
          if (cleanup.exitCode !== 0)
            throw new CloudMigrationUnavailableError();
        } catch {
          throw new CloudMigrationUnavailableError();
        }
      }
      await claim.abandon();
    }
  }
}
