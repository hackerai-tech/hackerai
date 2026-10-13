import type { Sandbox } from "@e2b/code-interpreter";
import {
  assertCloudWorkspaceAvailable,
  claimCloudWorkspaceCleanup,
  CloudWorkspaceUnavailableError,
  readCloudWorkspaceState,
  refreshE2BWorkspaceLease,
  registerE2BWorkspaceLease,
} from "../cloud-workspace-guard";

const mockGet = jest.fn();
const mockEval = jest.fn();
let mockConfigured = true;
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () =>
    mockConfigured ? { get: mockGet, eval: mockEval } : null,
}));
const recovered = {
  version: 1,
  phase: "e2b",
  token: "owner",
  sourceId: "retained-source",
  destinationId: "verified-destination",
  region: "us-east-1",
};

describe("cloud workspace guard", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    mockConfigured = true;
    mockGet.mockResolvedValue(null);
    mockEval.mockResolvedValue(1);
    process.env = { ...originalEnv };
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it("keeps the existing namespace and exact recovered destination", async () => {
    mockGet.mockResolvedValue(recovered);
    await expect(readCloudWorkspaceState("user-1")).resolves.toEqual(recovered);
    expect(mockGet).toHaveBeenCalledWith("cloud_workspace_migration:v1:user-1");
    await assertCloudWorkspaceAvailable("user-1", "verified-destination");
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      [
        "cloud_workspace_migration:v1:user-1",
        "cloud_workspace_activity:v1:user-1",
      ],
      ["900", "verified-destination"],
    );
  });

  it.each([
    "invalid",
    {},
    { ...recovered, version: 2 },
    { ...recovered, destinationId: "" },
    { ...recovered, region: "unknown" },
    { ...recovered, token: "" },
    { ...recovered, phase: "checking" },
    { ...recovered, phase: "retired-provider" },
    {
      version: 1,
      phase: "cleanup",
      token: "owner",
      migration: { phase: "retired-provider" },
    },
  ])(
    "never treats an unsupported or malformed persistent record as absent: %j",
    async (value) => {
      mockGet.mockResolvedValue(value);
      await expect(readCloudWorkspaceState("user-1")).rejects.toBeInstanceOf(
        CloudWorkspaceUnavailableError,
      );
      await expect(
        claimCloudWorkspaceCleanup("user-1", true),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
      expect(mockEval).not.toHaveBeenCalled();
    },
  );

  it("does not clear pending recovery even when fresh E2B execution is available", async () => {
    const pending = {
      ...recovered,
      recoveryPending: { phase: "checking", sourceId: "retained-files" },
    };
    mockGet.mockResolvedValue(pending);
    await expect(readCloudWorkspaceState("user-1")).resolves.toEqual(pending);
    await expect(
      claimCloudWorkspaceCleanup("user-1", true),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("rejects another cleanup owner and never invokes finish", async () => {
    mockEval.mockResolvedValue(0);
    await expect(
      claimCloudWorkspaceCleanup("user-1", false),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it("restores a recovered destination after unsuccessful ordinary cleanup", async () => {
    mockGet.mockResolvedValue(recovered);
    const cleanup = await claimCloudWorkspaceCleanup("user-1", false);
    await cleanup.finish(false);
    const next = mockEval.mock.calls[1][2][1];
    expect(JSON.parse(next)).toEqual(recovered);
  });

  it("retains a permanent deletion fence and the destination after partial failure", async () => {
    mockGet.mockResolvedValue(recovered);
    const cleanup = await claimCloudWorkspaceCleanup("user-1", true);
    await cleanup.finish(false);
    const next = JSON.parse(mockEval.mock.calls[1][2][1]);
    expect(next).toMatchObject({
      version: 1,
      phase: "deleted",
      migration: recovered,
    });
  });

  it("only releases a successful ordinary cleanup with compare-and-set ownership", async () => {
    const cleanup = await claimCloudWorkspaceCleanup("user-1", false);
    await cleanup.finish(true);
    expect(mockEval.mock.calls[1][2][1]).toBe("");
    mockEval.mockResolvedValue(0);
    await expect(cleanup.finish(true)).rejects.toBeInstanceOf(
      CloudWorkspaceUnavailableError,
    );
  });

  it("cannot renew a client without its user registration, or after the guard denies it", async () => {
    const sandbox = { sandboxId: "verified-destination" } as Sandbox;
    await expect(refreshE2BWorkspaceLease(sandbox)).rejects.toBeInstanceOf(
      CloudWorkspaceUnavailableError,
    );
    expect(mockEval).not.toHaveBeenCalled();
    registerE2BWorkspaceLease(sandbox, "user-1");
    mockEval.mockResolvedValue(0);
    await expect(refreshE2BWorkspaceLease(sandbox)).rejects.toBeInstanceOf(
      CloudWorkspaceUnavailableError,
    );
  });

  it("fails closed for unavailable Production Redis and keeps local development optional", async () => {
    mockConfigured = false;
    process.env = { ...process.env, NODE_ENV: "production" };
    await expect(readCloudWorkspaceState("user-1")).rejects.toBeInstanceOf(
      CloudWorkspaceUnavailableError,
    );
    await expect(
      assertCloudWorkspaceAvailable("user-1", "s-1"),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    process.env = { ...process.env, NODE_ENV: "development" };
    await expect(readCloudWorkspaceState("user-1")).resolves.toBeNull();
  });
});
