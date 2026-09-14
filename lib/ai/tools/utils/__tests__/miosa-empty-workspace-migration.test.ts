import { Sandbox } from "@e2b/code-interpreter";
import {
  tryMigrateEmptyE2BWorkspace,
  type ExistingE2BWorkspace,
} from "../miosa-empty-workspace-migration";
import {
  claimCloudMigration,
  CloudMigrationUnavailableError,
} from "../cloud-migration-state";
import { getPostHogFeatureFlagForUser, phLogger } from "@/lib/posthog/server";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getInfo: jest.fn(), connect: jest.fn(), kill: jest.fn() },
}));
jest.mock("../cloud-migration-state", () => ({
  claimCloudMigration: jest.fn(),
  CloudMigrationUnavailableError: class extends Error {},
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagForUser: jest.fn(),
  phLogger: { event: jest.fn() },
}));

describe("empty E2B migration", () => {
  const digest = "a".repeat(64);
  const info = {
    sandboxId: "source-1",
    templateId: "template-1",
    state: "paused",
    metadata: { userID: "user-1" },
    lifecycle: { onTimeout: "pause" },
  };
  const workspace = {
    info,
    cluster: { cluster: "us", template: "current-alias" },
  } as ExistingE2BWorkspace;
  const run = jest.fn();
  const list = jest.fn();
  const commit = jest.fn();
  const abandon = jest.fn();
  const oldEnv = process.env;
  const migrate = (workspaces = [workspace]) =>
    tryMigrateEmptyE2BWorkspace({
      userId: "user-1",
      workspaces,
      triggerRegion: "us-east-1",
    });
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...oldEnv,
      TRIGGER_ENV: "preview",
      MIOSA_EMPTY_E2B_BASELINES_JSON: JSON.stringify([
        { version: 1, templateId: "template-1", digest },
      ]),
    };
    (getPostHogFeatureFlagForUser as jest.Mock).mockResolvedValue(true);
    (Sandbox.getInfo as jest.Mock).mockResolvedValue(info);
    (Sandbox.connect as jest.Mock).mockResolvedValue({
      commands: { run, list },
    });
    (claimCloudMigration as jest.Mock).mockResolvedValue({ commit, abandon });
    list.mockResolvedValue([]);
    run.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, digest, entries: 10 }),
    });
  });
  afterAll(() => {
    process.env = oldEnv;
  });

  it("pins an unchanged workspace only after two complete checks; never deletes the source", async () => {
    await expect(migrate()).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(abandon).not.toHaveBeenCalled();
    expect(Sandbox.kill).not.toHaveBeenCalled();
    expect(phLogger.event).toHaveBeenCalledWith(
      "miosa_empty_e2b_migration_checked",
      expect.objectContaining({ reason: "empty_verified" }),
    );
    expect(
      JSON.stringify((phLogger.event as jest.Mock).mock.calls),
    ).not.toContain(digest);
  });

  it("does nothing while the separate flag is disabled", async () => {
    (getPostHogFeatureFlagForUser as jest.Mock).mockResolvedValue(false);
    await expect(migrate()).resolves.toBe(false);
    expect(claimCloudMigration).not.toHaveBeenCalled();
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "{}",
    "[]",
    JSON.stringify([{ version: 1, templateId: "other", digest }]),
  ])("skips missing/invalid/unrecognized baselines %s", async (value) => {
    if (value === undefined) delete process.env.MIOSA_EMPTY_E2B_BASELINES_JSON;
    else process.env.MIOSA_EMPTY_E2B_BASELINES_JSON = value;
    await expect(migrate()).resolves.toBe(false);
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });

  it.each(["running", "unknown"])(
    "does not touch a %s workspace",
    async (state) => {
      await expect(
        migrate([
          {
            ...workspace,
            info: { ...workspace.info, state },
          } as ExistingE2BWorkspace,
        ]),
      ).resolves.toBe(false);
      expect(claimCloudMigration).not.toHaveBeenCalled();
    },
  );

  it("defers multiple workspaces and cross-region inventories", async () => {
    await expect(migrate([workspace, workspace])).resolves.toBe(false);
    await expect(
      migrate([
        { ...workspace, cluster: { ...workspace.cluster, cluster: "eu" } },
      ]),
    ).resolves.toBe(false);
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });

  it("rechecks source ownership/state after claiming", async () => {
    (Sandbox.getInfo as jest.Mock).mockResolvedValue({
      ...info,
      state: "running",
    });
    await expect(migrate()).resolves.toBe(false);
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it("preserves resumed background commands", async () => {
    list.mockResolvedValue([{ pid: 7 }]);
    await expect(migrate()).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it.each(["different", "unknown", "timeout", "changing"])(
    "stays on E2B for %s files and releases only the check fence",
    async (kind) => {
      if (kind === "timeout")
        run.mockRejectedValue(new Error("private-path credential"));
      else if (kind === "unknown")
        run.mockResolvedValue({ exitCode: 1, stdout: "{}" });
      else if (kind === "changing")
        run
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: JSON.stringify({ version: 1, digest, entries: 10 }),
          })
          .mockResolvedValue({
            exitCode: 0,
            stdout: JSON.stringify({
              version: 1,
              digest: "b".repeat(64),
              entries: 10,
            }),
          });
      else
        run.mockResolvedValue({
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            digest: "b".repeat(64),
            entries: 10,
          }),
        });
      await expect(migrate()).resolves.toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(abandon).toHaveBeenCalledTimes(1);
      expect(Sandbox.kill).not.toHaveBeenCalled();
      expect(
        JSON.stringify((phLogger.event as jest.Mock).mock.calls),
      ).not.toContain("private-path");
    },
  );

  it("keeps the fence when a commit response is lost", async () => {
    commit.mockRejectedValue(new Error("network"));
    await expect(migrate()).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect(abandon).not.toHaveBeenCalled();
    expect(Sandbox.kill).not.toHaveBeenCalled();
  });
});
