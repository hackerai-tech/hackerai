import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  assertCloudWorkspaceAvailable,
  claimCloudMigration,
  readCloudMigrationState,
  CloudMigrationUnavailableError,
} from "../cloud-migration-state";

jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

describe("persistent cloud migration fence", () => {
  const records = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) =>
      records.has(key) ? JSON.parse(records.get(key)!) : null,
    ),
    set: jest.fn(async (key: string, value: string) => {
      if (records.has(key)) return null;
      records.set(key, value);
      return "OK";
    }),
    eval: jest.fn(
      async (script: string, [key]: string[], [expected, next]: string[]) => {
        if (records.get(key) !== expected) return 0;
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

  it("lets only one checker claim a user and blocks both providers while checking", async () => {
    await claimCloudMigration("user-1", "source", "us-east-1");
    await expect(
      claimCloudMigration("user-1", "source", "us-east-1"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "miosa"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { nx: true },
    );
  });

  it("remains on Miosa across flag changes, with no expiring key", async () => {
    const claim = await claimCloudMigration("user-1", "source", "us-east-1");
    await claim.commit();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "miosa"),
    ).resolves.toBeUndefined();
    await expect(
      assertCloudWorkspaceAvailable("user-1", "e2b"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(claim.abandon()).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect((await readCloudMigrationState("user-1"))?.phase).toBe("miosa");
  });

  it("releases a denied inspection without affecting another user", async () => {
    const first = await claimCloudMigration("user-1", "source", "us-east-1");
    await claimCloudMigration("user-2", "other", "us-west-2");
    await first.abandon();
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
});
