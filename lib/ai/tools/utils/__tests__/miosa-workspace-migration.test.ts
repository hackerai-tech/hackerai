import { runs } from "@trigger.dev/sdk";
import { createHash } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { Sandbox } from "@e2b/code-interpreter";
import {
  claimCloudMigration,
  CloudMigrationUnavailableError,
  readCloudMigrationState,
} from "../cloud-migration-state";
import { assertFreshMiosaEnrollment } from "../miosa-enrollment";
import {
  createMiosaClient,
  ensureMiosaSandboxConnection,
} from "../miosa-sandbox";
import { isE2BFileMigrationEnabled } from "../miosa-workspace-migration-queue";
import {
  migrateE2BWorkspace,
  miosaMigrationDestinationName,
} from "../miosa-workspace-migration";

jest.mock("@trigger.dev/sdk", () => ({ runs: { retrieve: jest.fn() } }));
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getInfo: jest.fn(), connect: jest.fn() },
  CommandExitError: class CommandExitError extends Error {
    exitCode: number;
    stdout: string;
    stderr: string;

    constructor(result: { exitCode: number; stdout: string; stderr: string }) {
      super(`exit status ${result.exitCode}`);
      this.exitCode = result.exitCode;
      this.stdout = result.stdout;
      this.stderr = result.stderr;
    }
  },
}));
jest.mock("../cloud-migration-state", () => ({
  claimCloudMigration: jest.fn(),
  readCloudMigrationState: jest.fn(),
  CloudMigrationUnavailableError: class extends Error {},
}));
jest.mock("../miosa-enrollment", () => ({
  assertFreshMiosaEnrollment: jest.fn(),
}));
jest.mock("../miosa-sandbox", () => ({
  createMiosaClient: jest.fn(),
  ensureMiosaSandboxConnection: jest.fn(),
}));
jest.mock("../miosa-workspace-migration-queue", () => ({
  E2B_FILE_MIGRATION_TASK: "miosa-e2b-file-migration",
  isE2BFileMigrationEnabled: jest.fn(),
}));
jest.mock("../miosa-readiness", () => ({ waitForMiosaReadiness: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("@miosa/sdk", () => ({ NotFoundError: class extends Error {} }));
import { NotFoundError } from "@miosa/sdk";
import { CommandExitError } from "@e2b/code-interpreter";
import { phLogger } from "@/lib/posthog/server";

describe("file migration transaction", () => {
  const bytes = Buffer.from([0, 255, 2, 3]);
  const capture = {
    version: 1,
    digest: "a".repeat(64),
    homeDigest: "b".repeat(64),
    entries: 5,
    bytes: 4,
    archiveBytes: 4,
    archiveDigest: createHash("sha256").update(bytes).digest("hex"),
  };
  const claim = {
    token: "00000000-0000-0000-0000-000000000001",
    commit: jest.fn(),
    abandon: jest.fn(),
  };
  const source = {
    commands: { run: jest.fn(), list: jest.fn() },
    files: { read: jest.fn() },
    betaPause: jest.fn(),
  };
  const target = {
    sandboxId: "copied-id",
    runtime: "native",
    sdkSandbox: {
      exec: { run: jest.fn() },
      files: { write: jest.fn() },
      pause: jest.fn(),
      resume: jest.fn(),
    },
  };
  const destroy = jest.fn();
  const getByName = jest.fn();
  const request = {
    userId: "user",
    sourceId: "source",
    subscription: "pro" as const,
    triggerRegion: "us-east-1" as const,
  };
  const ok = (data: unknown = {}) => ({
    exitCode: 0,
    stdout: JSON.stringify(data),
    stderr: "",
  });
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.MIOSA_TEMPLATE_ID;
    (isE2BFileMigrationEnabled as jest.Mock).mockResolvedValue(true);
    (readCloudMigrationState as jest.Mock).mockResolvedValue(null);
    (claimCloudMigration as jest.Mock).mockResolvedValue(claim);
    (assertFreshMiosaEnrollment as jest.Mock).mockImplementation(
      async ({ onExisting }) =>
        onExisting([
          {
            cluster: { cluster: "us", template: "template" },
            info: {
              sandboxId: "source",
              templateId: "template",
              state: "paused",
              metadata: { template: "template" },
            },
          },
        ]),
    );
    (Sandbox.getInfo as jest.Mock).mockResolvedValue({
      sandboxId: "source",
      templateId: "template",
      state: "paused",
      metadata: { userID: "user", template: "template" },
      lifecycle: { onTimeout: "pause" },
    });
    (Sandbox.connect as jest.Mock).mockResolvedValue(source);
    (createMiosaClient as jest.Mock).mockResolvedValue({
      sandboxes: { getByName },
    });
    getByName
      .mockRejectedValueOnce(new NotFoundError("absent"))
      .mockResolvedValue({ destroy });
    (ensureMiosaSandboxConnection as jest.Mock).mockResolvedValue({
      sandbox: target,
    });
    source.commands.list.mockResolvedValue([]);
    source.commands.run.mockImplementation(async (command: string) =>
      ok(
        command.includes(" export '/")
          ? capture
          : command.includes(" verify-source '/")
            ? { digest: capture.digest }
            : {},
      ),
    );
    source.files.read.mockImplementation(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    );
    // The real Miosa upload API rejects arbitrary root paths with INVALID_PATH.
    target.sdkSandbox.files.write.mockImplementation(async (path: string) => {
      if (!path.startsWith("/tmp/")) throw new Error("INVALID_PATH");
    });
    target.sdkSandbox.exec.run.mockImplementation(async (command: string) => {
      if (command.includes(" restore '/"))
        return ok({
          archiveDigest: capture.archiveDigest,
          homeDigest: capture.homeDigest,
        });
      if (command.includes(" verify-home '/"))
        return ok({ homeDigest: capture.homeDigest });
      if (command.startsWith("sha256sum"))
        return {
          exitCode: 0,
          stdout: `${capture.archiveDigest} file`,
          stderr: "",
        };
      return ok();
    });
  });
  it("uses a deterministic provider-safe destination name", () => {
    const name = miosaMigrationDestinationName("user", claim.token);

    expect(name).toMatch(/^hackerai-mig-[a-f0-9]{22}$/);
    expect(name.length).toBeLessThanOrEqual(36);
    expect(miosaMigrationDestinationName("user", claim.token)).toBe(name);
    expect(miosaMigrationDestinationName("other-user", claim.token)).not.toBe(
      name,
    );
  });
  it("commits the exact copied destination only after transfer and pause/resume verification", async () => {
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "files_verified_and_committed",
    });
    expect(claim.commit).toHaveBeenCalledWith("copied-id");
    expect(claim.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      target.sdkSandbox.resume.mock.invocationCallOrder[0],
    );
    expect(source.betaPause).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(claim.abandon).not.toHaveBeenCalled();
  });
  it("retries a transient destination chunk upload without duplicating the archive", async () => {
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    target.sdkSandbox.files.write.mockRejectedValueOnce(timeout);

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "files_verified_and_committed",
    });
    expect(target.sdkSandbox.files.write).toHaveBeenCalledTimes(2);
    expect(
      target.sdkSandbox.exec.run.mock.calls.filter(([command]) =>
        command.includes("f.seek(0)"),
      ),
    ).toHaveLength(1);
    expect(claim.commit).toHaveBeenCalledWith("copied-id");
  });
  it("retries an uncertain destination append using the expected byte offset", async () => {
    const normal = target.sdkSandbox.exec.run.getMockImplementation()!;
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    let appendAttempts = 0;
    target.sdkSandbox.exec.run.mockImplementation(async (command: string) => {
      if (command.includes("f.seek(0)") && appendAttempts++ === 0)
        throw timeout;
      return normal(command);
    });

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "files_verified_and_committed",
    });
    expect(target.sdkSandbox.files.write).toHaveBeenCalledTimes(2);
    expect(appendAttempts).toBe(2);
    expect(claim.commit).toHaveBeenCalledWith("copied-id");
  });
  it("retries when Miosa reports that the destination append timed out", async () => {
    const normal = target.sdkSandbox.exec.run.getMockImplementation()!;
    let appendAttempts = 0;
    target.sdkSandbox.exec.run.mockImplementation(async (command: string) => {
      if (command.includes("f.seek(0)") && appendAttempts++ === 0)
        return {
          stdout: "",
          stderr: "",
          exitCode: -1,
          timedOut: true,
        };
      return normal(command);
    });

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "files_verified_and_committed",
    });
    expect(target.sdkSandbox.files.write).toHaveBeenCalledTimes(2);
    expect(appendAttempts).toBe(2);
    expect(claim.commit).toHaveBeenCalledWith("copied-id");
  });
  it("reports safe chunk diagnostics after transient upload retries are exhausted", async () => {
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    target.sdkSandbox.files.write.mockRejectedValue(timeout);

    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "archive_transfer",
      failureOperation: "destination_chunk_upload",
      failureKind: "timeout",
    });
    expect(target.sdkSandbox.files.write).toHaveBeenCalledTimes(3);
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "transfer_unavailable",
        failure_stage: "archive_transfer",
        failure_operation: "destination_chunk_upload",
        failure_kind: "timeout",
      }),
    );
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.not.objectContaining({
        error: expect.anything(),
        error_message: expect.anything(),
      }),
    );
  });
  it("leaves active work alone without acquiring or creating a VM", async () => {
    (claimCloudMigration as jest.Mock).mockResolvedValue(null);
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "workspace_in_use",
    });
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(ensureMiosaSandboxConnection).not.toHaveBeenCalled();
  });
  it("defers a recently used sandbox until its inventory is paused", async () => {
    (assertFreshMiosaEnrollment as jest.Mock).mockImplementation(
      async ({ onExisting }) =>
        onExisting([
          {
            cluster: { cluster: "us", template: "template" },
            info: {
              sandboxId: "source",
              templateId: "template",
              state: "running",
              metadata: { template: "template" },
            },
          },
        ]),
    );

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "source_active",
    });
    expect(claimCloudMigration).not.toHaveBeenCalled();
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });
  it("releases its claim when the sandbox resumes before connection", async () => {
    (Sandbox.getInfo as jest.Mock).mockResolvedValue({
      sandboxId: "source",
      templateId: "template",
      state: "running",
      metadata: { userID: "user", template: "template" },
      lifecycle: { onTimeout: "pause" },
    });

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "source_active",
    });
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });
  it("retries a transient E2B connection timeout before exporting", async () => {
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    (Sandbox.connect as jest.Mock).mockRejectedValueOnce(timeout);

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "files_verified_and_committed",
    });
    expect(Sandbox.connect).toHaveBeenCalledTimes(2);
    expect(claim.commit).toHaveBeenCalledWith("copied-id");
  });
  it("reports the exact E2B operation after connection retries are exhausted", async () => {
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    (Sandbox.connect as jest.Mock).mockRejectedValue(timeout);

    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "source_connection",
      failureOperation: "source_connect",
      failureKind: "timeout",
    });
    expect(Sandbox.connect).toHaveBeenCalledTimes(3);
    expect(ensureMiosaSandboxConnection).not.toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });
  it("reports command-list timeouts separately from E2B connection timeouts", async () => {
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    source.commands.list.mockRejectedValue(timeout);

    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "source_connection",
      failureOperation: "source_command_list",
      failureKind: "timeout",
    });
    expect(source.commands.list).toHaveBeenCalledTimes(3);
    expect(claim.abandon).toHaveBeenCalled();
  });
  it("retries and labels command-list timeouts during source verification", async () => {
    const timeout = Object.assign(new Error("private provider detail"), {
      name: "TimeoutError",
      code: "TIMEOUT",
      retryable: true,
    });
    source.commands.list.mockResolvedValueOnce([]).mockRejectedValue(timeout);

    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "source_verification",
      failureOperation: "source_command_list",
      failureKind: "timeout",
    });
    expect(source.commands.list).toHaveBeenCalledTimes(4);
    expect(destroy).toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });
  const ownedChecking = {
    version: 1,
    phase: "checking",
    token: "retained",
    sourceId: "source",
    region: "us-east-1",
    owner: { runId: "run_owner", attempt: 1 },
  };
  const liveRun = {
    id: "run_owner",
    taskIdentifier: "miosa-e2b-file-migration",
    status: "EXECUTING",
    attemptCount: 1,
  };
  it("defers a duplicate without touching either provider or the owner's fence", async () => {
    (readCloudMigrationState as jest.Mock).mockResolvedValue(ownedChecking);
    (runs.retrieve as jest.Mock).mockResolvedValue(liveRun);
    await expect(
      migrateE2BWorkspace({
        ...request,
        triggerRunId: "run_duplicate",
        triggerAttempt: 1,
      }),
    ).resolves.toEqual({ reason: "migration_in_progress" });
    expect(claimCloudMigration).not.toHaveBeenCalled();
    expect(createMiosaClient).not.toHaveBeenCalled();
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(claim.abandon).not.toHaveBeenCalled();
  });
  it.each([
    { status: "CRASHED" },
    { status: "COMPLETED" },
    { status: "WAITING" },
    { attemptCount: 2 },
    { taskIdentifier: "agent" },
  ])("retains an orphan or unproven owner's fence: %j", async (override) => {
    (readCloudMigrationState as jest.Mock).mockResolvedValue(ownedChecking);
    (runs.retrieve as jest.Mock).mockResolvedValue({ ...liveRun, ...override });
    await expect(
      migrateE2BWorkspace({
        ...request,
        triggerRunId: "run_duplicate",
        triggerAttempt: 1,
      }),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect(claimCloudMigration).not.toHaveBeenCalled();
    expect(claim.abandon).not.toHaveBeenCalled();
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({ reason: "checking_claim_recovery_required" }),
    );
  });
  it("does not treat its own previous attempt as a live owner", async () => {
    (readCloudMigrationState as jest.Mock).mockResolvedValue(ownedChecking);
    await expect(
      migrateE2BWorkspace({
        ...request,
        triggerRunId: "run_owner",
        triggerAttempt: 2,
      }),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect(runs.retrieve).not.toHaveBeenCalled();
  });
  it("fails closed when owner status cannot be retrieved", async () => {
    (readCloudMigrationState as jest.Mock).mockResolvedValue(ownedChecking);
    (runs.retrieve as jest.Mock).mockRejectedValue(
      new Error("private provider message"),
    );
    await expect(migrateE2BWorkspace(request)).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect(
      JSON.stringify((phLogger.event as jest.Mock).mock.calls),
    ).not.toContain("private provider message");
  });
  it.each([
    null,
    { ...ownedChecking, phase: "miosa" },
    { ...ownedChecking, token: "new-owner" },
  ])(
    "rechecks a claim changed during owner lookup without a false recovery alarm",
    async (current) => {
      (readCloudMigrationState as jest.Mock)
        .mockResolvedValueOnce(ownedChecking)
        .mockResolvedValueOnce(current);
      (runs.retrieve as jest.Mock).mockResolvedValue({
        ...liveRun,
        status: "COMPLETED",
      });
      await expect(migrateE2BWorkspace(request)).resolves.toEqual({
        reason: "workspace_in_use",
      });
      expect(claimCloudMigration).not.toHaveBeenCalled();
    },
  );
  it("records the Trigger attempt that owns a new migration", async () => {
    await migrateE2BWorkspace({
      ...request,
      triggerRunId: "run_owner",
      triggerAttempt: 2,
    });
    expect(claimCloudMigration).toHaveBeenCalledWith(
      "user",
      "source",
      "us-east-1",
      { runId: "run_owner", attempt: 2 },
    );
  });
  it("keeps an interrupted checking claim fenced for recovery", async () => {
    (readCloudMigrationState as jest.Mock).mockResolvedValue({
      version: 1,
      phase: "checking",
      token: "retained",
      sourceId: "source",
      region: "us-east-1",
    });

    await expect(migrateE2BWorkspace(request)).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "checking_claim_recovery_required",
      }),
    );
    expect(claimCloudMigration).not.toHaveBeenCalled();
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });
  it("destroys only the private destination and releases the fence on transfer mismatch", async () => {
    source.files.read.mockImplementation(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("bad"));
            controller.close();
          },
        }),
    );
    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "archive_transfer",
      failureOperation: "archive_integrity",
      failureKind: "operation_failed",
      failedStageDurationMs: expect.any(Number),
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "transfer_unavailable",
        migration_event_version: 4,
        failure_stage: "archive_transfer",
        failure_operation: "archive_integrity",
        failure_kind: "operation_failed",
        failed_stage_duration_ms: expect.any(Number),
        stage_durations_ms: expect.objectContaining({
          archive_transfer: expect.any(Number),
        }),
      }),
    );
    expect(claim.commit).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(claim.abandon.mock.invocationCallOrder[0]).toBeGreaterThan(
      destroy.mock.invocationCallOrder[0],
    );
  });
  it("reports allowlisted source export rejections as safe skips", async () => {
    const normal = source.commands.run.getMockImplementation()!;
    source.commands.run.mockImplementation(async (command: string) => {
      if (command.includes(" export '/"))
        throw new CommandExitError({
          exitCode: 1,
          stdout: JSON.stringify({ failure: "external_symlink" }),
          stderr: "",
        });
      return normal(command);
    });

    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "source_export_rejected",
      sourceExportReason: "external_symlink",
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "source_export_rejected",
        source_export_reason: "external_symlink",
        migration_event_version: 4,
        stage_durations_ms: expect.objectContaining({
          source_export: expect.any(Number),
        }),
      }),
    );
    expect(ensureMiosaSandboxConnection).not.toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });
  it("keeps source filesystem failures retryable", async () => {
    const normal = source.commands.run.getMockImplementation()!;
    source.commands.run.mockImplementation(async (command: string) => {
      if (command.includes(" export '/"))
        throw new CommandExitError({
          exitCode: 1,
          stdout: JSON.stringify({ failure: "filesystem_unavailable" }),
          stderr: "",
        });
      return normal(command);
    });

    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "source_export",
      failureKind: "operation_failed",
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.not.objectContaining({
        source_export_reason: expect.anything(),
      }),
    );
    expect(ensureMiosaSandboxConnection).not.toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });
  it("keeps unrecognized source export output fail-closed and private", async () => {
    const normal = source.commands.run.getMockImplementation()!;
    source.commands.run.mockImplementation(async (command: string) =>
      command.includes(" export '/")
        ? {
            exitCode: 1,
            stdout: JSON.stringify({ failure: "/private/customer/path" }),
            stderr: "provider details",
          }
        : normal(command),
    );

    expect(await migrateE2BWorkspace(request)).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "source_export",
      failureKind: "operation_failed",
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.not.objectContaining({
        source_export_reason: expect.anything(),
        error: expect.anything(),
        error_message: expect.anything(),
      }),
    );
  });
  it("reports destination creation timeouts without exposing provider errors", async () => {
    const providerError = new Error(
      "Request timed out for https://provider.invalid/private/path",
    );
    providerError.name = "TimeoutError";
    (ensureMiosaSandboxConnection as jest.Mock).mockImplementation(
      async (_context, options) => {
        options.onDiagnostic({
          acquisition_id: "acquisition-1",
          stage: "get_or_create",
          outcome: "failure",
          stage_duration_ms: 144,
          acquisition_duration_ms: 144,
          requested_template: "hackerai-tools",
          template_fingerprint: "template-fingerprint",
          api_target: "default",
          workspace_fingerprint: "workspace-fingerprint",
          error_name: "TimeoutError",
          error_code: "TIMEOUT",
          error_request_id: "request-1",
          error_retryable: true,
        });
        throw providerError;
      },
    );

    expect(
      await migrateE2BWorkspace({
        ...request,
        triggerRunId: "run-migration-1",
      }),
    ).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "destination_creation",
      failureKind: "timeout",
      failedStageDurationMs: expect.any(Number),
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_acquisition_step",
      expect.objectContaining({
        acquisition_id: "acquisition-1",
        stage: "get_or_create",
        outcome: "failure",
        error_request_id: "request-1",
        trigger_run_id: "run-migration-1",
      }),
    );
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "transfer_unavailable",
        migration_event_version: 4,
        trigger_run_id: "run-migration-1",
        acquisition_id: "acquisition-1",
        miosa_failure_stage: "get_or_create",
        error_code: "TIMEOUT",
        error_request_id: "request-1",
      }),
    );
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_cleanup",
      expect.objectContaining({
        outcome: "destroy_acknowledged",
        acquisition_id: "acquisition-1",
        workspace_fingerprint: "workspace-fingerprint",
        trigger_run_id: "run-migration-1",
      }),
    );
    expect(
      JSON.stringify((phLogger.event as jest.Mock).mock.calls),
    ).not.toMatch(/provider\.invalid|private\/path/);
  });
  it("records when a failed create is not yet visible during cleanup", async () => {
    const providerError = Object.assign(new Error("private provider body"), {
      name: "MiosaOperationError",
      code: "OPERATION_FAILED",
      requestId: "request-2",
    });
    getByName.mockReset().mockRejectedValue(new NotFoundError("absent"));
    (ensureMiosaSandboxConnection as jest.Mock).mockImplementation(
      async (_context, options) => {
        options.onDiagnostic({
          acquisition_id: "acquisition-2",
          stage: "get_or_create",
          outcome: "failure",
          stage_duration_ms: 200,
          acquisition_duration_ms: 200,
          requested_template: "hackerai-tools",
          template_fingerprint: "template-fingerprint",
          api_target: "default",
          workspace_fingerprint: "workspace-fingerprint-2",
          error_name: "MiosaOperationError",
          error_code: "OPERATION_FAILED",
          error_request_id: "request-2",
          error_retryable: false,
        });
        throw providerError;
      },
    );

    expect(
      await migrateE2BWorkspace({
        ...request,
        triggerRunId: "run-migration-2",
      }),
    ).toMatchObject({
      reason: "transfer_unavailable",
      failureStage: "destination_creation",
      failureKind: "operation_failed",
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_cleanup",
      expect.objectContaining({
        outcome: "destination_not_found",
        acquisition_id: "acquisition-2",
        workspace_fingerprint: "workspace-fingerprint-2",
        trigger_run_id: "run-migration-2",
      }),
    );
    expect(claim.abandon).toHaveBeenCalled();
    const migrationName = (ensureMiosaSandboxConnection as jest.Mock).mock
      .calls[0][1].migrationName;
    expect(migrationName).toMatch(/^hackerai-mig-[a-f0-9]{22}$/);
    expect(getByName).toHaveBeenCalledWith(migrationName);
    expect(
      JSON.stringify((phLogger.event as jest.Mock).mock.calls),
    ).not.toContain("private provider body");
  });
  it("preserves the fence and destination when commit acknowledgement is lost", async () => {
    claim.commit.mockRejectedValue(new Error("lost acknowledgement"));
    await expect(migrateE2BWorkspace(request)).rejects.toThrow();
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "transfer_unavailable",
        migration_event_version: 4,
        failure_stage: "commit",
        failure_kind: "operation_failed",
      }),
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(claim.abandon).not.toHaveBeenCalled();
  });
  it("keeps the fence when private destination cleanup cannot be confirmed", async () => {
    target.sdkSandbox.files.write.mockRejectedValue(
      new Error("failed transfer"),
    );
    destroy.mockRejectedValue(new Error("failed cleanup"));
    await expect(migrateE2BWorkspace(request)).rejects.toThrow();
    expect(source.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("shutil.rmtree"),
      expect.objectContaining({ user: "root" }),
    );
    expect(claim.abandon).not.toHaveBeenCalled();
  });
  it("honors a rollout stop before cutover", async () => {
    (isE2BFileMigrationEnabled as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "rollout_stopped",
    });
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_checked",
      expect.objectContaining({
        reason: "rollout_stopped",
        stage_durations_ms: expect.objectContaining({
          source_verification: expect.any(Number),
        }),
      }),
    );
    expect(claim.commit).not.toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });

  it("does not release the fence after a nonzero source cleanup result", async () => {
    const normal = source.commands.run.getMockImplementation()!;
    source.commands.run.mockImplementation(async (command: string) =>
      command.includes("shutil.rmtree")
        ? { exitCode: 1, stdout: "", stderr: "" }
        : normal(command),
    );
    await expect(migrateE2BWorkspace(request)).rejects.toThrow();
    expect(claim.commit).not.toHaveBeenCalled();
    expect(claim.abandon).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it("does not copy an environment's source based only on a matching user ID", async () => {
    (Sandbox.getInfo as jest.Mock).mockResolvedValue({
      templateId: "template",
      state: "paused",
      metadata: { userID: "user", template: "other-environment" },
      lifecycle: { onTimeout: "pause" },
    });
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "state_changed",
    });
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(claim.abandon).toHaveBeenCalled();
  });
});
