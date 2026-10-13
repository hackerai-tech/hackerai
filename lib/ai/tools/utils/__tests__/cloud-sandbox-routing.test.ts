import { CloudAcquisitionBudget } from "../cloud-acquisition-budget";
import type { Sandbox } from "@e2b/code-interpreter";
import { ensureCloudSandboxConnection } from "../cloud-sandbox";
import { ensureSandboxConnection } from "../sandbox";
import { phLogger } from "@/lib/posthog/server";
import {
  assertCloudWorkspaceAvailable,
  CloudWorkspaceUnavailableError,
  readCloudWorkspaceState,
} from "../cloud-workspace-guard";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), kill: jest.fn() },
}));
jest.mock("../sandbox", () => ({
  ensureSandboxConnection: jest.fn(),
  E2BAcquisitionError: class E2BAcquisitionError extends Error {},
}));
jest.mock("../cloud-workspace-guard", () => ({
  ...jest.requireActual("../cloud-workspace-guard"),
  readCloudWorkspaceState: jest.fn(),
  assertCloudWorkspaceAvailable: jest.fn(),
  registerE2BWorkspaceLease: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));

const ensure = jest.mocked(ensureSandboxConnection);
const read = jest.mocked(readCloudWorkspaceState);
const available = jest.mocked(assertCloudWorkspaceAvailable);
const recovered = {
  version: 1 as const,
  phase: "e2b" as const,
  token: "owner",
  sourceId: "old-source",
  destinationId: "verified-destination",
  region: "us-east-1" as const,
};

describe("E2B cloud acquisition", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.E2B_EU_API_KEY;
    delete process.env.E2B_EU_DOMAIN;
    read.mockResolvedValue(null);
    available.mockResolvedValue(undefined);
    ensure.mockResolvedValue({ sandbox: { sandboxId: "new-e2b" } as Sandbox });
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it("reports a workspace lookup timeout and fences its late result", async () => {
    jest.useFakeTimers();
    let finish!: (value: null) => void;
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const setSandbox = jest.fn();
    try {
      const result = new CloudAcquisitionBudget()
        .run(
          (signal, reportStage) =>
            ensureCloudSandboxConnection({
              userId: "user-1",
              setSandbox,
              signal,
              reportStage,
            }),
          { userId: "user-1" },
        )
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({
        acquisitionStage: "workspace_lookup",
      });
      finish(null);
      await jest.advanceTimersByTimeAsync(1);
      expect(ensure).not.toHaveBeenCalled();
      expect(setSandbox).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("publishes only an authorized E2B result with one acquisition outcome", async () => {
    const setSandbox = jest.fn();
    const result = await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { triggerRegion: "us-east-1" },
    });
    expect(result.provider).toBe("e2b");
    expect(available).toHaveBeenCalledWith("user-1", "new-e2b");
    expect(setSandbox).toHaveBeenCalledWith(result.sandbox);
    expect(phLogger.event).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_completed",
      expect.objectContaining({
        sandbox_provider: "e2b",
        preferred_provider: "e2b",
        outcome: "success",
        fallback_used: false,
      }),
    );
  });

  it("reconnects the exact recovered destination rather than discovering its stale source", async () => {
    read.mockResolvedValue(recovered);
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox: jest.fn(),
      initialSandbox: { sandboxId: "old-source" } as Sandbox,
      context: { triggerRegion: "us-east-1" },
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ destinationId: "verified-destination" }),
    );
  });

  it("does not discover or create when persistent state needs recovery", async () => {
    read.mockRejectedValue(new CloudWorkspaceUnavailableError());
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(ensure).not.toHaveBeenCalled();
    expect(setSandbox).not.toHaveBeenCalled();
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it.each(["cleanup", "deleted"] as const)(
    "attributes a %s workspace rejection without logging the persisted record",
    async (phase) => {
      read.mockResolvedValue({
        version: 1,
        phase,
        token: "private-cleanup-token",
        migration: recovered,
      });
      const setSandbox = jest.fn();
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox,
          context: { chatId: "chat-1", triggerRunId: "run-1" },
        }),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
      expect(ensure).not.toHaveBeenCalled();
      expect(setSandbox).not.toHaveBeenCalled();
      expect(phLogger.event).toHaveBeenCalledWith(
        "cloud_sandbox_acquisition_failed",
        expect.objectContaining({
          userId: "user-1",
          chat_id: "chat-1",
          trigger_run_id: "run-1",
          workspace_guard_reason: "workspace_phase_unavailable",
          workspace_phase: phase,
        }),
      );
      expect(console.warn).toHaveBeenCalledWith(
        "Cloud sandbox acquisition completed",
        expect.objectContaining({
          outcome: "error",
          workspace_guard_reason: "workspace_phase_unavailable",
          workspace_phase: phase,
        }),
      );
      const logged = JSON.stringify([
        jest.mocked(phLogger.event).mock.calls,
        jest.mocked(console.warn).mock.calls,
      ]);
      for (const value of [
        "private-cleanup-token",
        recovered.token,
        recovered.sourceId,
        recovered.destinationId,
      ]) {
        expect(logged).not.toContain(value);
      }
    },
  );

  it.each([undefined, "eu-central-1"] as const)(
    "does not reconnect a pin through an unverified or different cluster: %s",
    async (region) => {
      read.mockResolvedValue(recovered);
      process.env.E2B_EU_API_KEY = "test-eu-key";
      process.env.E2B_EU_DOMAIN = "eu.example.test";
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox: jest.fn(),
          context: { triggerRegion: region },
        }),
      ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
      expect(ensure).not.toHaveBeenCalled();
      expect(phLogger.event).toHaveBeenCalledWith(
        "cloud_sandbox_acquisition_failed",
        expect.objectContaining({
          workspace_guard_reason: region
            ? "workspace_region_mismatch"
            : "trigger_region_missing",
          workspace_phase: "e2b",
          workspace_region: "us-east-1",
          trigger_region: region,
        }),
      );
    },
  );

  it("does not label different regions in the same E2B cluster as a mismatch", async () => {
    read.mockResolvedValue(recovered);
    const setSandbox = jest.fn();
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { triggerRegion: "us-west-2" },
    });
    expect(setSandbox).toHaveBeenCalledWith({ sandboxId: "new-e2b" });
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it("never publishes a result if cleanup takes ownership during acquisition", async () => {
    available.mockRejectedValue(new CloudWorkspaceUnavailableError());
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(setSandbox).not.toHaveBeenCalled();
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });

  it("fences late results after cancellation without publishing a connection", async () => {
    const controller = new AbortController();
    ensure.mockImplementation(async () => {
      controller.abort();
      return { sandbox: { sandboxId: "late-e2b" } as Sandbox };
    });
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(setSandbox).not.toHaveBeenCalled();
    expect(
      jest.mocked(phLogger.event).mock.calls.at(-1)?.[1],
    ).not.toHaveProperty("workspace_guard_reason");
  });
});
