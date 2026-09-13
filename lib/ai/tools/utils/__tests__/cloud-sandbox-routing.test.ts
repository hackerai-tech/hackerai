const mockEnsureE2B = jest.fn();
const mockEnsureMiosa = jest.fn();
const mockTerminateMiosa = jest.fn();
const mockPostHogEvent = jest.fn();

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), kill: jest.fn() },
}));

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
import { MiosaEnrollmentError } from "../miosa-enrollment";
import { createMiosaAcquisitionDiagnostics } from "../miosa-acquisition-diagnostics";

describe("cloud sandbox provider routing", () => {
  const setSandbox = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["production", undefined, 0],
    ["production", "true", 1],
    ["preview", undefined, 1],
  ])(
    "gates successful console diagnostics in %s with debug=%s",
    async (environment, debug, expected) => {
      const oldEnvironment = process.env.VERCEL_ENV;
      const oldDebug = process.env.MIOSA_DEBUG_LOGS;
      process.env.VERCEL_ENV = environment;
      if (debug) process.env.MIOSA_DEBUG_LOGS = debug;
      else delete process.env.MIOSA_DEBUG_LOGS;
      const info = jest.spyOn(console, "info").mockImplementation(() => {});
      const debugLog = jest
        .spyOn(console, "debug")
        .mockImplementation(() => {});
      mockEnsureMiosa.mockImplementationOnce(async (_context, options) => {
        const step = createMiosaAcquisitionDiagnostics({
          templateId: "hackerai-tools",
          workspaceName: "private-user",
          onDiagnostic: options.onDiagnostic,
        });
        await step("readiness", async () => undefined);
        return { sandbox: { sandboxKind: "miosa", sandboxId: "miosa-1" } };
      });
      try {
        await ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox,
          context: { provider: "miosa" },
        });
        expect(
          info.mock.calls.filter(
            ([message]) => message === "MIOSA sandbox acquisition step",
          ),
        ).toHaveLength(0);
        expect(debugLog).toHaveBeenCalledTimes(expected);
        expect(mockPostHogEvent).toHaveBeenCalledWith(
          "miosa_sandbox_acquisition_step",
          expect.objectContaining({ outcome: "success" }),
        );
        expect(mockPostHogEvent).toHaveBeenCalledWith(
          "cloud_sandbox_acquisition_completed",
          expect.objectContaining({ outcome: "success" }),
        );
      } finally {
        if (oldEnvironment === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = oldEnvironment;
        if (oldDebug === undefined) delete process.env.MIOSA_DEBUG_LOGS;
        else process.env.MIOSA_DEBUG_LOGS = oldDebug;
        info.mockRestore();
        debugLog.mockRestore();
      }
    },
  );

  it("measures the complete fallback wait without attributing it to an E2B assignment", async () => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
    const onBoot = jest.fn();
    mockEnsureMiosa.mockImplementationOnce(async () => {
      clock.mockReturnValue(4000);
      throw new Error("unavailable");
    });
    mockEnsureE2B.mockImplementationOnce(async (context) => {
      clock.mockReturnValue(4500);
      context.onBoot({
        path: "create_fresh",
        duration_ms: 500,
        create_attempts: 1,
      });
      return { sandbox: { sandboxId: "e2b-1" } };
    });
    try {
      await ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        onBoot,
        context: {
          provider: "miosa",
          selectionReason: "miosa_rollout",
          triggerRunId: "run-1",
          subscription: "pro",
          triggerRegion: "us-east-1",
        },
      });
      const outcomes = mockPostHogEvent.mock.calls.filter(
        ([event]) => event === "cloud_sandbox_acquisition_completed",
      );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0][1]).toEqual(
        expect.objectContaining({
          trigger_run_id: "run-1",
          preferred_provider: "miosa",
          sandbox_provider: "e2b",
          outcome: "success",
          fallback_used: true,
          duration_ms: 3500,
          sandbox_boot_path: "create_fresh",
          trigger_region: "us-east-1",
        }),
      );
      expect(onBoot).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("records an enrollment veto separately from an infrastructure fallback", async () => {
    mockEnsureMiosa.mockRejectedValueOnce(
      new MiosaEnrollmentError("existing_e2b_workspace"),
    );
    mockEnsureE2B.mockResolvedValueOnce({ sandbox: { sandboxId: "e2b-1" } });
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { provider: "miosa" },
    });
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_completed",
      expect.objectContaining({
        outcome: "success",
        fallback_used: false,
        enrollment_denied_reason: "existing_e2b_workspace",
      }),
    );
  });

  it("includes total acquisition failure in the denominator without logging raw errors", async () => {
    mockEnsureMiosa.mockRejectedValueOnce(new Error("private response"));
    mockEnsureE2B.mockRejectedValueOnce(new Error("private response"));
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: { provider: "miosa" },
      }),
    ).rejects.toThrow();
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_completed",
      expect.objectContaining({
        outcome: "error",
        fallback_used: true,
        preferred_provider: "miosa",
        sandbox_provider: "e2b",
      }),
    );
    expect(JSON.stringify(mockPostHogEvent.mock.calls)).not.toContain(
      "private response",
    );
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
      "cloud_sandbox_acquisition_failed",
      expect.objectContaining({
        provider: "miosa",
        sandbox_type: "cloud",
        sandbox_provider: "miosa",
        cloud_sandbox_acquisition_failed_event_version: 5,
      }),
    );
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "cloud_sandbox_provider_fallback",
      expect.objectContaining({
        from_provider: "miosa",
        to_provider: "e2b",
        sandbox_type: "cloud",
        sandbox_provider: "e2b",
        error_name: "Error",
        cloud_sandbox_provider_fallback_event_version: 3,
      }),
    );
  });

  it("excludes secret-like Miosa error names from all fallback telemetry", async () => {
    const error = Object.assign(new Error("private response body"), {
      name: "msk_private_canary",
    });
    mockEnsureMiosa.mockRejectedValueOnce(error);
    mockEnsureE2B.mockResolvedValueOnce({ sandbox: { sandboxId: "e2b-1" } });

    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: { provider: "miosa" },
      }),
    ).resolves.toMatchObject({ provider: "e2b" });

    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "cloud_sandbox_provider_fallback",
      expect.objectContaining({ error_name: "UnknownError" }),
    );
    expect(JSON.stringify(mockPostHogEvent.mock.calls)).not.toMatch(
      /msk_private_canary|private response body/,
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

  it.each(["parent", "subagent"] as const)(
    "correlates safe %s step failures in Trigger and PostHog while retaining E2B fallback",
    async (runKind) => {
      const consoleInfo = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const error = Object.assign(new Error("msk_private raw response body"), {
        name: "ValidationError",
        status: 422,
        code: "INVALID_ARGUMENT",
        requestId: "request-123",
        retryable: false,
      });
      mockEnsureMiosa.mockImplementationOnce(async (_context, options) => {
        const step = createMiosaAcquisitionDiagnostics({
          templateId: "hackerai-tools",
          workspaceName: "private-user",
          onDiagnostic: options.onDiagnostic,
        });
        await step("get_or_create", async () => {
          throw error;
        });
      });
      mockEnsureE2B.mockResolvedValueOnce({ sandbox: { sandboxId: "e2b-1" } });
      try {
        await expect(
          ensureCloudSandboxConnection({
            userId: "user-1",
            setSandbox,
            context: {
              provider: "miosa",
              chatId: "chat-1",
              triggerRunId: "run-1",
              runKind,
            },
          }),
        ).resolves.toMatchObject({ provider: "e2b" });
        const expected = expect.objectContaining({
          stage: "get_or_create",
          outcome: "failure",
          chat_id: "chat-1",
          trigger_run_id: "run-1",
          agent_run_kind: runKind,
          error_http_status: 422,
          error_code: "INVALID_ARGUMENT",
          error_request_id: "request-123",
        });
        expect(consoleInfo).toHaveBeenCalledWith(
          "MIOSA sandbox acquisition step",
          expected,
        );
        expect(mockPostHogEvent).toHaveBeenCalledWith(
          "miosa_sandbox_acquisition_step",
          expected,
        );
        expect(mockPostHogEvent).toHaveBeenCalledWith(
          "cloud_sandbox_acquisition_failed",
          expect.objectContaining({
            error_code: "INVALID_ARGUMENT",
            error_request_id: "request-123",
          }),
        );
        expect(
          JSON.stringify([consoleInfo.mock.calls, mockPostHogEvent.mock.calls]),
        ).not.toMatch(/msk_private|raw response body|private-user/);
      } finally {
        consoleInfo.mockRestore();
      }
    },
  );

  it.each([
    "not_pro",
    "existing_e2b_workspace",
    "workspace_discovery_unavailable",
  ] as const)(
    "keeps %s enrollment on E2B without recording Miosa exposure or failure",
    async (reason) => {
      const sandbox = { sandboxId: "e2b-1" };
      mockEnsureMiosa.mockRejectedValueOnce(new MiosaEnrollmentError(reason));
      mockEnsureE2B.mockResolvedValue({ sandbox });
      await expect(
        ensureCloudSandboxConnection({
          userId: "user-1",
          setSandbox,
          context: {
            provider: "miosa",
            subscription: "pro",
            selectionReason: "miosa_rollout",
          },
        }),
      ).resolves.toEqual({ sandbox, provider: "e2b" });
      expect(mockPostHogEvent.mock.calls.map(([event]) => event)).toEqual([
        "miosa_cloud_sandbox_enrollment_denied",
        "cloud_sandbox_acquisition_completed",
      ]);
      expect(mockPostHogEvent).toHaveBeenCalledWith(
        "miosa_cloud_sandbox_enrollment_denied",
        expect.objectContaining({ reason }),
      );
    },
  );

  it("records safe discovery diagnostics separately from Miosa acquisition failures", async () => {
    mockEnsureMiosa.mockRejectedValueOnce(
      new MiosaEnrollmentError("workspace_discovery_unavailable", {
        cluster: "eu",
        kind: "authentication",
        httpStatus: 403,
        elapsedMs: 123,
      }),
    );
    mockEnsureE2B.mockResolvedValue({ sandbox: { sandboxId: "e2b-1" } });
    await ensureCloudSandboxConnection({
      userId: "user-1",
      setSandbox,
      context: { provider: "miosa" },
    });
    expect(mockPostHogEvent).toHaveBeenCalledTimes(2);
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "miosa_cloud_sandbox_enrollment_denied",
      expect.objectContaining({
        discovery_cluster: "eu",
        discovery_failure_kind: "authentication",
        discovery_http_status: 403,
        discovery_elapsed_ms: 123,
        miosa_cloud_sandbox_enrollment_denied_event_version: 2,
      }),
    );
  });

  it("preserves an already connected E2B workspace even when treatment is selected", async () => {
    const sandbox = { sandboxId: "e2b-1" };
    mockEnsureE2B.mockResolvedValue({ sandbox });
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        initialSandbox: sandbox as never,
        context: { provider: "miosa", subscription: "pro" },
      }),
    ).resolves.toEqual({ sandbox, provider: "e2b" });
    expect(mockEnsureMiosa).not.toHaveBeenCalled();
    expect(mockEnsureE2B).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initialSandbox: sandbox }),
    );
  });

  it("still records E2B acquisition failure after enrollment is denied", async () => {
    mockEnsureMiosa.mockRejectedValueOnce(new MiosaEnrollmentError("not_pro"));
    mockEnsureE2B.mockRejectedValueOnce(new Error("E2B failed"));
    await expect(
      ensureCloudSandboxConnection({
        userId: "user-1",
        setSandbox,
        context: { provider: "miosa" },
      }),
    ).rejects.toThrow("E2B failed");
    expect(mockPostHogEvent).toHaveBeenCalledWith(
      "cloud_sandbox_acquisition_failed",
      expect.objectContaining({ provider: "e2b" }),
    );
  });
});
