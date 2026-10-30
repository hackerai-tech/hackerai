import { Sandbox } from "@e2b/code-interpreter";
import { resolveCloudWorkspaceRegion } from "../cloud-workspace-routing";
import { CloudWorkspaceUnavailableError } from "../cloud-workspace-guard";

jest.mock("@e2b/code-interpreter", () => ({ Sandbox: { list: jest.fn() } }));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
const mockData = new Map<string, unknown>();
const mockSet = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    get: async (key: string) => mockData.get(key) ?? null,
    set: mockSet,
  }),
}));
const regionKey = "cloud_workspace_region:v1:owner";
const stateKey = "cloud_workspace_migration:v1:owner";
const failedKey = "cloud_resume_failures:v1:owner";
const workspace = {
  version: 1,
  phase: "e2b",
  token: "owner-token",
  sourceId: "retained",
  destinationId: "original-files",
  region: "us-east-1",
};
const failed = {
  sandboxId: "original-files",
  region: "us-east-1",
  template: "template",
  sandboxVersion: "v12",
  attempts: ["7ad19af5-4d14-4d4b-aab7-90734610a6da"],
  uncertain: true,
  timeoutOnly: true,
  lastFailedAt: Date.now(),
};
const resolve = (
  preferredRegion: "us-east-1" | "eu-central-1",
  signal?: AbortSignal,
) => resolveCloudWorkspaceRegion({ userId: "owner", preferredRegion, signal });
const inventory = (clusters: string[]) => {
  jest.mocked(Sandbox.list).mockImplementation(
    (options) =>
      ({
        hasNext: false,
        nextItems: async () =>
          clusters.includes(options?.domain ? "eu" : "us")
            ? [{ sandboxId: "original-files", metadata: { userID: "owner" } }]
            : [],
      }) as never,
  );
};
const env = process.env;
let warning: jest.SpyInstance;
beforeEach(() => {
  jest.resetAllMocks();
  warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockData.clear();
  process.env = {
    ...env,
    E2B_API_KEY: "synthetic-us",
    E2B_EU_API_KEY: "synthetic-eu",
    CLOUD_DISK_RECOVERY_TARGETS: "configured",
  };
  mockSet.mockImplementation(async (key: string, value: unknown) => {
    if (!mockData.has(key)) mockData.set(key, value);
  });
  inventory([]);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = env;
});

it("keeps the first workspace region across request-location changes and returning visits", async () => {
  expect(await resolve("eu-central-1")).toBe("eu-central-1");
  expect(await resolve("us-east-1")).toBe("eu-central-1");
  expect(warning).not.toHaveBeenCalled();
  expect(mockSet).toHaveBeenCalledWith(regionKey, "eu-central-1", { nx: true });
  // A returning visit reads the durable binding without depending on either provider.
  jest.mocked(Sandbox.list).mockImplementation(() => {
    throw new Error("offline");
  });
  expect(await resolve("us-east-1")).toBe("eu-central-1");
});
it("adopts legacy paused files from their actual cluster instead of the request IP", async () => {
  inventory(["eu"]);
  expect(await resolve("us-east-1")).toBe("eu-central-1");
  expect(mockData.get(regionKey)).toBe("eu-central-1");
  expect(Sandbox.list).toHaveBeenCalledWith(
    expect.objectContaining({
      query: { metadata: { userID: "owner" }, state: ["running", "paused"] },
    }),
  );
});
it("concurrent first visits converge on the stored winner", async () => {
  const results = await Promise.all([
    resolve("us-east-1"),
    resolve("eu-central-1"),
  ]);
  expect(results[0]).toBe(results[1]);
  expect(results[0]).toBe(mockData.get(regionKey));
});
it.each(["recovered", "failed"])(
  "preserves a %s workspace even when the user changes location",
  async (kind) => {
    mockData.set(
      kind === "recovered" ? stateKey : failedKey,
      kind === "recovered" ? workspace : failed,
    );
    expect(await resolve("eu-central-1")).toBe("us-east-1");
    expect(Sandbox.list).not.toHaveBeenCalled();
  },
);
it.each([
  ["two-clusters", "inventory_multiple_clusters"],
  ["unknown-owner", "inventory_owner_mismatch"],
  ["incomplete", "inventory_incomplete"],
  ["unavailable", undefined],
  ["corrupt-binding", "stored_region_invalid"],
  ["conflicting-evidence", "recovery_evidence_conflict"],
])(
  "does not guess placement or write a binding on %s",
  async (condition, reason) => {
    if (condition === "two-clusters") inventory(["us", "eu"]);
    if (condition === "unknown-owner")
      jest.mocked(Sandbox.list).mockReturnValue({
        hasNext: false,
        nextItems: async () => [{ metadata: { userID: "other" } }],
      } as never);
    if (condition === "incomplete")
      jest
        .mocked(Sandbox.list)
        .mockReturnValue({ hasNext: true, nextItems: async () => [] } as never);
    if (condition === "unavailable")
      jest.mocked(Sandbox.list).mockImplementation(() => {
        throw new Error("read failed");
      });
    if (condition === "corrupt-binding") mockData.set(regionKey, "unknown");
    if (condition === "conflicting-evidence") {
      mockData.set(stateKey, workspace);
      mockData.set(failedKey, { ...failed, region: "eu-central-1" });
    }
    await expect(resolve("us-east-1")).rejects.toThrow();
    expect(mockSet).not.toHaveBeenCalled();
    if (reason) {
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "Cloud workspace routing unavailable",
        {
          event: "cloud_workspace_routing_unavailable",
          reason,
          user_id: "owner",
        },
      );
    } else {
      // Provider exceptions still propagate without being reclassified as a guard rejection.
      expect(warning).not.toHaveBeenCalled();
    }
  },
);
it("rejects a competing binding that would hide discovered files", async () => {
  inventory(["eu"]);
  mockSet.mockImplementation(async () => {
    mockData.set(regionKey, "us-east-1");
  });
  await expect(resolve("us-east-1")).rejects.toBeInstanceOf(
    CloudWorkspaceUnavailableError,
  );
  expect(warning).toHaveBeenCalledWith("Cloud workspace routing unavailable", {
    event: "cloud_workspace_routing_unavailable",
    reason: "claimed_region_conflict",
    user_id: "owner",
  });
});
it("does not save late discovery after cancellation", async () => {
  const controller = new AbortController();
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      controller.abort();
      return [];
    },
  } as never);
  await expect(resolve("us-east-1", controller.signal)).rejects.toThrow();
  expect(mockSet).not.toHaveBeenCalled();
  expect(warning).not.toHaveBeenCalled();
});

it("preserves an inventory exception without logging its private message", async () => {
  const failure = new Error("private-provider-failure");
  jest.mocked(Sandbox.list).mockImplementation(() => {
    throw failure;
  });
  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
});

it("does not misattribute a late inventory result after a provider rejection", async () => {
  const failure = new Error("private-provider-failure");
  let finishLate!: (items: { metadata: { userID: string } }[]) => void;
  const late = new Promise<{ metadata: { userID: string } }[]>((resolve) => {
    finishLate = resolve;
  });
  jest.mocked(Sandbox.list).mockImplementation(
    (options) =>
      ({
        hasNext: false,
        nextItems: () => (options?.domain ? late : Promise.reject(failure)),
      }) as never,
  );
  await expect(resolve("us-east-1")).rejects.toBe(failure);
  expect(warning).not.toHaveBeenCalled();
  finishLate([{ metadata: { userID: "other" } }]);
  await late;
  await Promise.resolve();
  expect(warning).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
});

it("keeps a rejected workspace fenced when diagnostic output fails", async () => {
  mockData.set(regionKey, "invalid");
  warning.mockImplementation(() => {
    throw new Error("diagnostic sink unavailable");
  });
  await expect(resolve("us-east-1")).rejects.toBeInstanceOf(
    CloudWorkspaceUnavailableError,
  );
  expect(mockSet).not.toHaveBeenCalled();
});

it("reports a bounded owner identifier without serializing invalid workspace data", async () => {
  const userId = `user_${"a".repeat(200)}`;
  mockData.set(`cloud_workspace_region:v1:${userId}`, {
    private: "sensitive-workspace-material",
  });
  await expect(
    resolveCloudWorkspaceRegion({ userId, preferredRegion: "us-east-1" }),
  ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
  expect(warning).toHaveBeenCalledWith("Cloud workspace routing unavailable", {
    event: "cloud_workspace_routing_unavailable",
    reason: "stored_region_invalid",
    user_id: userId.slice(0, 128),
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain(
    "sensitive-workspace-material",
  );
  expect(mockSet).not.toHaveBeenCalled();
});
