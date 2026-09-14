import { createHash } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { Sandbox } from "@e2b/code-interpreter";
import {
  claimCloudMigration,
  readCloudMigrationState,
} from "../cloud-migration-state";
import { assertFreshMiosaEnrollment } from "../miosa-enrollment";
import {
  createMiosaClient,
  ensureMiosaSandboxConnection,
} from "../miosa-sandbox";
import { isE2BFileMigrationEnabled } from "../miosa-workspace-migration-queue";
import { migrateE2BWorkspace } from "../miosa-workspace-migration";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getInfo: jest.fn(), connect: jest.fn() },
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
  isE2BFileMigrationEnabled: jest.fn(),
}));
jest.mock("../miosa-readiness", () => ({ waitForMiosaReadiness: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("@miosa/sdk", () => ({ NotFoundError: class extends Error {} }));
import { NotFoundError } from "@miosa/sdk";

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
  it("leaves active work alone without acquiring or creating a VM", async () => {
    (claimCloudMigration as jest.Mock).mockResolvedValue(null);
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "workspace_in_use",
    });
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(ensureMiosaSandboxConnection).not.toHaveBeenCalled();
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
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "transfer_unavailable",
    });
    expect(claim.commit).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    expect(claim.abandon.mock.invocationCallOrder[0]).toBeGreaterThan(
      destroy.mock.invocationCallOrder[0],
    );
  });
  it("preserves the fence and destination when commit acknowledgement is lost", async () => {
    claim.commit.mockRejectedValue(new Error("lost acknowledgement"));
    await expect(migrateE2BWorkspace(request)).rejects.toThrow();
    expect(destroy).not.toHaveBeenCalled();
    expect(claim.abandon).not.toHaveBeenCalled();
  });
  it("keeps the fence when private destination cleanup cannot be confirmed", async () => {
    target.sdkSandbox.files.write.mockRejectedValue(
      new Error("failed transfer"),
    );
    destroy.mockRejectedValue(new Error("failed cleanup"));
    await expect(migrateE2BWorkspace(request)).rejects.toThrow();
    expect(claim.abandon).not.toHaveBeenCalled();
  });
  it("honors a rollout stop before cutover", async () => {
    (isE2BFileMigrationEnabled as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await migrateE2BWorkspace(request)).toEqual({
      reason: "rollout_stopped",
    });
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
