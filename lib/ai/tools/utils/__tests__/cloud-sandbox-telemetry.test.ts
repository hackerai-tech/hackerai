const mockEnsureSandboxConnection = jest.fn();
const mockEnsureAwsLambdaMicrovmConnection = jest.fn();
const mockRecordAwsSandboxAcquisitionFailure = jest.fn();
const mockRecordAwsSandboxHalfOpenSuccess = jest.fn();
const mockEvent = jest.fn();

jest.mock("../sandbox", () => ({
  ensureSandboxConnection: (...args: unknown[]) =>
    mockEnsureSandboxConnection(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: (...args: unknown[]) => mockEvent(...args) },
}));

jest.mock("../aws-lambda-microvm", () => ({
  ensureAwsLambdaMicrovmConnection: (...args: unknown[]) =>
    mockEnsureAwsLambdaMicrovmConnection(...args),
}));

jest.mock("../cloud-sandbox-provider-circuit", () => ({
  recordAwsSandboxAcquisitionFailure: (...args: unknown[]) =>
    mockRecordAwsSandboxAcquisitionFailure(...args),
  recordAwsSandboxHalfOpenSuccess: (...args: unknown[]) =>
    mockRecordAwsSandboxHalfOpenSuccess(...args),
}));

import { ensureCloudSandboxConnection } from "../cloud-sandbox";

describe("cloud sandbox operational telemetry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordAwsSandboxAcquisitionFailure.mockResolvedValue({ opened: false });
    mockRecordAwsSandboxHalfOpenSuccess.mockResolvedValue(undefined);
  });

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

  it("records only final AWS acquisition failures in the provider circuit", async () => {
    const failure = Object.assign(new Error("denied"), {
      name: "AccessDeniedException",
    });
    mockEnsureAwsLambdaMicrovmConnection.mockRejectedValueOnce(failure);

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-ultra",
        setSandbox: jest.fn(),
        context: {
          provider: "aws-lambda-microvm",
          providerSelectionReason: "primary_aws",
          triggerRunId: "run-aws",
        },
      }),
    ).rejects.toBe(failure);

    expect(mockRecordAwsSandboxAcquisitionFailure).toHaveBeenCalledWith(
      failure,
      {
        requestId: "run-aws",
        source: "sandbox_acquisition",
        halfOpenProbe: false,
      },
    );
    expect(mockRecordAwsSandboxHalfOpenSuccess).not.toHaveBeenCalled();
  });

  it("falls back to E2B within the same request after a classified AWS quota failure", async () => {
    const failure = Object.assign(new Error("account memory quota reached"), {
      name: "ServiceQuotaExceededException",
    });
    const e2bSandbox = { sandboxId: "e2b-fallback" };
    mockEnsureAwsLambdaMicrovmConnection.mockRejectedValueOnce(failure);
    mockRecordAwsSandboxAcquisitionFailure.mockResolvedValueOnce({
      opened: false,
      failureClass: "provider_unavailable",
    });
    mockEnsureSandboxConnection.mockResolvedValueOnce({
      sandbox: e2bSandbox,
    });

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-pro",
        setSandbox: jest.fn(),
        context: {
          provider: "aws-lambda-microvm",
          providerSelectionReason: "primary_aws",
          subscription: "pro",
          chatId: "chat-quota",
          triggerRunId: "run-quota",
          runKind: "parent",
          triggerRegion: "eu-central-1",
        },
      }),
    ).resolves.toEqual({ sandbox: e2bSandbox });

    expect(mockEnsureSandboxConnection).toHaveBeenCalledTimes(1);
    expect(mockEvent).toHaveBeenCalledWith(
      "cloud_sandbox_provider_fallback_succeeded",
      expect.objectContaining({
        userId: "user-pro",
        provider: "aws-lambda-microvm",
        fallback_provider: "e2b",
        failure_class: "provider_unavailable",
        trigger_region: "eu-central-1",
      }),
    );
  });

  it("closes a half-open circuit only after AWS acquisition succeeds", async () => {
    const sandbox = { getConnectionId: () => "microvm-1" };
    mockEnsureAwsLambdaMicrovmConnection.mockResolvedValueOnce(sandbox);
    const setSandbox = jest.fn();

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-ultra",
        setSandbox,
        context: {
          provider: "aws-lambda-microvm",
          providerSelectionReason: "circuit_half_open_probe",
          triggerRunId: "run-probe",
        },
      }),
    ).resolves.toEqual({ sandbox });

    expect(mockRecordAwsSandboxHalfOpenSuccess).toHaveBeenCalledWith({
      requestId: "run-probe",
    });
    expect(setSandbox).toHaveBeenCalledWith(sandbox);
    expect(mockRecordAwsSandboxAcquisitionFailure).not.toHaveBeenCalled();
  });
});
