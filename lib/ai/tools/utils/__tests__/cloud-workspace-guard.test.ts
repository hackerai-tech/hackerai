import type { Sandbox } from "@e2b/code-interpreter";
import {
  assertCloudWorkspaceAvailable,
  claimE2BDiskRecovery,
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

  it("keeps reason metadata out of generic error serialization and rejects arbitrary runtime values", () => {
    const error = new CloudWorkspaceUnavailableError("private-reason" as never);
    expect(error.cleanupClaimFailureReason).toBe("unknown");
    expect(Object.keys(error)).toEqual(["name"]);
    expect(JSON.stringify(error)).not.toContain("reason");
  });

  it.each([
    ["state_unavailable", "read"],
    ["state_unavailable", "malformed"],
    ["cleanup_blocked", "blocked"],
    ["recovery_pending", "pending"],
    ["store_unavailable", "unconfigured"],
    ["claim_conflict", "conflict"],
    ["store_error", "write"],
  ])(
    "keeps cleanup denied with bounded %s diagnostics for %s",
    async (reason, failure) => {
      if (failure === "read")
        mockGet.mockRejectedValue(new Error("private-store-error"));
      if (failure === "malformed")
        mockGet.mockResolvedValue({ token: "private-state" });
      if (failure === "blocked")
        mockGet.mockResolvedValue({
          version: 1,
          phase: "cleanup",
          token: "private-owner",
        });
      if (failure === "pending")
        mockGet.mockResolvedValue({
          ...recovered,
          recoveryPending: { secret: "private-recovery" },
        });
      if (failure === "unconfigured") {
        mockConfigured = false;
        process.env = { ...process.env, NODE_ENV: "production" };
      }
      if (failure === "conflict") mockEval.mockResolvedValue(0);
      if (failure === "write")
        mockEval.mockRejectedValue(new Error("private-store-error"));
      await expect(
        claimCloudWorkspaceCleanup("user-1", true),
      ).rejects.toMatchObject({
        name: "CloudWorkspaceUnavailableError",
        message:
          "Cloud workspace needs recovery. Please retry later. Your existing workspace has been preserved.",
        cleanupClaimFailureReason: reason,
      });
      expect(mockEval).toHaveBeenCalledTimes(
        ["conflict", "write"].includes(failure) ? 1 : 0,
      );
    },
  );

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
        "cloud_recovery_consent:v1:user-1",
        "cloud_workspace_recovery_result:v1:user-1",
      ],
      ["900", "verified-destination"],
    );
  });

  it("fences normal connections and cleanup during a durable recovery", async () => {
    const recovery = {
      version: 1,
      phase: "recovery",
      token: "attempt-1",
      operatorId: "ticket",
      sandboxId: "verified-destination",
      region: "us-east-1",
      startedAt: "2026-10-15T00:00:00.000Z",
      previous: recovered,
    };
    mockGet.mockResolvedValue(recovery);
    await expect(readCloudWorkspaceState("user-1")).resolves.toEqual(recovery);
    mockEval.mockResolvedValue(0);
    await expect(
      assertCloudWorkspaceAvailable("user-1", "verified-destination"),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    await expect(
      claimCloudWorkspaceCleanup("user-1", false),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    await expect(
      claimE2BDiskRecovery({
        userId: "user-1",
        sandboxId: "verified-destination",
        region: "us-east-1",
        token: "attempt-1",
        operatorId: "ticket",
      }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
  });

  it("claims only with the activity key absent and releases by exact ownership", async () => {
    mockGet.mockResolvedValue(recovered);
    const recovery = await claimE2BDiskRecovery({
      userId: "user-1",
      sandboxId: "verified-destination",
      region: "us-east-1",
      token: "attempt-2",
      operatorId: "ticket",
    });
    expect(recovery.state).toMatchObject({
      phase: "recovery",
      previous: recovered,
    });
    expect(mockEval.mock.calls[0][1]).toEqual([
      "cloud_workspace_migration:v1:user-1",
      "cloud_workspace_activity:v1:user-1",
      "cloud_workspace_recovery_result:v1:user-1",
    ]);
    await recovery.update({
      step: "backup_created",
      backupSnapshotId: "backup-1",
    });
    expect(JSON.parse(mockEval.mock.calls[1][2][1])).toMatchObject({
      step: "backup_created",
      backupSnapshotId: "backup-1",
    });
    await recovery.finish('{"token":"attempt-2","status":"verified_paused"}');
    expect(mockEval.mock.calls[2][2][0]).toBe(mockEval.mock.calls[1][2][1]);
    expect(mockEval.mock.calls[2][2][1]).toBe(JSON.stringify(recovered));
    mockEval.mockResolvedValue(0);
    await expect(
      claimE2BDiskRecovery({
        userId: "user-1",
        sandboxId: "verified-destination",
        region: "us-east-1",
        token: "attempt-3",
        operatorId: "ticket",
      }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
  });

  it("will not claim a different migrated destination or region", async () => {
    mockGet.mockResolvedValue(recovered);
    await expect(
      claimE2BDiskRecovery({
        userId: "user-1",
        sandboxId: "other",
        region: "us-east-1",
        token: "attempt",
        operatorId: "ticket",
      }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    await expect(
      claimE2BDiskRecovery({
        userId: "user-1",
        sandboxId: "verified-destination",
        region: "eu-central-1",
        token: "attempt",
        operatorId: "ticket",
      }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(mockEval).not.toHaveBeenCalled();
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

  it.each([
    ["read_state", "state_read_failed", "read"],
    ["read_state", "state_invalid", "malformed"],
    ["read_state", "store_unavailable", "missing_read"],
    ["assert_available", "store_unavailable", "missing_assert"],
    ["assert_available", "availability_rejected", "denied"],
    ["assert_available", "availability_store_error", "eval"],
  ])(
    "diagnoses %s/%s without exposing stored state or changing the fence",
    async (operation, reason, failure) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        if (failure === "read")
          mockGet.mockRejectedValue(new Error("private-redis-canary"));
        if (failure === "malformed")
          mockGet.mockResolvedValue({ token: "private-state-canary" });
        if (failure.startsWith("missing")) {
          mockConfigured = false;
          process.env = { ...process.env, NODE_ENV: "production" };
        }
        if (failure === "denied") mockEval.mockResolvedValue(0);
        if (failure === "eval")
          mockEval.mockRejectedValue(new Error("private-eval-canary"));
        const userId = "user-" + "x".repeat(150);
        await expect(
          operation === "read_state"
            ? readCloudWorkspaceState(userId)
            : assertCloudWorkspaceAvailable(
                userId,
                "private-destination-canary",
              ),
        ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
        expect(warn.mock.calls).toEqual([
          [
            "Cloud workspace guard unavailable",
            {
              event: "cloud_workspace_guard_unavailable",
              operation,
              reason,
              user_id: userId.slice(0, 128),
            },
          ],
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("keeps diagnostics silent for successful guards and cannot replace a denial with a logger error", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(readCloudWorkspaceState("user-1")).resolves.toBeNull();
      await expect(
        assertCloudWorkspaceAvailable("user-1"),
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      warn.mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      mockEval.mockResolvedValue(0);
      await expect(
        assertCloudWorkspaceAvailable("user-1"),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    } finally {
      warn.mockRestore();
    }
  });
});

it("refuses a customer claim when a preservation field appeared before fencing", async () => {
  mockGet.mockResolvedValue({ ...recovered, preservationHold: "pending" });
  mockEval.mockClear();
  await expect(
    claimE2BDiskRecovery({
      userId: "user-1",
      sandboxId: recovered.destinationId,
      region: "us-east-1",
      token: "customer-attempt",
      operatorId: "customer:user-1",
      customerConsent: {
        key: "cloud_recovery_consent:v1:user-1",
        token: "customer-attempt",
      },
    }),
  ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
  expect(mockEval).not.toHaveBeenCalled();
});
