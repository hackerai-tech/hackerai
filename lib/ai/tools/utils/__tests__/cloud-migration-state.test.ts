import { createRedisClient } from "@/lib/rate-limit/redis";
import { refreshE2BSandboxLease } from "../e2b-lease";
import {
  assertCloudWorkspaceAvailable,
  claimCloudMigration,
  claimCloudWorkspaceCleanup,
  commitRecoveredE2BWorkspace,
  readCloudMigrationState,
  CloudMigrationUnavailableError,
  registerE2BMigrationLease,
  refreshE2BMigrationLease,
  pinFreshE2BFallback,
  canUseFreshE2BFallback,
} from "../cloud-migration-state";

jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

describe("persistent cloud migration fence", () => {
  const records = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) =>
      records.has(key) ? JSON.parse(records.get(key)!) : null,
    ),
    eval: jest.fn(
      async (
        script: string,
        [key, activity]: string[],
        [expected, next, owner, committed]: string[],
      ) => {
        if (script.includes("old.recovery")) {
          const raw = records.get(key);
          if (!raw) return 0;
          const state = JSON.parse(raw);
          if (
            state.phase !== "cleanup" ||
            state.recovery?.operation !== "miosa-to-e2b" ||
            state.recovery.phase !== "claimed" ||
            state.recovery.miosaId !== expected ||
            state.recovery.e2bId !== next ||
            state.recovery.ownerRunId !== owner
          )
            return 0;
          records.set(key, committed);
          return 1;
        }
        if (script.includes("cjson.decode")) {
          const raw = records.get(key);
          if (raw) {
            const state = JSON.parse(raw);
            if (
              state.phase !== "e2b" ||
              !state.destinationId ||
              state.destinationId !== (next ?? "")
            )
              return 0;
          }
          records.set(activity, "active");
          return 1;
        }
        if (script.includes("'EXISTS'")) {
          if (records.has(key)) return 0;
          if (script.includes("'EX'")) {
            records.set(activity, "active");
            return 1;
          }
          if (records.has(activity)) return 0;
          records.set(key, expected);
          return 1;
        }
        if ((records.get(key) ?? "") !== expected) return 0;
        if (next) records.set(key, next);
        else records.delete(key);
        return 1;
      },
    ),
  };
  beforeEach(() => {
    records.clear();
    jest.clearAllMocks();
    (createRedisClient as jest.Mock).mockReturnValue(redis);
  });

  it("pins fresh E2B, retains the whole recovery record, and invalidates stale job ownership", async () => {
    const claim = await claimCloudMigration(
      "user-1",
      "original-e2b",
      "us-east-1",
    );
    const observed = (await readCloudMigrationState("user-1"))!;
    await expect(
      pinFreshE2BFallback({
        userId: "user-1",
        observed,
        destinationId: "fresh-e2b",
        region: "us-east-1",
      }),
    ).resolves.toBe(true);
    expect(await readCloudMigrationState("user-1")).toEqual(
      expect.objectContaining({
        phase: "e2b",
        destinationId: "fresh-e2b",
        recoveryPending: observed,
      }),
    );
    await expect(claim!.commit("prepared-miosa")).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b", "fresh-e2b"),
    ).resolves.toBeUndefined();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b", "original-e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      pinFreshE2BFallback({
        userId: "user-1",
        observed,
        destinationId: "loser",
        region: "us-east-1",
      }),
    ).resolves.toBe(false);
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("e2b");
  });

  it.each(["cleanup", "deleted"] as const)(
    "never bypasses an account %s fence",
    async (phase) => {
      const observed = { version: 1 as const, phase, token: "account-cleanup" };
      expect(canUseFreshE2BFallback(observed)).toBe(false);
      await expect(
        pinFreshE2BFallback({
          userId: "user-1",
          observed,
          destinationId: "fresh",
          region: "us-east-1",
        }),
      ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    },
  );

  it("lets only one checker claim a user and blocks both providers while checking", async () => {
    await claimCloudMigration("user-1", "source", "us-east-1");
    await expect(
      claimCloudMigration("user-1", "source", "us-east-1"),
    ).resolves.toBeNull();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "miosa"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
  });

  it("persists owner identity through commit and still prevents stale release", async () => {
    const owner = { runId: "run_owner", attempt: 2 };
    const claim = await claimCloudMigration(
      "user-1",
      "source",
      "us-east-1",
      owner,
    );
    expect(await readCloudMigrationState("user-1")).toMatchObject({
      phase: "checking",
      owner,
    });
    await claim!.commit("destination");
    expect(await readCloudMigrationState("user-1")).toMatchObject({
      phase: "miosa",
      owner,
      destinationId: "destination",
    });
    await expect(claim!.abandon()).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
  });

  it.each([
    null,
    { runId: "run_owner", attempt: 0 },
    { runId: "bad", attempt: 1 },
  ])("fails closed on malformed persisted ownership: %j", async (owner) => {
    records.set(
      "cloud_workspace_migration:v1:user-1",
      JSON.stringify({
        version: 1,
        phase: "checking",
        token: "token",
        sourceId: "source",
        region: "us-east-1",
        owner,
      }),
    );
    await expect(readCloudMigrationState("user-1")).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
  });

  it("remains on Miosa across flag changes, with no expiring key", async () => {
    const claim = await claimCloudMigration("user-1", "source", "us-east-1");
    await claim!.commit();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "miosa"),
    ).resolves.toBeUndefined();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(claim!.abandon()).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("miosa");
  });

  it("persists the verified destination identity for file migration recovery", async () => {
    const claim = await claimCloudMigration("user-1", "source", "us-east-1");
    await claim!.commit("verified-destination");
    expect((await readCloudMigrationState("user-1"))?.destinationId).toBe(
      "verified-destination",
    );
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
  });

  it("only leases the exact recovered E2B sandbox and keeps MIOSA fenced", async () => {
    const pinned = {
      version: 1,
      phase: "e2b",
      token: "recovery-token",
      sourceId: "miosa-source",
      destinationId: "verified-e2b",
      region: "us-east-1",
    };
    records.set("cloud_workspace_migration:v1:user-1", JSON.stringify(pinned));
    expect(await readCloudMigrationState("user-1")).toEqual(pinned);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b", "verified-e2b"),
    ).resolves.toBeUndefined();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b", "stale-e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "miosa"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    const cleanup = await claimCloudWorkspaceCleanup("user-1", false);
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("cleanup");
    await cleanup.finish(false);
    expect(await readCloudMigrationState("user-1")).toEqual(pinned);
  });

  it("commits a verified E2B recovery only from the exact claimed fence", async () => {
    const key = "cloud_workspace_migration:v1:user-1";
    const recovery = {
      operation: "miosa-to-e2b",
      phase: "claimed",
      miosaId: "miosa-source",
      e2bId: "old-e2b",
      ownerRunId: "run_operator",
    };
    records.set(
      key,
      JSON.stringify({ version: 1, phase: "cleanup", token: "old", recovery }),
    );
    const options = {
      userId: "user-1",
      sourceId: "miosa-source",
      previousE2BId: "old-e2b",
      recoveryOwnerRunId: "run_operator",
      destinationId: "new-e2b",
      region: "us-east-1" as const,
    };
    await expect(
      commitRecoveredE2BWorkspace({ ...options, previousE2BId: "wrong" }),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect(JSON.parse(records.get(key)!)).toMatchObject({ phase: "cleanup" });
    await commitRecoveredE2BWorkspace(options);
    expect(await readCloudMigrationState("user-1")).toMatchObject({
      phase: "e2b",
      sourceId: "miosa-source",
      destinationId: "new-e2b",
      region: "us-east-1",
    });
  });

  it("releases a denied inspection without affecting another user", async () => {
    const first = await claimCloudMigration("user-1", "source", "us-east-1");
    await claimCloudMigration("user-2", "other", "us-west-2");
    await first!.abandon();
    expect(await readCloudMigrationState("user-1")).toBeNull();
    expect((await readCloudMigrationState("user-2"))?.phase).toBe("checking");
  });

  it("does not treat malformed state or a storage outage as E2B permission", async () => {
    records.set("cloud_workspace_migration:v1:user-1", "{}");
    await expect(readCloudMigrationState("user-1")).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    redis.get.mockRejectedValueOnce(new Error("private service credential"));
    await expect(readCloudMigrationState("user-2")).rejects.toThrow(
      "Your existing workspace has been preserved",
    );
  });

  it("cannot start migration without storage", async () => {
    (createRedisClient as jest.Mock).mockReturnValue(null);
    await expect(
      claimCloudMigration("user-1", "source", "us-east-1"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
  });

  it("atomically excludes migration while an E2B request holds an activity lease", async () => {
    await assertCloudWorkspaceAvailable("user-1", "e2b");
    await expect(
      claimCloudMigration("user-1", "source", "us-east-1"),
    ).resolves.toBeNull();
    // Model expiry after a full idle interval, with no active heartbeat.
    records.delete("cloud_workspace_activity:v1:user-1");
    expect(
      await claimCloudMigration("user-1", "source", "us-east-1"),
    ).not.toBeNull();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
  });

  it("renews activity from a registered E2B worker heartbeat", async () => {
    const sandbox = {} as Parameters<typeof registerE2BMigrationLease>[0];
    registerE2BMigrationLease(sandbox, "user-1");
    await refreshE2BMigrationLease(sandbox);
    expect(records.has("cloud_workspace_activity:v1:user-1")).toBe(true);
    expect(
      await claimCloudMigration("user-1", "source", "us-east-1"),
    ).toBeNull();
  });

  it("never extends a provider lease for an unregistered SDK object", async () => {
    const setTimeout = jest.fn();
    const sandbox = { setTimeout } as unknown as Parameters<
      typeof refreshE2BSandboxLease
    >[0];
    await expect(refreshE2BSandboxLease(sandbox)).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("excludes migration and both providers during reset, then permits a fresh workspace", async () => {
    const cleanup = await claimCloudWorkspaceCleanup("user-1", false);
    expect(
      await claimCloudMigration("user-1", "source", "us-east-1"),
    ).toBeNull();
    for (const provider of ["e2b", "miosa"] as const) {
      await expect(
        assertCloudWorkspaceAvailable("user-1", provider),
      ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    }
    await expect(
      claimCloudWorkspaceCleanup("user-1", false),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await cleanup.finish(true);
    expect(
      await claimCloudMigration("user-1", "fresh-source", "us-east-1"),
    ).not.toBeNull();
  });

  it("cannot replace a migration that wins after cleanup's initial read", async () => {
    redis.get.mockImplementationOnce(async () => {
      await claimCloudMigration("user-1", "source", "us-east-1");
      return null;
    });
    await expect(
      claimCloudWorkspaceCleanup("user-1", false),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("checking");
  });

  it.each([undefined, "verified-destination"])(
    "restores the committed pin after failed reset (%s), then allows reset retry",
    async (destinationId) => {
      const claim = await claimCloudMigration("user-1", "source", "us-east-1");
      await claim!.commit(destinationId);
      const before = await readCloudMigrationState("user-1");
      const cleanup = await claimCloudWorkspaceCleanup("user-1", false);
      expect(await readCloudMigrationState("user-1")).toMatchObject({
        phase: "cleanup",
        migration: before,
      });
      await cleanup.finish(false);
      expect(await readCloudMigrationState("user-1")).toEqual(before);
      const retry = await claimCloudWorkspaceCleanup("user-1", false);
      await retry.finish(true);
      expect(await readCloudMigrationState("user-1")).toBeNull();
    },
  );

  it("retains a permanent deletion fence after success or failure and permits deletion retry", async () => {
    const cleanup = await claimCloudWorkspaceCleanup("user-1", true);
    await cleanup.finish(false);
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("deleted");
    expect(
      await claimCloudMigration("user-1", "source", "us-east-1"),
    ).toBeNull();
    await expect(
      claimCloudWorkspaceCleanup("user-1", false),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    const retry = await claimCloudWorkspaceCleanup("user-1", true);
    await retry.finish(true);
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("deleted");
  });

  it("does not let a stale cleanup clear or restore a newer owner", async () => {
    const first = await claimCloudWorkspaceCleanup("user-1", false);
    await first.finish(true);
    const second = await claimCloudWorkspaceCleanup("user-1", false);
    const current = await readCloudMigrationState("user-1");
    await expect(first.finish(false)).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect(await readCloudMigrationState("user-1")).toEqual(current);
    await second.finish(true);
  });

  it("preserves local cleanup without Redis while production fails closed", async () => {
    (createRedisClient as jest.Mock).mockReturnValue(null);
    const cleanup = await claimCloudWorkspaceCleanup("user-1", false);
    await cleanup.finish(true);
    const original = process.env;
    try {
      process.env = { ...original, NODE_ENV: "production" };
      await expect(
        claimCloudWorkspaceCleanup("user-1", false),
      ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    } finally {
      process.env = original;
    }
  });
});
