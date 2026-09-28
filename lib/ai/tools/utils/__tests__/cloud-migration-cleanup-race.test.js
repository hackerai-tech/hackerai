const mockHarness = {
  records: new Map(),
  targets: new Map(),
  events: [],
  cleanupListed: undefined,
  releaseCleanup: undefined,
  cleanupGate: undefined,
  sourceDestroyed: false,
  beforeInventory: undefined,
  cleanupFailure: undefined,
};

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
  getPostHogFeatureFlagForUser: jest.fn(async () => true),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn() } }));
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    get: async (key) =>
      mockHarness.records.has(key)
        ? JSON.parse(mockHarness.records.get(key))
        : null,
    eval: async (script, [key, activity], [expected, next]) => {
      if (script.includes("'EXISTS'")) {
        if (mockHarness.records.has(key)) return 0;
        if (script.includes("'EX'")) {
          mockHarness.records.set(activity, "active");
          return 1;
        }
        if (mockHarness.records.has(activity)) return 0;
        mockHarness.records.set(key, expected);
        mockHarness.events.push("migration_claimed");
        return 1;
      }
      if ((mockHarness.records.get(key) ?? "") !== expected) return 0;
      if (next) {
        mockHarness.records.set(key, next);
        mockHarness.events.push(`${JSON.parse(next).phase}_stored`);
      } else mockHarness.records.delete(key);
      return 1;
    },
  }),
}));

jest.mock("@e2b/code-interpreter", () => ({
  CommandExitError: class CommandExitError extends Error {},
  Sandbox: {
    list: (options) => ({
      hasNext: false,
      nextItems: async () => {
        if (options.limit === 1) {
          await mockHarness.beforeInventory?.();
          return mockHarness.sourceDestroyed ? [] : [mockHarness.sourceInfo];
        }
        mockHarness.events.push("cleanup_e2b_inventory_wait");
        mockHarness.cleanupListed();
        await mockHarness.cleanupGate;
        mockHarness.events.push("cleanup_e2b_inventory_read");
        return mockHarness.sourceDestroyed ? [] : [mockHarness.sourceInfo];
      },
    }),
    getInfo: async () => mockHarness.sourceInfo,
    connect: async () => mockHarness.source,
    kill: async (id) => {
      expect(id).toBe("synthetic-source");
      mockHarness.sourceDestroyed = true;
      mockHarness.events.push("source_destroyed");
    },
  },
}));

jest.mock("@miosa/sdk", () => {
  class NotFoundError extends Error {}
  return {
    NotFoundError,
    Miosa: class Miosa {
      constructor() {
        this.sandboxes = {
          list: async ({ externalUserId }) => {
            mockHarness.events.push("cleanup_miosa_snapshot");
            if (mockHarness.cleanupFailure) throw mockHarness.cleanupFailure;
            return [...mockHarness.targets.values()].filter(
              (s) => s.data.external_user_id === externalUserId,
            );
          },
          getByName: async (name) => {
            const found = [...mockHarness.targets.values()].find(
              (s) => s.data.name === name,
            );
            if (!found) throw new NotFoundError("synthetic absent");
            return found;
          },
          getOrCreate: async ({ name, templateId, externalUserId }) => {
            mockHarness.events.push("destination_created");
            const target = {
              id: "synthetic-destination",
              state: "running",
              data: {
                name,
                template_id: templateId,
                external_user_id: externalUserId,
                boot_path: "created",
              },
              retainedArchive: false,
              readiness: async () => ({ ready: true, state: "running" }),
              refresh: async () => undefined,
              pause: async () => {
                target.state = "paused";
              },
              resume: async () => {
                target.state = "running";
              },
              destroy: async () => {
                mockHarness.targets.delete(target.id);
              },
              files: { write: async () => undefined },
              exec: {
                stream: async function* () {
                  yield { type: "exit", exit_code: 0 };
                },
                run: async (command) => {
                  if (command.includes(" restore '/"))
                    return mockHarness.ok({
                      archiveDigest: mockHarness.capture.archiveDigest,
                      homeDigest: mockHarness.capture.homeDigest,
                    });
                  if (command.includes(" verify-home '/"))
                    return mockHarness.ok({
                      homeDigest: mockHarness.capture.homeDigest,
                    });
                  if (command.startsWith("sha256sum"))
                    return {
                      exitCode: 0,
                      stdout: `${mockHarness.capture.archiveDigest} file`,
                      stderr: "",
                    };
                  if (command.includes("e2b-filesystem.tar.gz"))
                    target.retainedArchive = true;
                  return mockHarness.ok();
                },
              },
            };
            mockHarness.targets.set(target.id, target);
            return target;
          },
        };
      }
    },
  };
});

const { createHash } = require("node:crypto");
const { ReadableStream } = require("node:stream/web");
const {
  migrateE2BWorkspace,
} = require("@/lib/ai/tools/utils/miosa-workspace-migration");
const {
  terminateCloudSandboxesForUser,
} = require("@/lib/ai/tools/utils/cloud-sandbox");
const {
  claimCloudMigration,
  readCloudMigrationState,
  CloudMigrationUnavailableError,
} = require("@/lib/ai/tools/utils/cloud-migration-state");

const request = {
  userId: "synthetic-user",
  sourceId: "synthetic-source",
  subscription: "pro",
  triggerRegion: "us-east-1",
};

function holdCleanup() {
  const listed = new Promise((resolve) => {
    mockHarness.cleanupListed = resolve;
  });
  mockHarness.cleanupGate = new Promise((resolve) => {
    mockHarness.releaseCleanup = resolve;
  });
  return listed;
}

describe("actual workspace migration and deletion cleanup scheduling", () => {
  const originalEnv = process.env;
  afterAll(() => {
    process.env = originalEnv;
  });
  beforeEach(() => {
    // Only synthetic configuration; no environment file or real SDK connection.
    process.env = {
      NODE_ENV: "test",
      TRIGGER_ENV: "preview",
      E2B_API_KEY: "synthetic-e2b",
      MIOSA_API_KEY: "synthetic-miosa",
    };
    mockHarness.records.clear();
    mockHarness.targets.clear();
    mockHarness.events = [];
    mockHarness.sourceDestroyed = false;
    mockHarness.beforeInventory = undefined;
    mockHarness.cleanupFailure = undefined;
    mockHarness.cleanupListed = () => {};
    mockHarness.cleanupGate = Promise.resolve();
    const bytes = Buffer.from([0, 255, 2, 3]);
    mockHarness.capture = {
      version: 1,
      digest: "a".repeat(64),
      homeDigest: "b".repeat(64),
      entries: 5,
      bytes: 4,
      archiveBytes: 4,
      archiveDigest: createHash("sha256").update(bytes).digest("hex"),
    };
    mockHarness.ok = (data = {}) => ({
      exitCode: 0,
      stdout: JSON.stringify(data),
      stderr: "",
    });
    mockHarness.sourceInfo = {
      sandboxId: "synthetic-source",
      templateId: "terminal-agent-sandbox",
      state: "paused",
      metadata: {
        userID: "synthetic-user",
        template: "terminal-agent-sandbox",
      },
      lifecycle: { onTimeout: "pause" },
    };
    mockHarness.source = {
      commands: {
        list: async () => [],
        run: async (command) =>
          mockHarness.ok(
            command.includes(" export '/")
              ? mockHarness.capture
              : command.includes(" verify-source '/")
                ? { digest: mockHarness.capture.digest }
                : {},
          ),
      },
      files: {
        read: async () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      },
      betaPause: async () => {
        mockHarness.events.push("source_paused");
      },
    };
  });

  test.each([false, true])(
    "cleanup fences a later migration after Miosa enumeration (permanent=%s)",
    async (permanent) => {
      const listed = holdCleanup();
      const deletion = terminateCloudSandboxesForUser("synthetic-user", {
        permanent,
      });
      await listed;
      expect(mockHarness.targets.size).toBe(0);
      await expect(migrateE2BWorkspace(request)).rejects.toBeInstanceOf(
        CloudMigrationUnavailableError,
      );
      mockHarness.releaseCleanup();
      await expect(deletion).resolves.toEqual({
        total: 1,
        killed: 1,
        alreadyGone: 0,
      });
      expect(mockHarness.sourceDestroyed).toBe(true);
      expect(mockHarness.targets.size).toBe(0);
      expect(mockHarness.events).not.toContain("destination_created");
      expect(
        (await readCloudMigrationState("synthetic-user"))?.phase ?? null,
      ).toBe(permanent ? "deleted" : null);
    },
  );

  test("cleanup excludes a worker whose absent-state read happened before cleanup", async () => {
    let releaseInventory;
    let inventoryStarted;
    const started = new Promise((resolve) => {
      inventoryStarted = resolve;
    });
    const gate = new Promise((resolve) => {
      releaseInventory = resolve;
    });
    mockHarness.beforeInventory = async () => {
      inventoryStarted();
      await gate;
    };
    const migration = migrateE2BWorkspace(request);
    await started;
    const listed = holdCleanup();
    const deletion = terminateCloudSandboxesForUser("synthetic-user", {
      permanent: true,
    });
    await listed;
    releaseInventory();
    await expect(migration).resolves.toMatchObject({
      reason: "workspace_in_use",
    });
    mockHarness.releaseCleanup();
    await expect(deletion).resolves.toEqual({
      total: 1,
      killed: 1,
      alreadyGone: 0,
    });
    expect(mockHarness.targets.size).toBe(0);
    expect(mockHarness.events).not.toContain("destination_created");
  });

  test("account deletion blocks queued retries after cleanup returns", async () => {
    await terminateCloudSandboxesForUser("synthetic-user", { permanent: true });
    await expect(migrateE2BWorkspace(request)).rejects.toBeInstanceOf(
      CloudMigrationUnavailableError,
    );
    expect(mockHarness.events).not.toContain("destination_created");
  });

  test("a legitimate copy retains its archive until explicit reset deletes both providers", async () => {
    await expect(migrateE2BWorkspace(request)).resolves.toMatchObject({
      reason: "files_verified_and_committed",
    });
    expect(
      mockHarness.targets.get("synthetic-destination").retainedArchive,
    ).toBe(true);
    await expect(
      terminateCloudSandboxesForUser("synthetic-user"),
    ).resolves.toEqual({ total: 2, killed: 2, alreadyGone: 0 });
    expect(mockHarness.sourceDestroyed).toBe(true);
    expect(mockHarness.targets.size).toBe(0);
    expect(await readCloudMigrationState("synthetic-user")).toBeNull();
    expect(
      await claimCloudMigration("synthetic-user", "fresh-source", "us-east-1"),
    ).not.toBeNull();
  });

  test("partial account cleanup remains fenced and can retry provider deletion", async () => {
    mockHarness.cleanupFailure = new Error("synthetic provider unavailable");
    const errorSpy = jest.spyOn(console, "error").mockImplementation();
    try {
      await expect(
        terminateCloudSandboxesForUser("synthetic-user", { permanent: true }),
      ).rejects.toThrow("synthetic provider unavailable");
      expect(mockHarness.sourceDestroyed).toBe(true);
      await expect(migrateE2BWorkspace(request)).rejects.toBeInstanceOf(
        CloudMigrationUnavailableError,
      );
      mockHarness.cleanupFailure = undefined;
      await expect(
        terminateCloudSandboxesForUser("synthetic-user", { permanent: true }),
      ).resolves.toEqual({ total: 0, killed: 0, alreadyGone: 0 });
      expect((await readCloudMigrationState("synthetic-user")).phase).toBe(
        "deleted",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("deletion retries keep requiring both providers after a committed migration", async () => {
    await migrateE2BWorkspace(request);
    delete process.env.MIOSA_API_KEY;
    await expect(
      terminateCloudSandboxesForUser("synthetic-user", { permanent: true }),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    await expect(
      terminateCloudSandboxesForUser("synthetic-user", { permanent: true }),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect(mockHarness.targets.size).toBe(1);
    expect(mockHarness.sourceDestroyed).toBe(false);
    process.env.MIOSA_API_KEY = "synthetic-miosa";
    await expect(
      terminateCloudSandboxesForUser("synthetic-user", { permanent: true }),
    ).resolves.toEqual({ total: 2, killed: 2, alreadyGone: 0 });
    expect(mockHarness.targets.size).toBe(0);
    expect((await readCloudMigrationState("synthetic-user")).phase).toBe(
      "deleted",
    );
  });

  test("control: an already visible checking claim blocks cleanup before provider enumeration", async () => {
    await claimCloudMigration(
      "synthetic-user",
      "synthetic-source",
      "us-east-1",
    );
    await expect(
      terminateCloudSandboxesForUser("synthetic-user"),
    ).rejects.toBeInstanceOf(CloudMigrationUnavailableError);
    expect(mockHarness.events).toEqual(["migration_claimed"]);
    expect(mockHarness.sourceDestroyed).toBe(false);
  });
});
