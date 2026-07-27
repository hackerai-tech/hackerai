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
import { waitForSandboxReady } from "../sandbox-health";

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
      cpuPct: 100,
      memPct: 75,
      diskPct: 25,
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
});
