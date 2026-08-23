const mockEnsureSandboxConnection = jest.fn();
const mockEvent = jest.fn();

jest.mock("../sandbox", () => ({
  ensureSandboxConnection: (...args: unknown[]) =>
    mockEnsureSandboxConnection(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: (...args: unknown[]) => mockEvent(...args) },
}));

import { ensureCloudSandboxConnection } from "../cloud-sandbox";

describe("cloud sandbox operational telemetry", () => {
  it("attributes acquisition failures without rollout properties", async () => {
    const failure = Object.assign(new Error("private target detail"), {
      name: "SandboxUnavailableError",
    });
    mockEnsureSandboxConnection.mockRejectedValueOnce(failure);

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-ultra",
        setSandbox: jest.fn(),
        context: {
          provider: "e2b",
          subscription: "ultra",
          chatId: "chat-1",
          triggerRunId: "run-1",
          runKind: "parent",
        },
      }),
    ).rejects.toBe(failure);

    expect(mockEnsureSandboxConnection).toHaveBeenCalledTimes(1);
    expect(mockEvent).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_failed",
      expect.objectContaining({
        userId: "user-ultra",
        chat_id: "chat-1",
        trigger_run_id: "run-1",
        provider: "e2b",
        cloud_sandbox_transport: "e2b_sdk",
        subscription_tier: "ultra",
        failure_stage: "ensure_cloud_sandbox",
        error_name: "SandboxUnavailableError",
        cloud_sandbox_acquisition_failed_event_version: 2,
      }),
    );
    expect(
      Object.keys(mockEvent.mock.calls[0][1]).some((key) =>
        key.startsWith("rollout_"),
      ),
    ).toBe(false);
    expect(JSON.stringify(mockEvent.mock.calls[0])).not.toContain(
      "private target detail",
    );
  });
});
