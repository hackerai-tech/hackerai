jest.mock("@e2b/code-interpreter", () => {
  class MockE2BError extends Error {}
  return {
    AuthenticationError: MockE2BError,
    CommandExitError: MockE2BError,
    InvalidArgumentError: MockE2BError,
    NotEnoughSpaceError: MockE2BError,
    NotFoundError: MockE2BError,
    RateLimitError: MockE2BError,
    SandboxError: MockE2BError,
    TemplateError: MockE2BError,
    TimeoutError: MockE2BError,
  };
});

jest.mock("@/lib/posthog/worker", () => ({
  createRetryLogger: () => jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));

import type { AnySandbox } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { createE2BResourcePressureObserver } from "@/lib/analytics/sandbox-resource-pressure";
import {
  classifySandboxReadinessFailureReason,
  observeSandboxResourceFailure,
  waitForSandboxReady,
} from "../sandbox-health";

const makeE2BSandbox = () =>
  ({
    isRunning: jest.fn(async () => true),
    getMetrics: jest.fn(async () => [
      {
        cpuUsedPct: 100,
        memUsed: 768,
        memTotal: 1024,
        diskUsed: 250,
        diskTotal: 1000,
      },
    ]),
    commands: {
      run: jest.fn(async () => ({
        stdout: "ready\n",
        stderr: "",
        exitCode: 0,
      })),
    },
  }) as unknown as AnySandbox;

describe("sandbox health resource observations", () => {
  test.each(["health", "failure"] as const)(
    "preserves provider sample age through the %s path into existing telemetry",
    async (path) => {
      const sandbox = makeE2BSandbox();
      const now = Date.now();
      const clock = jest.spyOn(Date, "now").mockReturnValue(now);
      const metrics = await sandbox.getMetrics();
      (sandbox.getMetrics as jest.Mock).mockResolvedValue([
        { ...metrics[0], timestamp: new Date(now - 120_000) },
      ]);
      const observer = createE2BResourcePressureObserver({
        userId: "user-1",
        chatId: "chat-1",
        mode: "agent",
      });

      try {
        if (path === "health") {
          await waitForSandboxReady(sandbox, 1, undefined, observer);
        } else {
          await observeSandboxResourceFailure(
            sandbox,
            observer,
            "terminal_command_timeout",
            "terminal_command_timed_out",
          );
        }
        expect(phLogger.event).toHaveBeenLastCalledWith(
          path === "health"
            ? "e2b_sandbox_resource_pressure_observed"
            : "e2b_sandbox_resource_failure_observed",
          expect.objectContaining({
            metrics_sample_age_available: true,
            metrics_sample_age_ms: 120_000,
          }),
        );
        // One fixture read and one existing health/failure sample, no extra probe.
        expect(sandbox.getMetrics).toHaveBeenCalledTimes(2);
        expect(sandbox.getMetrics).toHaveBeenLastCalledWith({
          start: new Date(now - 5 * 60_000),
          end: new Date(now),
        });
      } finally {
        clock.mockRestore();
      }
    },
  );

  test.each([
    ["future", (now: number) => new Date(now + 5_000), -5_000],
    ["missing", () => undefined, undefined],
    ["invalid", () => new Date(NaN), undefined],
    ["wrong type", () => "2026-11-08T00:00:00Z", undefined],
  ])(
    "handles %s sample timestamps without reporting false freshness",
    async (_label, timestamp, age) => {
      const sandbox = makeE2BSandbox();
      const now = Date.now();
      const clock = jest.spyOn(Date, "now").mockReturnValue(now);
      const metrics = await sandbox.getMetrics();
      (sandbox.getMetrics as jest.Mock).mockResolvedValue([
        { ...metrics[0], timestamp: timestamp(now) },
      ]);
      const observer = createE2BResourcePressureObserver({
        userId: "user-1",
        chatId: "chat-1",
        mode: "agent",
      });
      try {
        await waitForSandboxReady(sandbox, 1, undefined, observer);
        const properties = (phLogger.event as jest.Mock).mock.calls.at(-1)[1];
        expect(properties.metrics_sample_age_available).toBe(age !== undefined);
        if (age === undefined) {
          expect(properties).not.toHaveProperty("metrics_sample_age_ms");
        } else {
          expect(properties.metrics_sample_age_ms).toBe(age);
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  test("reports metrics already fetched by the pre-command health check", async () => {
    const sandbox = makeE2BSandbox();
    const onResourceMetrics = jest.fn();

    await waitForSandboxReady(sandbox, 1, undefined, onResourceMetrics);

    expect(onResourceMetrics).toHaveBeenCalledWith({
      kind: "health_sample",
      source: "pre_command_health_check",
      metrics: {
        cpuPct: 100,
        memPct: 75,
        diskPct: 25,
      },
    });
  });

  test("lets the readiness command auto-resume a paused sandbox", async () => {
    const sandbox = makeE2BSandbox();
    (sandbox.isRunning as jest.Mock).mockResolvedValue(false);
    const onResourceMetrics = jest.fn();

    await expect(
      waitForSandboxReady(sandbox, 1, undefined, onResourceMetrics),
    ).resolves.toBeUndefined();

    expect(sandbox.commands.run).toHaveBeenCalledWith("echo ready", {
      timeoutMs: 5000,
      displayName: "",
    });
    expect(sandbox.getMetrics).toHaveBeenCalledTimes(1);
    expect(onResourceMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "health_sample" }),
    );
  });

  test("uses the command as authoritative when the status probe fails", async () => {
    const sandbox = makeE2BSandbox();
    (sandbox.isRunning as jest.Mock).mockRejectedValue(
      new Error("temporary status failure"),
    );

    await expect(waitForSandboxReady(sandbox, 1)).resolves.toBeUndefined();

    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  });

  test("reports final readiness failures with the latest resource metrics", async () => {
    const sandbox = makeE2BSandbox();
    (sandbox.commands.run as jest.Mock).mockRejectedValue(
      new Error("envd unresponsive"),
    );
    const onResourceMetrics = jest.fn();

    await expect(
      waitForSandboxReady(sandbox, 1, undefined, onResourceMetrics),
    ).rejects.toThrow("Sandbox not ready");

    expect(onResourceMetrics).toHaveBeenLastCalledWith({
      kind: "failure",
      source: "readiness_check_failure",
      failureType: "readiness_check_failed",
      failureReason: "unknown",
      readinessStage: "initial",
      lifecycleState: "unknown",
      metrics: {
        cpuPct: 100,
        memPct: 75,
        diskPct: 25,
      },
    });
  });

  test("does not let an analytics observer break sandbox execution", async () => {
    const sandbox = makeE2BSandbox();

    await expect(
      waitForSandboxReady(sandbox, 1, undefined, () => {
        throw new Error("analytics unavailable");
      }),
    ).resolves.toBeUndefined();
  });

  test.each([
    [
      Object.assign(new Error("fork/exec /bin/sh: permission denied"), {
        name: "InvalidArgumentError",
      }),
      "permission_denied",
    ],
    [
      Object.assign(new Error("Sandbox is probably not running anymore"), {
        name: "SandboxNotFoundError",
      }),
      "sandbox_not_found",
    ],
    [new Error("fetch failed: ECONNRESET"), "connection_error"],
    [new Error("operation timed out"), "operation_timeout"],
    [
      new Error(
        "Failed creating persistent sandbox: The operation was aborted due to timeout",
      ),
      "operation_timeout",
    ],
    [new Error("500: Failed to place sandbox"), "placement_failure"],
  ])(
    "classifies readiness failures without exposing raw errors",
    (error, expected) => {
      expect(classifySandboxReadinessFailureReason(error)).toBe(expected);
    },
  );

  test("labels failures from the reconnect health-check stage", async () => {
    const sandbox = makeE2BSandbox();
    (sandbox.commands.run as jest.Mock).mockRejectedValue(
      new Error("fetch failed: connection reset"),
    );
    const onResourceMetrics = jest.fn();

    await expect(
      waitForSandboxReady(
        sandbox,
        1,
        undefined,
        onResourceMetrics,
        "reconnect",
      ),
    ).rejects.toThrow();

    expect(onResourceMetrics).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "failure",
        failureReason: "connection_error",
        readinessStage: "reconnect",
        lifecycleState: "unknown",
      }),
    );
  });
});
