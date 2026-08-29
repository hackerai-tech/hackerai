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
  E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS,
  E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
  E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
  ensureSandboxConnection,
  releaseE2BSandboxIdleLeaseBestEffort,
  refreshE2BSandboxLease,
  startE2BSandboxLeaseHeartbeat,
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
        metadata: { sandboxVersion: "v12" },
        ...overrides,
      },
    ]),
  });
};

describe("E2B sandbox lease lifecycle", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.E2B_EU_API_KEY;
    delete process.env.E2B_EU_DOMAIN;
    delete process.env.E2B_EU_TEMPLATE;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env = originalEnv;
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

  it("shortens the idle lease without pausing or killing the sandbox", async () => {
    const setTimeout = jest.fn(async () => undefined);
    const sandbox = {
      sandboxId: "sandbox-1",
      setTimeout,
      pause: jest.fn(),
      kill: jest.fn(),
    } as unknown as Sandbox;

    await expect(releaseE2BSandboxIdleLeaseBestEffort(sandbox)).resolves.toBe(
      true,
    );

    expect(setTimeout).toHaveBeenCalledWith(
      E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS,
      { requestTimeoutMs: E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS },
    );
    expect(
      (sandbox as unknown as { pause: jest.Mock }).pause,
    ).not.toHaveBeenCalled();
    expect(
      (sandbox as unknown as { kill: jest.Mock }).kill,
    ).not.toHaveBeenCalled();
  });

  it("fails open when shortening the idle lease is unavailable", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const sandbox = {
      sandboxId: "sandbox-1",
      setTimeout: jest.fn(async () => {
        throw new Error("temporary release failure");
      }),
    } as unknown as Sandbox;

    try {
      await expect(releaseE2BSandboxIdleLeaseBestEffort(sandbox)).resolves.toBe(
        false,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("e2b_sandbox_idle_lease_release_failed"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lets an active worker heartbeat restore the normal shared lease", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    let remoteExpiryMs = 0;
    const sandbox = {
      sandboxId: "sandbox-1",
      setTimeout: jest.fn(async (timeoutMs: number) => {
        remoteExpiryMs = Date.now() + timeoutMs;
      }),
    } as unknown as Sandbox;
    let finishOperation!: () => void;
    const activeRun = withE2BSandboxLeaseHeartbeat(
      sandbox,
      () =>
        new Promise<void>((resolve) => {
          finishOperation = resolve;
        }),
    );

    await releaseE2BSandboxIdleLeaseBestEffort(sandbox);
    expect(remoteExpiryMs).toBe(E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS);

    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
    );
    expect(remoteExpiryMs).toBe(Date.now() + BASH_SANDBOX_AUTOPAUSE_TIMEOUT);

    finishOperation();
    await activeRun;
  });

  it("waits for an in-flight run heartbeat before cleanup releases the lease", async () => {
    jest.useFakeTimers();
    let finishRefresh!: () => void;
    const setTimeout = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const sandbox = {
      sandboxId: "sandbox-1",
      setTimeout,
    } as unknown as Sandbox;
    const heartbeat = startE2BSandboxLeaseHeartbeat(
      () => sandbox,
      "run_heartbeat",
    );

    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
    );
    expect(setTimeout).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stop = heartbeat.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRefresh();
    await stop;
    expect(stopped).toBe(true);

    await jest.advanceTimersByTimeAsync(
      E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
    );
    expect(setTimeout).toHaveBeenCalledTimes(1);
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

  it("creates new sandboxes with pause and automatic resume enabled", async () => {
    const createdSandbox = { sandboxId: "sandbox-2" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({
      nextItems: jest.fn(async () => []),
    });
    sandboxApi.create.mockResolvedValue(createdSandbox);

    const result = await ensureSandboxConnection({
      userID: "user-1",
      setSandbox: jest.fn(),
    });

    expect(result.sandbox).toBe(createdSandbox);
    expect(sandboxApi.create).toHaveBeenCalledWith(
      "terminal-agent-sandbox",
      expect.objectContaining({
        timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
        lifecycle: { onTimeout: "pause", autoResume: true },
        secure: true,
        metadata: expect.objectContaining({ sandboxVersion: "v12" }),
      }),
    );
  });

  it("creates a fresh EU sandbox for an EU Trigger run when EU is configured", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    process.env.E2B_EU_DOMAIN = "e2b-juliett.dev";
    const createdSandbox = { sandboxId: "sandbox-eu" } as unknown as Sandbox;
    sandboxApi.list
      .mockReturnValueOnce({ nextItems: jest.fn(async () => []) })
      .mockReturnValueOnce({ nextItems: jest.fn(async () => []) });
    sandboxApi.create.mockResolvedValue(createdSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "eu-central-1" },
    );

    expect(result.sandbox).toBe(createdSandbox);
    expect(sandboxApi.list).toHaveBeenCalledTimes(2);
    expect(sandboxApi.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        apiKey: "e2b-eu-test-key",
        domain: "e2b-juliett.dev",
      }),
    );
    expect(sandboxApi.create).toHaveBeenCalledWith(
      "terminal-agent-sandbox",
      expect.objectContaining({
        apiKey: "e2b-eu-test-key",
        domain: "e2b-juliett.dev",
        metadata: expect.objectContaining({ e2bCluster: "eu" }),
      }),
    );
  });

  it("keeps reusing an existing US sandbox for an EU Trigger run", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const connectedSandbox = {
      sandboxId: "sandbox-us",
    } as unknown as Sandbox;
    sandboxApi.list
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [
          {
            sandboxId: "sandbox-us",
            state: "running",
            metadata: { sandboxVersion: "v12" },
          },
        ]),
      })
      .mockReturnValueOnce({ nextItems: jest.fn(async () => []) });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "eu-central-1" },
    );

    expect(result.sandbox).toBe(connectedSandbox);
    expect(sandboxApi.list).toHaveBeenCalledTimes(2);
    expect(sandboxApi.connect).toHaveBeenCalledWith("sandbox-us", {
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    });
  });

  it("falls back to the US cluster when the optional EU key is absent", async () => {
    const createdSandbox = { sandboxId: "sandbox-us" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({
      nextItems: jest.fn(async () => []),
    });
    sandboxApi.create.mockResolvedValue(createdSandbox);

    await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "eu-central-1" },
    );

    expect(sandboxApi.list).toHaveBeenCalledTimes(1);
    expect(sandboxApi.create).toHaveBeenCalledWith(
      "terminal-agent-sandbox",
      expect.not.objectContaining({
        apiKey: expect.anything(),
        domain: expect.anything(),
      }),
    );
  });

  it("reuses an EU sandbox if a later run is placed in a US Trigger region", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const connectedSandbox = {
      sandboxId: "sandbox-eu",
    } as unknown as Sandbox;
    sandboxApi.list
      .mockReturnValueOnce({ nextItems: jest.fn(async () => []) })
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [
          {
            sandboxId: "sandbox-eu",
            state: "paused",
            metadata: { sandboxVersion: "v12" },
          },
        ]),
      });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "us-east-1" },
    );

    expect(result.sandbox).toBe(connectedSandbox);
    expect(sandboxApi.connect).toHaveBeenCalledWith("sandbox-eu", {
      apiKey: "e2b-eu-test-key",
      domain: "e2b-juliett.dev",
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    });
  });

  it("prefers a running compatible EU sandbox over a stale paused US sandbox", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const connectedSandbox = {
      sandboxId: "sandbox-eu",
    } as unknown as Sandbox;
    sandboxApi.list
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [
          {
            sandboxId: "sandbox-us-stale",
            state: "paused",
            metadata: { sandboxVersion: "v10" },
          },
        ]),
      })
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [
          {
            sandboxId: "sandbox-eu",
            state: "running",
            metadata: { sandboxVersion: "v12" },
          },
        ]),
      });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "eu-central-1" },
    );

    expect(result.sandbox).toBe(connectedSandbox);
    expect(sandboxApi.connect).toHaveBeenCalledWith("sandbox-eu", {
      apiKey: "e2b-eu-test-key",
      domain: "e2b-juliett.dev",
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    });
    expect(sandboxApi.kill).not.toHaveBeenCalled();
    expect(sandboxApi.create).not.toHaveBeenCalled();
  });

  it("creates the replacement in EU when a listed US sandbox has expired", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const createdSandbox = { sandboxId: "sandbox-eu" } as unknown as Sandbox;
    listSandbox({ sandboxId: "sandbox-expired-us" });
    sandboxApi.connect.mockRejectedValue(new Error("sandbox not found"));
    sandboxApi.create.mockResolvedValue(createdSandbox);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await ensureSandboxConnection(
        { userID: "user-1", setSandbox: jest.fn() },
        { triggerRegion: "eu-central-1" },
      );

      expect(result.sandbox).toBe(createdSandbox);
      expect(sandboxApi.create).toHaveBeenCalledWith(
        "terminal-agent-sandbox",
        expect.objectContaining({
          apiKey: "e2b-eu-test-key",
          domain: "e2b-juliett.dev",
          metadata: expect.objectContaining({ e2bCluster: "eu" }),
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("prefers a running sandbox over a newer paused duplicate", async () => {
    const connectedSandbox = {
      sandboxId: "sandbox-running",
    } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({
      nextItems: jest.fn(async () => [
        {
          sandboxId: "sandbox-paused",
          state: "paused",
          metadata: { sandboxVersion: "v12" },
        },
        {
          sandboxId: "sandbox-running",
          state: "running",
          metadata: { sandboxVersion: "v12" },
        },
      ]),
    });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);

    const result = await ensureSandboxConnection({
      userID: "user-1",
      setSandbox: jest.fn(),
    });

    expect(result.sandbox).toBe(connectedSandbox);
    expect(sandboxApi.connect).toHaveBeenCalledWith("sandbox-running", {
      timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
    });
  });

  it("retries a transient connect failure before reusing the sandbox", async () => {
    jest.useFakeTimers();
    const connectedSandbox = { sandboxId: "sandbox-1" } as unknown as Sandbox;
    listSandbox();
    sandboxApi.connect
      .mockRejectedValueOnce(new Error("temporary transport failure"))
      .mockResolvedValue(connectedSandbox);

    const connection = ensureSandboxConnection({
      userID: "user-1",
      setSandbox: jest.fn(),
    });
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(connection).resolves.toEqual({ sandbox: connectedSandbox });
    expect(sandboxApi.connect).toHaveBeenCalledTimes(2);
  });

  it("retries a transient sandbox discovery failure", async () => {
    jest.useFakeTimers();
    const connectedSandbox = { sandboxId: "sandbox-1" } as unknown as Sandbox;
    const nextItems = jest
      .fn()
      .mockRejectedValueOnce(new Error("temporary list failure"))
      .mockResolvedValue([
        {
          sandboxId: "sandbox-1",
          state: "running",
          metadata: { sandboxVersion: "v12" },
        },
      ]);
    sandboxApi.list.mockReturnValue({ nextItems });
    sandboxApi.connect.mockResolvedValue(connectedSandbox);

    const connection = ensureSandboxConnection({
      userID: "user-1",
      setSandbox: jest.fn(),
    });
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(connection).resolves.toEqual({ sandbox: connectedSandbox });
    expect(nextItems).toHaveBeenCalledTimes(2);
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

  it("preserves a paused sandbox after a placement failure", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      listSandbox({ state: "paused" });
      sandboxApi.connect.mockRejectedValue(
        new Error("500: Failed to place sandbox"),
      );

      await expect(
        ensureSandboxConnection({
          userID: "user-1",
          setSandbox: jest.fn(),
        }),
      ).rejects.toThrow("Failed to place sandbox");

      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("preserves a paused sandbox after an operation timeout", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      listSandbox({ state: "paused" });
      sandboxApi.connect.mockRejectedValue(
        new Error("sandbox operation timed out"),
      );

      await expect(
        ensureSandboxConnection({
          userID: "user-1",
          setSandbox: jest.fn(),
        }),
      ).rejects.toThrow("sandbox operation timed out");

      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("preserves a running sandbox after a placement failure", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      listSandbox({ state: "running" });
      sandboxApi.connect.mockRejectedValue(
        new Error("500: Failed to place sandbox"),
      );

      await expect(
        ensureSandboxConnection({
          userID: "user-1",
          setSandbox: jest.fn(),
        }),
      ).rejects.toThrow("Failed to place sandbox");

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
