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
  });

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
    },
  );

  it("never publishes a result if cleanup takes ownership during acquisition", async () => {
    available.mockRejectedValue(new CloudWorkspaceUnavailableError());
    const setSandbox = jest.fn();
    await expect(
      ensureCloudSandboxConnection({ userId: "user-1", setSandbox }),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expect(setSandbox).not.toHaveBeenCalled();
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
  });
});
