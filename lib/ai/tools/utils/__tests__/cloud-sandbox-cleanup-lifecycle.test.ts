import { Sandbox } from "@e2b/code-interpreter";
import { phLogger } from "@/lib/posthog/server";
import { terminateCloudSandboxesForUser } from "../cloud-sandbox";
import { claimCloudWorkspaceCleanup } from "../cloud-workspace-guard";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), kill: jest.fn() },
}));
jest.mock("../cloud-workspace-guard", () => ({
  ...jest.requireActual("../cloud-workspace-guard"),
  claimCloudWorkspaceCleanup: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));

const claim = jest.mocked(claimCloudWorkspaceCleanup);
const list = jest.mocked(Sandbox.list);
const finish = jest.fn<Promise<void>, [boolean]>();
const records = () =>
  jest
    .mocked(phLogger.event)
    .mock.calls.filter(([event]) => event === "cloud_sandbox_cleanup_lifecycle")
    .map(([, fields]) => fields!);

describe("cloud cleanup lifecycle diagnostics", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, E2B_API_KEY: "test-key" };
    delete process.env.E2B_EU_API_KEY;
    delete process.env.E2B_EU_DOMAIN;
    claim.mockResolvedValue({ migration: null, finish });
    finish.mockResolvedValue(undefined);
    list.mockReturnValue({
      nextItems: jest.fn().mockResolvedValue([]),
      hasNext: false,
    } as ReturnType<typeof Sandbox.list>);
    jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it("correlates an acquired cleanup through finalization without exposing ownership state", async () => {
    claim.mockResolvedValue({
      migration: {
        version: 1,
        phase: "e2b",
        token: "private-owner-token",
        sourceId: "private-source",
        destinationId: "private-destination",
        region: "us-east-1",
      },
      finish,
    });
    await expect(
      terminateCloudSandboxesForUser("user-test", { permanent: true }),
    ).resolves.toEqual({ total: 0, killed: 0, alreadyGone: 0 });
    expect(claim).toHaveBeenCalledWith("user-test", true);
    expect(finish).toHaveBeenCalledWith(true);
    const events = records();
    expect(events.map(({ phase, outcome }) => [phase, outcome])).toEqual([
      ["claim", "started"],
      ["claim", "success"],
      ["provider_cleanup", "success"],
      ["finalize", "started"],
      ["finalize", "success"],
    ]);
    expect(new Set(events.map(({ cleanup_id }) => cleanup_id)).size).toBe(1);
    expect(events[0].cleanup_id).toEqual(expect.any(String));
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        [
          "userId",
          "cleanup_id",
          "permanent",
          "phase",
          "outcome",
          "duration_ms",
          ...(event.phase === "claim" ? [] : ["provider_cleanup_succeeded"]),
        ].sort(),
      );
      expect(event.userId).toBe("user-test");
      expect(event.permanent).toBe(true);
      expect(event.duration_ms).toEqual(expect.any(Number));
    }
    const captured = JSON.stringify([
      jest.mocked(phLogger.event).mock.calls,
      jest.mocked(console.info).mock.calls,
    ]);
    for (const secret of [
      "private-owner-token",
      "private-source",
      "private-destination",
      "test-key",
    ])
      expect(captured).not.toContain(secret);
  });

  it("reports claim rejection without deleting resources or finalizing another owner's fence", async () => {
    const rejection = new Error("private-claim-details");
    claim.mockRejectedValue(rejection);
    await expect(terminateCloudSandboxesForUser("user-test")).rejects.toBe(
      rejection,
    );
    expect(list).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(records().map(({ phase, outcome }) => [phase, outcome])).toEqual([
      ["claim", "started"],
      ["claim", "error"],
    ]);
    expect(JSON.stringify(records())).not.toContain(rejection.message);
  });

  it("keeps a provider failure visible after successful fence finalization", async () => {
    const failure = new Error("private-provider-details");
    list.mockImplementation(() => {
      throw failure;
    });
    await expect(terminateCloudSandboxesForUser("user-test")).rejects.toBe(
      failure,
    );
    expect(finish).toHaveBeenCalledWith(false);
    expect(records().slice(-3)).toEqual([
      expect.objectContaining({
        phase: "provider_cleanup",
        outcome: "error",
        provider_cleanup_succeeded: false,
      }),
      expect.objectContaining({
        phase: "finalize",
        outcome: "started",
        provider_cleanup_succeeded: false,
      }),
      expect.objectContaining({
        phase: "finalize",
        outcome: "success",
        provider_cleanup_succeeded: false,
      }),
    ]);
    expect(JSON.stringify(records())).not.toContain(failure.message);
  });

  it.each([false, true])(
    "preserves finalization failure precedence when provider failure is %s",
    async (providerFails) => {
      if (providerFails)
        list.mockImplementation(() => {
          throw new Error("provider");
        });
      const failure = new Error("private-finalize-details");
      finish.mockRejectedValue(failure);
      await expect(terminateCloudSandboxesForUser("user-test")).rejects.toBe(
        failure,
      );
      expect(finish).toHaveBeenCalledWith(!providerFails);
      expect(records().at(-1)).toEqual(
        expect.objectContaining({
          phase: "finalize",
          outcome: "error",
          provider_cleanup_succeeded: !providerFails,
        }),
      );
      expect(JSON.stringify(records())).not.toContain(failure.message);
    },
  );

  it.each(["console", "posthog"])(
    "does not change cleanup when %s telemetry throws",
    async (sink) => {
      if (sink === "console")
        jest.mocked(console.info).mockImplementation(() => {
          throw new Error("log unavailable");
        });
      else
        jest.mocked(phLogger.event).mockImplementation(() => {
          throw new Error("capture unavailable");
        });
      await expect(
        terminateCloudSandboxesForUser("user-test"),
      ).resolves.toEqual({ total: 0, killed: 0, alreadyGone: 0 });
      expect(finish).toHaveBeenCalledWith(true);
      if (sink === "console") expect(records()).toHaveLength(5);
      else expect(jest.mocked(console.info)).toHaveBeenCalledTimes(5);
    },
  );
});
