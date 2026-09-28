import { tasks, idempotencyKeys } from "@trigger.dev/sdk";
import { getPostHogFeatureFlagForUser } from "@/lib/posthog/server";
import { queueE2BFileMigration } from "../miosa-workspace-migration-queue";
jest.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: jest.fn() },
  idempotencyKeys: { create: jest.fn() },
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagForUser: jest.fn(),
  phLogger: { event: jest.fn() },
}));

describe("migration scheduling", () => {
  const original = process.env;
  const options = {
    userId: "user",
    subscription: "pro" as const,
    triggerRegion: "us-east-1" as const,
    workspaces: [
      {
        info: {
          sandboxId: "existing",
          metadata: { template: "test-template" },
        },
        cluster: { cluster: "us", template: "test-template" },
      },
    ],
  } as Parameters<typeof queueE2BFileMigration>[0];
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...original, TRIGGER_ENV: "preview" };
    (getPostHogFeatureFlagForUser as jest.Mock).mockResolvedValue(true);
    (idempotencyKeys.create as jest.Mock).mockImplementation(
      async (key) => key,
    );
  });
  afterAll(() => {
    process.env = original;
  });
  it("schedules after the idle interval and always keeps this acquisition on E2B", async () => {
    expect(await queueE2BFileMigration(options)).toBe(false);
    expect(tasks.trigger).toHaveBeenCalledWith(
      "miosa-e2b-file-migration",
      expect.objectContaining({ sourceId: "existing", userId: "user" }),
      expect.objectContaining({
        delay: "20m",
        region: "us-east-1",
        idempotencyKeyTTL: "12h",
      }),
    );
    expect(getPostHogFeatureFlagForUser).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_v1",
      "user",
      { hackerai_environment: "preview" },
    );
  });
  it("shares one global key across Agent nominations and isolates different sources", async () => {
    const globalKey = Symbol("opaque-global-key");
    (idempotencyKeys.create as jest.Mock).mockResolvedValue(globalKey);
    await Promise.all([
      queueE2BFileMigration(options),
      queueE2BFileMigration(options),
    ]);
    const calls = (idempotencyKeys.create as jest.Mock).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0][1]).toEqual({ scope: "global" });
    expect(
      (tasks.trigger as jest.Mock).mock.calls.every(
        (call) => call[2].idempotencyKey === globalKey,
      ),
    ).toBe(true);
    await queueE2BFileMigration({
      ...options,
      workspaces: [
        {
          ...options.workspaces[0],
          info: { ...options.workspaces[0].info, sandboxId: "other-source" },
        },
      ],
    });
    expect((idempotencyKeys.create as jest.Mock).mock.calls[2][0]).not.toEqual(
      calls[0][0],
    );
  });
  it("uses the explicit Trigger environment when worker env variables are unavailable", async () => {
    delete process.env.TRIGGER_ENV;
    delete process.env.VERCEL_ENV;

    await queueE2BFileMigration({ ...options, environment: "PREVIEW" });

    expect(getPostHogFeatureFlagForUser).toHaveBeenCalledWith(
      "miosa_e2b_file_migration_v1",
      "user",
      { hackerai_environment: "preview" },
    );
    expect(tasks.trigger).toHaveBeenCalled();
  });
  it("does not schedule users outside the independent rollout", async () => {
    (getPostHogFeatureFlagForUser as jest.Mock).mockResolvedValue(false);
    expect(await queueE2BFileMigration(options)).toBe(false);
    expect(tasks.trigger).not.toHaveBeenCalled();
  });
  it("keeps paid-plan and region gates even when selected", async () => {
    await queueE2BFileMigration({ ...options, subscription: "free" });
    await queueE2BFileMigration({ ...options, triggerRegion: "eu-central-1" });
    expect(tasks.trigger).not.toHaveBeenCalled();
  });
  it("does not interrupt acquisition when Trigger is unavailable", async () => {
    (tasks.trigger as jest.Mock).mockRejectedValue(
      new Error("provider secret"),
    );
    await expect(queueE2BFileMigration(options)).resolves.toBe(false);
  });
});
