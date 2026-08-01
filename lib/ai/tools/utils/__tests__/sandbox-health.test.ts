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

import type { AnySandbox } from "@/types";
import {
  classifySandboxReadinessFailureReason,
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

  test("reports final readiness failures with the latest resource metrics", async () => {
    const sandbox = makeE2BSandbox();
    (sandbox.commands.run as jest.Mock).mockRejectedValue(
      new Error("envd unresponsive"),
    );
    const onResourceMetrics = jest.fn();

    await expect(
      waitForSandboxReady(sandbox, 1, undefined, onResourceMetrics),
    ).rejects.toThrow("Sandbox running but not ready");

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
