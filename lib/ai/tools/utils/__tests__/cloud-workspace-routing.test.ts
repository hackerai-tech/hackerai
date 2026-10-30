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
beforeEach(() => {
  jest.resetAllMocks();
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
afterAll(() => {
  process.env = env;
});

it("keeps the first workspace region across request-location changes and returning visits", async () => {
  expect(await resolve("eu-central-1")).toBe("eu-central-1");
  expect(await resolve("us-east-1")).toBe("eu-central-1");
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
  "two-clusters",
  "unknown-owner",
  "incomplete",
  "unavailable",
  "corrupt-binding",
  "conflicting-evidence",
])("does not guess placement or write a binding on %s", async (condition) => {
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
});
it("rejects a competing binding that would hide discovered files", async () => {
  inventory(["eu"]);
  mockSet.mockImplementation(async () => {
    mockData.set(regionKey, "us-east-1");
  });
  await expect(resolve("us-east-1")).rejects.toBeInstanceOf(
    CloudWorkspaceUnavailableError,
  );
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
});
