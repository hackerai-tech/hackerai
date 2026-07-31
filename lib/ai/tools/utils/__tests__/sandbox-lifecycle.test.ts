jest.mock("@e2b/code-interpreter", () => {
  class E2BError extends Error {}
  return {
    Sandbox: class {
      static list = jest.fn();
      static connect = jest.fn();
      static create = jest.fn();
      static kill = jest.fn();
    },
    SandboxError: E2BError,
    TimeoutError: class extends E2BError {},
    NotFoundError: class extends E2BError {},
    AuthenticationError: class extends E2BError {},
    NotEnoughSpaceError: class extends E2BError {},
    RateLimitError: class extends E2BError {},
    TemplateError: class extends E2BError {},
    InvalidArgumentError: class extends E2BError {},
    CommandExitError: class extends E2BError {},
  };
});

import { Sandbox } from "@e2b/code-interpreter";
import {
  BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
  E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
  E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
  ensureSandboxConnection,
  refreshE2BSandboxLease,
  withE2BSandboxLeaseHeartbeat,
} from "../sandbox";
import { DefaultSandboxManager } from "../sandbox-manager";

type MockSandboxApi = {
  list: jest.Mock;
  connect: jest.Mock;
  create: jest.Mock;
  kill: jest.Mock;
};

const sandboxApi = Sandbox as unknown as MockSandboxApi;

const listSandbox = (
  overrides: Partial<{
    sandboxId: string;
    state: "running" | "paused";
    metadata: Record<string, string>;
  }> = {},
) => {
  sandboxApi.list.mockReturnValue({
    nextItems: jest.fn(async () => [
      {
        sandboxId: "sandbox-1",
        state: "running",
        metadata: { sandboxVersion: "v11" },
        ...overrides,
      },
    ]),
  });
};

describe("E2B sandbox lease lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("always refreshes the same fixed cloud lease", async () => {
    const setTimeout = jest.fn(async () => undefined);
    const sandbox = { setTimeout } as unknown as Sandbox;

    const timeoutMs = await refreshE2BSandboxLease(sandbox);

    expect(timeoutMs).toBe(BASH_SANDBOX_AUTOPAUSE_TIMEOUT);
    expect(setTimeout).toHaveBeenCalledWith(BASH_SANDBOX_AUTOPAUSE_TIMEOUT, {
      requestTimeoutMs: E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
    });
  });

  it("renews after one minute without duplicating acquisition and stops afterward", async () => {
    jest.useFakeTimers();
    const setTimeout = jest.fn(async () => undefined);
    const sandbox = {
      sandboxId: "sandbox-1",
      setTimeout,
    } as unknown as Sandbox;
    let finishOperation!: (value: string) => void;
    const operation = new Promise<string>((resolve) => {
      finishOperation = resolve;
    });

    const result = withE2BSandboxLeaseHeartbeat(sandbox, () => operation);
    await jest.advanceTimersByTimeAsync(0);
    expect(setTimeout).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS * 2,
    );
    expect(setTimeout).toHaveBeenCalledTimes(2);
    expect(setTimeout).toHaveBeenLastCalledWith(
      BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
      {
        requestTimeoutMs: E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
      },
    );

    finishOperation("done");
    await expect(result).resolves.toBe("done");
    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
    );
    expect(setTimeout).toHaveBeenCalledTimes(2);
  });

  it("keeps foreground work running when a heartbeat refresh transiently fails", async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sandbox = {
        sandboxId: "sandbox-1",
        setTimeout: jest.fn(async () => {
          throw new Error("temporary refresh failure");
        }),
      } as unknown as Sandbox;
      let finishOperation!: () => void;
      const operation = jest.fn(
        () =>
          new Promise<string>((resolve) => {
            finishOperation = () => resolve("done");
          }),
      );

      const result = withE2BSandboxLeaseHeartbeat(sandbox, operation);
      expect(operation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(
        E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("e2b_sandbox_lease_refresh_failed"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"source":"foreground_heartbeat"'),
      );
      finishOperation();
      await expect(result).resolves.toBe("done");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps a shared remote lease alive across independent worker clients", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    let remoteExpiryMs = 0;
    const createWorkerClient = (sandboxId: string) =>
      ({
        sandboxId,
        setTimeout: jest.fn(async (timeoutMs: number) => {
          remoteExpiryMs = Date.now() + timeoutMs;
        }),
      }) as unknown as Sandbox;
    const firstWorker = createWorkerClient("sandbox-1");
    const secondWorker = createWorkerClient("sandbox-1");
    let finishFirst!: () => void;
    let finishSecond!: () => void;

    const firstRun = withE2BSandboxLeaseHeartbeat(
      firstWorker,
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS / 2,
    );
    const secondRun = withE2BSandboxLeaseHeartbeat(
      secondWorker,
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        }),
    );

    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS * 2,
    );
    expect(remoteExpiryMs).toBeGreaterThanOrEqual(
      Date.now() + BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    );
    expect(
      (firstWorker.setTimeout as jest.Mock).mock.calls.every(
        ([timeoutMs]) => timeoutMs === BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
      ),
    ).toBe(true);
    expect(
      (secondWorker.setTimeout as jest.Mock).mock.calls.every(
        ([timeoutMs]) => timeoutMs === BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
      ),
    ).toBe(true);

    finishFirst();
    finishSecond();
    await Promise.all([firstRun, secondRun]);
  });

  it("uses the renewable cloud lease when reconnecting a paused sandbox", async () => {
    const connectedSandbox = { sandboxId: "sandbox-1" } as unknown as Sandbox;
    listSandbox({ state: "paused" });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);
    const setSandbox = jest.fn();

    const result = await ensureSandboxConnection({
      userID: "user-1",
      setSandbox,
    });

    expect(result.sandbox).toBe(connectedSandbox);
    expect(sandboxApi.connect).toHaveBeenCalledWith("sandbox-1", {
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    });
    expect(setSandbox).toHaveBeenCalledWith(connectedSandbox);
  });

  it("defers version replacement while the shared sandbox is running", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const connectedSandbox = {
        sandboxId: "sandbox-1",
      } as unknown as Sandbox;
      listSandbox({
        state: "running",
        metadata: { sandboxVersion: "v10" },
      });
      sandboxApi.connect.mockResolvedValue(connectedSandbox);

      const result = await ensureSandboxConnection({
        userID: "user-1",
        setSandbox: jest.fn(),
      });

      expect(result.sandbox).toBe(connectedSandbox);
      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("e2b_sandbox_version_migration_deferred"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("replaces a mismatched sandbox only after it is paused", async () => {
    const createdSandbox = { sandboxId: "sandbox-2" } as unknown as Sandbox;
    listSandbox({
      state: "paused",
      metadata: { sandboxVersion: "v10" },
    });
    sandboxApi.kill.mockResolvedValue(true);
    sandboxApi.create.mockResolvedValue(createdSandbox);
    const setSandbox = jest.fn();

    const result = await ensureSandboxConnection({
      userID: "user-1",
      setSandbox,
    });

    expect(result.sandbox).toBe(createdSandbox);
    expect(sandboxApi.kill).toHaveBeenCalledWith("sandbox-1");
    expect(sandboxApi.connect).not.toHaveBeenCalled();
    expect(sandboxApi.create).toHaveBeenCalled();
    expect(setSandbox).toHaveBeenCalledWith(createdSandbox);
  });

  it("does not kill or replace a shared sandbox after a transient connect error", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      listSandbox();
      sandboxApi.connect.mockRejectedValue(
        new Error("temporary transport failure"),
      );

      await expect(
        ensureSandboxConnection({
          userID: "user-1",
          setSandbox: jest.fn(),
        }),
      ).rejects.toThrow("temporary transport failure");

      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("creates a replacement without killing when the listed sandbox is gone", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const createdSandbox = { sandboxId: "sandbox-2" } as unknown as Sandbox;
      listSandbox();
      sandboxApi.connect.mockRejectedValue(new Error("sandbox not found"));
      sandboxApi.create.mockResolvedValue(createdSandbox);

      const result = await ensureSandboxConnection({
        userID: "user-1",
        setSandbox: jest.fn(),
      });

      expect(result.sandbox).toBe(createdSandbox);
      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("manager reset forgets its client without killing the shared sandbox", async () => {
    const manager = new DefaultSandboxManager("user-1", jest.fn());
    const sandbox = {
      kill: jest.fn(),
    } as unknown as Sandbox;
    manager.setSandbox(sandbox);

    await manager.resetSandbox("test");

    expect(sandbox.kill).not.toHaveBeenCalled();
  });

  it("marks the sandbox unavailable after the initial check and reconnect both fail", () => {
    const manager = new DefaultSandboxManager("user-1", jest.fn());

    expect(manager.recordHealthFailure()).toBe(false);
    expect(manager.recordHealthFailure()).toBe(true);
    expect(manager.isSandboxUnavailable()).toBe(true);

    manager.resetHealthFailures();
    expect(manager.isSandboxUnavailable()).toBe(false);
  });

  it("manager returns a cached sandbox after a transient lease refresh failure", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manager = new DefaultSandboxManager("user-1", jest.fn());
      const sandbox = {
        sandboxId: "sandbox-1",
        setTimeout: jest.fn(async () => {
          throw new Error("temporary refresh failure");
        }),
      } as unknown as Sandbox;
      manager.setSandbox(sandbox);

      await expect(manager.getSandbox()).resolves.toEqual({ sandbox });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"source":"default_manager_cache"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
