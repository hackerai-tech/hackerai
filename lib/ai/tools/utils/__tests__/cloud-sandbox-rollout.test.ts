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

describe("cloud sandbox rollout telemetry", () => {
  const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CLOUD_SANDBOX_PROVIDER = "aws-lambda-microvm";
  });

  afterAll(() => {
    if (originalProvider === undefined) {
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    } else {
      process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    }
  });

  it("attributes acquisition failures under the explicit E2B rollback", async () => {
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
          rollout: {
            provider: "e2b",
            eligible: false,
            variant: "e2b",
            reason: "provider_disabled",
          },
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
        rollout_eligible: false,
        rollout_variant: "e2b",
        rollout_reason: "provider_disabled",
        failure_stage: "ensure_cloud_sandbox",
        error_name: "SandboxUnavailableError",
        cloud_sandbox_acquisition_failed_event_version: 2,
      }),
    );
    expect(JSON.stringify(mockEvent.mock.calls[0])).not.toContain(
      "private target detail",
    );
  });
});
