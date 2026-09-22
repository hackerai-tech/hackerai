import { createHash } from "node:crypto";
import { CommandExitError, Sandbox } from "@e2b/code-interpreter";
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
import {
  miosaAcquisitionDiagnosticFields,
  miosaAcquisitionFailureDiagnostics,
  miosaErrorDiagnostics,
  type MiosaAcquisitionDiagnostic,
} from "./miosa-acquisition-diagnostics";
import { miosaExternalUserId } from "./miosa-identity";
import { isE2BFileMigrationEnabled } from "./miosa-workspace-migration-queue";
import { transferCommand } from "./workspace-transfer-program";
import { MIOSA_NATIVE_TEMPLATE_ID } from "./miosa-runtime";
import { waitForMiosaReadiness } from "./miosa-readiness";

const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
const CHUNK_BYTES = 4 * 1024 ** 2;
const TRANSIENT_OPERATION_ATTEMPTS = 3;
const MIOSA_MIGRATION_NAME_PREFIX = "hackerai-mig-";
const MIOSA_MIGRATION_NAME_HASH_LENGTH = 22;
const digestPattern = /^[a-f0-9]{64}$/;
const sourceExportRejections = [
  "changed",
  "external_hardlink",
  "external_symlink",
  "limit",
  "mount",
  "socket",
  "unsupported_entry",
  "unsupported_workspace_entry",
  "virtual_mount",
  "workspace_mount",
  "workspace_root",
] as const;
type SourceExportRejection = (typeof sourceExportRejections)[number];
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
const migrationOperations = [
  "source_connect",
  "source_command_list",
  "source_stream_open",
  "source_stream_read",
  "destination_chunk_upload",
  "destination_chunk_append",
  "archive_integrity",
] as const;
type MigrationOperation = (typeof migrationOperations)[number];
type Capture = {
  digest: string;
  homeDigest: string;
  entries: number;
  bytes: number;
  archiveDigest: string;
  archiveBytes: number;
};

export const miosaMigrationDestinationName = (
  userId: string,
  claimToken: string,
): string =>
  `${MIOSA_MIGRATION_NAME_PREFIX}${createHash("sha256")
    .update(`${miosaExternalUserId(userId)}:${claimToken}`)
    .digest("hex")
    .slice(0, MIOSA_MIGRATION_NAME_HASH_LENGTH)}`;

class MigrationOperationError extends Error {
  constructor(
    readonly operation: MigrationOperation,
    options?: ErrorOptions,
  ) {
    super(`Migration operation failed during ${operation}`, options);
    this.name = "MigrationOperationError";
  }
}

function isRetryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    retryable?: unknown;
  };
  return (
    candidate.retryable === true ||
    candidate.name === "TimeoutError" ||
    candidate.name === "NetworkError" ||
    candidate.code === "TIMEOUT" ||
    candidate.code === "NETWORK_ERROR" ||
    (error instanceof Error && /\b(?:timeout|timed out)\b/i.test(error.message))
  );
}

const retryDelay = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));

async function retryTransientOperation<T>(
  operation: MigrationOperation,
  callback: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSIENT_OPERATION_ATTEMPTS; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (
        attempt + 1 === TRANSIENT_OPERATION_ATTEMPTS ||
        !isRetryableTransportError(error)
      )
        throw new MigrationOperationError(operation, { cause: error });
      await retryDelay(attempt);
    }
  }
  throw new MigrationOperationError(operation, { cause: lastError });
}

function parseSourceExportRejection(
  stdout: string,
): SourceExportRejection | undefined {
  if (stdout.length > 1024) return undefined;
  try {
    const value = JSON.parse(stdout);
    return sourceExportRejections.find((reason) => reason === value.failure);
  } catch {
    return undefined;
  }
}

function migrationFailureKind(error: unknown): MigrationFailureKind {
  if (error instanceof MigrationOperationError && error.cause)
    return migrationFailureKind(error.cause);
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
  let appendedBytes = 0;
  let pending = Buffer.alloc(CHUNK_BYTES);
  let used = 0;
  // The Miosa file API only accepts its supported upload roots. The destination
  // is still private; consume each uniquely named /tmp chunk into the root-only
  // staging directory and remove it before accepting another chunk.
  const uploadPath = `${stage.replace(/^\/\./, "/tmp/")}-chunk`;
  const flush = async () => {
    if (!used) return;
    const chunk = pending.subarray(0, used);
    const expectedOffset = appendedBytes;
    const expectedSize = expectedOffset + used;
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < TRANSIENT_OPERATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await target.sdkSandbox.files.write(uploadPath, chunk);
      } catch (error) {
        lastError = new MigrationOperationError("destination_chunk_upload", {
          cause: error,
        });
        if (
          attempt + 1 === TRANSIENT_OPERATION_ATTEMPTS ||
          !isRetryableTransportError(error)
        )
          throw lastError;
        await retryDelay(attempt);
        continue;
      }
      try {
        // A timed-out exec may have written some or all of the chunk. Retrying
        // overwrites the same byte range and truncates to the expected size, so
        // an uncertain result cannot duplicate or retain partial bytes.
        const result = await target.sdkSandbox.exec.run(
          `python3 -I -c 'import os; s="${uploadPath}"; d="${stage}/source.tar.gz"; data=open(s,"rb").read(); assert len(data)==${used}; f=open(d,"r+b" if os.path.exists(d) else "w+b"); f.seek(${expectedOffset}); f.write(data); f.truncate(${expectedSize}); f.flush(); os.fsync(f.fileno()); f.close(); os.unlink(s)'`,
          { timeoutSec: 60 },
        );
        if (result.timedOut)
          throw new MigrationOperationError("destination_chunk_append", {
            cause: new DOMException("Transfer timeout", "TimeoutError"),
          });
        if (result.exitCode !== 0)
          throw new MigrationOperationError("destination_chunk_append");
        appendedBytes = expectedSize;
        used = 0;
        pending = Buffer.alloc(CHUNK_BYTES);
        return;
      } catch (error) {
        const transferError =
          error instanceof MigrationOperationError
            ? error
            : new MigrationOperationError("destination_chunk_append", {
                cause: error,
              });
        lastError = transferError;
        const cause = transferError.cause ?? transferError;
        if (
          attempt + 1 === TRANSIENT_OPERATION_ATTEMPTS ||
          !isRetryableTransportError(cause)
        )
          throw transferError;
        await retryDelay(attempt);
      }
    }
    throw lastError;
  };
  try {
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
    } catch (error) {
      throw new MigrationOperationError("source_stream_open", { cause: error });
    }
    while (true) {
      if (controller.signal.aborted)
        throw new MigrationOperationError("source_stream_read", {
          cause: new DOMException("Transfer timeout", "TimeoutError"),
        });
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        throw new MigrationOperationError("source_stream_read", {
          cause: error,
        });
      }
      const { done, value } = read;
      if (done) break;
      bytes += value.length;
      if (bytes > capture.archiveBytes || bytes > MAX_ARCHIVE_BYTES)
        throw new MigrationOperationError("archive_integrity");
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
      throw new MigrationOperationError("archive_integrity");
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
  triggerRunId?: string;
};

export async function migrateE2BWorkspace(request: E2BFileMigrationRequest) {
  const { userId, sourceId, triggerRegion, triggerRunId } = request;
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
      migration_event_version: 4,
      ...(triggerRunId && { trigger_run_id: triggerRunId }),
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
  const existingMigration = await readCloudMigrationState(userId);
  if (existingMigration?.phase === "miosa") return report("already_claimed");
  if (existingMigration) {
    report(
      existingMigration.phase === "checking"
        ? "checking_claim_recovery_required"
        : "workspace_cleanup_fenced",
    );
    throw new CloudMigrationUnavailableError();
  }
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
    workspaces[0].info.volumeMounts?.length
  )
    return report("unsupported_or_active_inventory");
  if (workspaces[0].info.state !== "paused") return report("source_active");
  const claim = await claimCloudMigration(userId, sourceId, triggerRegion);
  if (!claim) return report("workspace_in_use");
  const stage = `/.hackerai-migration-${claim.token}`;
  let source: Sandbox | undefined;
  let target: MiosaSandbox | undefined;
  let sourceStageCreated = false;
  let commitStarted = false;
  let preparedName: string | undefined;
  let destinationAcquisitionDiagnostic: MiosaAcquisitionDiagnostic | undefined;
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
  const reportStage = (
    reason: string,
    properties: Record<string, unknown> = {},
    result: Record<string, unknown> = {},
  ) => {
    finishStage();
    return report(
      reason,
      { ...properties, stage_durations_ms: stageDurationsMs },
      result,
    );
  };
  try {
    const connection = workspaces[0].cluster.connectionOptions;
    const current = await Sandbox.getInfo(sourceId, {
      ...connection,
      requestTimeoutMs: 5000,
    });
    if (current.state !== "paused") return reportStage("source_active");
    if (
      current.metadata.userID !== userId ||
      current.metadata.template !== workspaces[0].cluster.template ||
      current.templateId !== workspaces[0].info.templateId ||
      current.lifecycle?.onTimeout !== "pause" ||
      current.volumeMounts?.length
    )
      return reportStage("state_changed");
    startStage("source_connection");
    const connectedSource = await retryTransientOperation(
      "source_connect",
      () =>
        Sandbox.connect(sourceId, {
          ...connection,
          timeoutMs: 2 * 60 * 60 * 1000,
          requestTimeoutMs: 10000,
        }),
    );
    source = connectedSource;
    if (
      (
        await retryTransientOperation("source_command_list", () =>
          connectedSource.commands.list(),
        )
      ).length
    )
      return reportStage("active_commands");
    startStage("source_export");
    sourceStageCreated = true;
    let exported;
    try {
      exported = await source.commands.run(transferCommand("export", stage), {
        user: "root",
        cwd: "/",
        timeoutMs: 21 * 60 * 1000,
      });
    } catch (error) {
      if (!(error instanceof CommandExitError)) throw error;
      const rejection = parseSourceExportRejection(error.stdout);
      if (!rejection) throw new Error("Export failed");
      return reportStage(
        "source_export_rejected",
        { source_export_reason: rejection },
        { sourceExportReason: rejection },
      );
    }
    if (exported.exitCode !== 0) {
      const rejection = parseSourceExportRejection(exported.stdout);
      if (!rejection) throw new Error("Export failed");
      return reportStage(
        "source_export_rejected",
        { source_export_reason: rejection },
        { sourceExportReason: rejection },
      );
    }
    const capture = parseCapture(exported.stdout);
    startStage("destination_creation");
    preparedName = miosaMigrationDestinationName(userId, claim.token);
    ({ sandbox: target } = await ensureMiosaSandboxConnection(
      { userID: userId, setSandbox: () => {} },
      {
        migrationName: preparedName,
        onDiagnostic: (diagnostic) => {
          destinationAcquisitionDiagnostic = diagnostic;
          const fields = {
            ...diagnostic,
            ...(triggerRunId && { trigger_run_id: triggerRunId }),
            trigger_region: triggerRegion,
            migration_acquisition_event_version: 1,
          };
          phLogger.event("miosa_e2b_file_migration_acquisition_step", {
            userId,
            ...fields,
          });
          if (
            diagnostic.outcome === "failure" ||
            diagnostic.stage === "acquisition_reconciliation" ||
            diagnostic.stage === "resume_conflict_refresh"
          )
            console.warn("MIOSA migration acquisition step", {
              ...fields,
              timestamp: new Date().toISOString(),
            });
        },
      },
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
      (
        await retryTransientOperation("source_command_list", () =>
          connectedSource.commands.list(),
        )
      ).length
    )
      return reportStage("source_changed");
    if (!(await isE2BFileMigrationEnabled(userId)))
      return reportStage("rollout_stopped");
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
      return reportStage("rollout_stopped");
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
    finishStage();
    const failureKind = migrationFailureKind(error);
    const failureOperation =
      error instanceof MigrationOperationError ? error.operation : undefined;
    const acquisitionFailure = {
      ...(destinationAcquisitionDiagnostic
        ? miosaAcquisitionDiagnosticFields(destinationAcquisitionDiagnostic)
        : {}),
      ...miosaAcquisitionFailureDiagnostics(error),
    };
    const properties = {
      failure_stage: migrationStage,
      failure_kind: failureKind,
      ...(failureOperation && { failure_operation: failureOperation }),
      ...acquisitionFailure,
      failed_stage_duration_ms: stageDurationsMs[migrationStage],
      stage_durations_ms: stageDurationsMs,
    };
    if (commitStarted) {
      report("transfer_unavailable", properties);
      throw new CloudMigrationUnavailableError();
    }
    return report("transfer_unavailable", properties, {
      failureStage: migrationStage,
      failureKind,
      ...(failureOperation && { failureOperation }),
      failedStageDurationMs: stageDurationsMs[migrationStage],
    });
  } finally {
    if (!commitStarted) {
      let destinationCleanupError: CloudMigrationUnavailableError | undefined;
      // A failed or uncertain create may exist even without a returned SDK.
      // Do not release the fence until that exact private destination is gone.
      if (preparedName) {
        const client = await createMiosaClient();
        const { NotFoundError } = await import("@miosa/sdk");
        try {
          await (await client.sandboxes.getByName(preparedName)).destroy();
          phLogger.event("miosa_e2b_file_migration_cleanup", {
            userId,
            outcome: "destroy_acknowledged",
            acquisition_id: destinationAcquisitionDiagnostic?.acquisition_id,
            workspace_fingerprint:
              destinationAcquisitionDiagnostic?.workspace_fingerprint,
            provider_operation_id:
              destinationAcquisitionDiagnostic?.provider_operation_id,
            provider_request_id:
              destinationAcquisitionDiagnostic?.provider_request_id,
            ...(triggerRunId && { trigger_run_id: triggerRunId }),
            cleanup_event_version: 1,
          });
        } catch (error) {
          const outcome =
            error instanceof NotFoundError
              ? "destination_not_found"
              : "lookup_or_destroy_failed";
          const fields = {
            outcome,
            acquisition_id: destinationAcquisitionDiagnostic?.acquisition_id,
            workspace_fingerprint:
              destinationAcquisitionDiagnostic?.workspace_fingerprint,
            provider_operation_id:
              destinationAcquisitionDiagnostic?.provider_operation_id,
            provider_request_id:
              destinationAcquisitionDiagnostic?.provider_request_id,
            ...(triggerRunId && { trigger_run_id: triggerRunId }),
            cleanup_event_version: 1,
            ...(error instanceof NotFoundError
              ? {}
              : miosaErrorDiagnostics(error)),
          };
          phLogger.event("miosa_e2b_file_migration_cleanup", {
            userId,
            ...fields,
          });
          if (!(error instanceof NotFoundError)) {
            console.warn("MIOSA migration cleanup", {
              ...fields,
              timestamp: new Date().toISOString(),
            });
            destinationCleanupError = new CloudMigrationUnavailableError();
          }
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
      if (destinationCleanupError) throw destinationCleanupError;
      await claim.abandon();
    }
  }
}
