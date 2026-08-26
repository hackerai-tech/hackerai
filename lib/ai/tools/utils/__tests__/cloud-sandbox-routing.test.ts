const mockEnsureE2B = jest.fn();
const mockEnsureMiosa = jest.fn();
const mockTerminateMiosa = jest.fn();
const mockPostHogEvent = jest.fn();

jest.mock("../sandbox", () => ({
  ensureSandboxConnection: (...args: unknown[]) => mockEnsureE2B(...args),
}));

jest.mock("../miosa-sandbox", () => ({
  ensureMiosaSandboxConnection: (...args: unknown[]) =>
    mockEnsureMiosa(...args),
  terminateMiosaSandboxesForUser: (...args: unknown[]) =>
    mockTerminateMiosa(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: (...args: unknown[]) => mockPostHogEvent(...args) },
}));

import { ensureCloudSandboxConnection } from "../cloud-sandbox";

describe("cloud sandbox provider routing", () => {
  const setSandbox = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses MIOSA for treatment assignments", async () => {
    const sandbox = { sandboxKind: "miosa", sandboxId: "miosa-1" };
    mockEnsureMiosa.mockResolvedValue({ sandbox });

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: {
          provider: "miosa",
          selectionReason: "miosa_rollout",
          triggerRunId: "run-1",
        },
      }),
    ).resolves.toEqual({ sandbox, provider: "miosa" });

    expect(mockEnsureMiosa).toHaveBeenCalledTimes(1);
    expect(mockEnsureE2B).not.toHaveBeenCalled();
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "miosa_cloud_sandbox_rollout_exposed",
      expect.objectContaining({
        userId: "user-1",
        variant: "miosa",
        eventUuid: "run-1:miosa-cloud-sandbox-rollout-v1",
      }),
    );
  });

  it("falls back to E2B when MIOSA acquisition fails", async () => {
    const sandbox = { sandboxId: "e2b-1" };
    mockEnsureMiosa.mockRejectedValue(new Error("MIOSA unavailable"));
    mockEnsureE2B.mockResolvedValue({ sandbox });

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: {
          provider: "miosa",
          selectionReason: "miosa_rollout",
          triggerRunId: "run-1",
        },
      }),
    ).resolves.toEqual({ sandbox, provider: "e2b" });

    expect(mockEnsureMiosa).toHaveBeenCalledTimes(1);
    expect(mockEnsureE2B).toHaveBeenCalledTimes(1);
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "cloud_sandbox_provider_fallback",
      expect.objectContaining({
        from_provider: "miosa",
        to_provider: "e2b",
        error_name: "Error",
      }),
    );
  });

  it("does not call MIOSA for the E2B control", async () => {
    const sandbox = { sandboxId: "e2b-1" };
    mockEnsureE2B.mockResolvedValue({ sandbox });

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: {
          provider: "e2b",
          selectionReason: "miosa_rollout_control",
        },
      }),
    ).resolves.toEqual({ sandbox, provider: "e2b" });

    expect(mockEnsureMiosa).not.toHaveBeenCalled();
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "miosa_cloud_sandbox_rollout_exposed",
      expect.objectContaining({ variant: "e2b" }),
    );
  });
});
