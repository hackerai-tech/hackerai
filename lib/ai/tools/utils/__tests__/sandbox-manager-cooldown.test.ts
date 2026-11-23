jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));
jest.mock("../cloud-sandbox", () => ({
  ensureCloudSandboxConnection: jest.fn(),
}));
jest.mock("../cloud-workspace-guard", () => ({
  CloudWorkspaceUnavailableError: class extends Error {},
  assertCloudWorkspaceAvailable: jest.fn(async () => {}),
  registerE2BWorkspaceLease: jest.fn(),
}));
jest.mock("../sandbox", () => ({
  refreshE2BSandboxLeaseBestEffort: jest.fn(async () => {}),
}));

import type { Sandbox } from "@e2b/code-interpreter";
import { ensureCloudSandboxConnection } from "../cloud-sandbox";
import { assertCloudWorkspaceAvailable } from "../cloud-workspace-guard";
import { DefaultSandboxManager } from "../sandbox-manager";

const sandbox = (id: string) => ({ sandboxId: id }) as unknown as Sandbox;

describe("DefaultSandboxManager readiness cooldown", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("blocks the unready client during cooldown, then reconnects on the next call", async () => {
    const reconnected = sandbox("sandbox-1");
    jest
      .mocked(ensureCloudSandboxConnection)
      .mockResolvedValue({ sandbox: reconnected, provider: "e2b" });
    const manager = new DefaultSandboxManager(
      "user-1",
      jest.fn(),
      sandbox("sandbox-1"),
    );

    // The initial readiness check and its reconnect both failed.
    expect(manager.recordHealthFailure()).toBe(false);
    expect(manager.recordHealthFailure()).toBe(true);
    expect(manager.isSandboxUnavailable()).toBe(true);
    expect(manager.getSandboxUnavailableMessage()).toContain(
      "after about 60 seconds",
    );
    await expect(manager.getSandbox()).rejects.toThrow(
      "temporarily unavailable",
    );
    expect(ensureCloudSandboxConnection).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(manager.isSandboxUnavailable()).toBe(false);
    await expect(manager.getSandbox()).resolves.toEqual({
      sandbox: reconnected,
    });
    // The re-probe reconnects instead of reusing the client that failed.
    expect(ensureCloudSandboxConnection).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(ensureCloudSandboxConnection).mock.calls[0][0].initialSandbox,
    ).toBeNull();
    expect(manager.getSandboxUnavailableMessage()).toBeUndefined();
  });
  it("rejects a cached call whose checks finish after a concurrent cooldown starts", async () => {
    let releaseCheck!: () => void;
    jest
      .mocked(assertCloudWorkspaceAvailable)
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseCheck = resolve)),
      );
    const manager = new DefaultSandboxManager(
      "user-1",
      jest.fn(),
      sandbox("sandbox-1"),
    );

    const pending = manager.getSandbox();
    // A concurrent readiness failure starts a cooldown during the await.
    manager.recordHealthFailure();
    manager.recordHealthFailure();
    releaseCheck();

    await expect(pending).rejects.toThrow("temporarily unavailable");
  });
});
