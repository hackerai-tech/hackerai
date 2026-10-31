import { Sandbox } from "@e2b/code-interpreter";
import {
  workspaceRegionView,
  selectWorkspaceRegion,
} from "../cloud-workspace-selection";
import { getActiveTriggerRunsForUser } from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    connect: jest.fn(),
    create: jest.fn(),
    kill: jest.fn(),
  },
}));
jest.mock("@/lib/db/actions", () => ({
  getActiveTriggerRunsForUser: jest.fn(),
}));
jest.mock("@/lib/db/subagents", () => ({
  listActiveSubagentsForUser: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
const mockData = new Map<string, unknown>();
const mockEval = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    mget: async (...keys: string[]) => keys.map((k) => mockData.get(k) ?? null),
    get: async (key: string) => mockData.get(key) ?? null,
    eval: (...args: unknown[]) => mockEval(...args),
  }),
}));
const regionKey = "cloud_workspace_region:v1:owner";
let changedId = false;
let running = false;
let incomplete = false;
let wrongOwner = false;
const originalEnv = process.env;
beforeEach(() => {
  jest.resetAllMocks();
  mockData.clear();
  changedId = running = incomplete = wrongOwner = false;
  process.env = {
    ...originalEnv,
    CONVEX_SERVICE_ROLE_KEY: "test-only-key",
    E2B_API_KEY: "test-us",
    E2B_EU_API_KEY: "test-eu",
  };
  jest
    .mocked(getActiveTriggerRunsForUser)
    .mockResolvedValue({ runs: [], hasMore: false });
  jest
    .mocked(listActiveSubagentsForUser)
    .mockResolvedValue({ runs: [], hasMore: false });
  jest.mocked(Sandbox.list).mockImplementation((options) => {
    const cluster = options?.domain ? "eu" : "us";
    return {
      hasNext: incomplete,
      nextItems: async () => [
        {
          sandboxId: `${cluster}-${changedId ? "changed" : "original"}`,
          state: running ? "running" : "paused",
          metadata: {
            userID: wrongOwner ? "other" : "owner",
            e2bCluster: cluster,
            template: "terminal-agent-sandbox",
            sandboxVersion: "v12",
          },
        },
      ],
    } as never;
  });
  mockEval.mockImplementation(
    async (_script, keys: string[], args: string[]) => {
      if (keys.some((k) => mockData.has(k))) return 0;
      mockData.set(keys[0], args[0]);
      return 1;
    },
  );
});
afterAll(() => {
  process.env = originalEnv;
});
async function token() {
  const view = await workspaceRegionView("owner");
  if (view.status !== "selection_required") throw Error("Expected a choice");
  return view.token;
}
it("lets the owner choose an existing region and keeps it across readback without touching either filesystem", async () => {
  const choice = await token();
  expect(await selectWorkspaceRegion("owner", "eu-central-1", choice)).toEqual({
    status: "selected",
    region: "eu-central-1",
  });
  expect(await workspaceRegionView("owner")).toEqual({
    status: "selected",
    region: "eu-central-1",
  });
  expect([...mockData.entries()]).toEqual([[regionKey, "eu-central-1"]]);
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(Sandbox.kill).not.toHaveBeenCalled();
});
it("rejects an inventory changed since the choice was displayed", async () => {
  const choice = await token();
  changedId = true;
  await expect(
    selectWorkspaceRegion("owner", "eu-central-1", choice),
  ).rejects.toThrow();
  expect(mockEval).not.toHaveBeenCalled();
});
it("does not overwrite a choice from another tab", async () => {
  const choice = await token();
  mockEval.mockImplementation(async () => {
    mockData.set(regionKey, "us-east-1");
    return 0;
  });
  await expect(
    selectWorkspaceRegion("owner", "eu-central-1", choice),
  ).rejects.toThrow();
  expect(mockData.get(regionKey)).toBe("us-east-1");
});
it.each(["migration", "failures", "consent", "result"])(
  "preserves a concurrent %s fence",
  async (kind) => {
    const keys: Record<string, string> = {
      migration: "cloud_workspace_migration",
      failures: "cloud_resume_failures",
      consent: "cloud_recovery_consent",
      result: "cloud_workspace_recovery_result",
    };
    const choice = await token();
    mockEval.mockImplementation(async () => {
      mockData.set(`${keys[kind]}:v1:owner`, "concurrent-record");
      return 0;
    });
    await expect(
      selectWorkspaceRegion("owner", "us-east-1", choice),
    ).rejects.toThrow();
    expect(mockData.has(regionKey)).toBe(false);
  },
);
it.each([
  "active-parent",
  "active-child",
  "running",
  "incomplete",
  "wrong-owner",
  "recovery",
  "wrong-token",
])("refuses unsafe selection: %s", async (condition) => {
  const choice = await token();
  if (condition === "active-parent")
    jest
      .mocked(getActiveTriggerRunsForUser)
      .mockResolvedValue({ runs: [], hasMore: true });
  if (condition === "active-child")
    jest
      .mocked(listActiveSubagentsForUser)
      .mockResolvedValue({ runs: [], hasMore: true });
  if (condition === "running") running = true;
  if (condition === "incomplete") incomplete = true;
  if (condition === "wrong-owner") wrongOwner = true;
  if (condition === "recovery")
    mockData.set("cloud_recovery_consent:v1:owner", { status: "executing" });
  await expect(
    selectWorkspaceRegion(
      "owner",
      "us-east-1",
      condition === "wrong-token" ? "a".repeat(64) : choice,
    ),
  ).rejects.toThrow();
  expect(mockEval).not.toHaveBeenCalled();
});
