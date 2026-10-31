import { getE2BSandboxVersion } from "../e2b-sandbox-version";
jest.mock("@/lib/cloud-recovery/store", () => ({
  recordResumeFailure: jest.fn(async () => {}),
  clearResumeFailures: jest.fn(async () => {}),
}));
import { recordResumeFailure } from "@/lib/cloud-recovery/store";
jest.mock("@/lib/cloud-network/service", () => ({
  readNetworkSettings: jest.fn(async () => null),
  ensureCloudNetwork: jest.fn(async () => {}),
}));
jest.mock("@e2b/code-interpreter", () => {
  class E2BError extends Error {}
  return {
    Template: {
      getTags: jest.fn(async () => [
        { tag: "default", buildId: "legacy-build" },
      ]),
    },
    Sandbox: class {
      static list = jest.fn();
      static connect = jest.fn();
      static getInfo = jest.fn();
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

// This suite tests E2B's provider lease timing. Registration/fencing and the
// refusal to extend unregistered clients are exercised in cloud-workspace-guard.
jest.mock("../cloud-workspace-guard", () => ({
  ...jest.requireActual("../cloud-workspace-guard"),
  assertCloudWorkspaceAvailable: jest.fn(async () => {}),
  refreshE2BWorkspaceLease: jest.fn(async () => {}),
}));

import { readNetworkSettings } from "@/lib/cloud-network/service";
import {
  Sandbox,
  Template,
  SandboxError,
  TimeoutError,
} from "@e2b/code-interpreter";
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
import { CloudAcquisitionBudget } from "../cloud-acquisition-budget";
import { DefaultSandboxManager } from "../sandbox-manager";
import { E2BRegionUnavailableError } from "../e2b-cluster";

type MockSandboxApi = {
  list: jest.Mock;
  connect: jest.Mock;
  getInfo: jest.Mock;
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
    (Template.getTags as jest.Mock).mockResolvedValue([
      { tag: "default", buildId: "legacy-build" },
    ]);
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

  it.each(["discovery", "connect", "create"] as const)(
    "identifies a stalled E2B %s without replacing or publishing the workspace",
    async (stage) => {
      jest.useFakeTimers();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const setSandbox = jest.fn();
      let finish!: (value: any) => void;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      if (stage === "discovery") {
        sandboxApi.list.mockReturnValue({ nextItems: jest.fn(() => pending) });
      } else if (stage === "connect") {
        listSandbox();
        sandboxApi.connect.mockReturnValueOnce(pending);
      } else {
        sandboxApi.list.mockReturnValue({ nextItems: jest.fn(async () => []) });
        sandboxApi.create.mockReturnValueOnce(pending);
      }
      try {
        const result = new CloudAcquisitionBudget()
          .run(
            (signal, reportStage) =>
              ensureSandboxConnection(
                { userID: "user-1", setSandbox },
                { signal, reportStage },
              ),
            { userId: "user-1" },
          )
          .catch((error) => error);
        await jest.advanceTimersByTimeAsync(30_000);
        expect(await result).toMatchObject({ acquisitionStage: stage });
        finish(stage === "discovery" ? [] : { sandboxId: "late-sandbox" });
        await jest.advanceTimersByTimeAsync(1);
        expect(setSandbox).not.toHaveBeenCalled();
        expect(sandboxApi.kill).not.toHaveBeenCalled();
        if (stage !== "create")
          expect(sandboxApi.create).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("passes cancellation to E2B and neither publishes nor replaces a late reconnect", async () => {
    listSandbox();
    let complete!: (sandbox: Sandbox) => void;
    sandboxApi.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const controller = new AbortController();
    const publish = jest.fn();
    const result = ensureSandboxConnection(
      { userID: "user-1", setSandbox: publish },
      { signal: controller.signal },
    ).catch((error) => error);
    // Let discovery settle and connect begin.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sandboxApi.connect).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ signal: controller.signal }),
    );
    const reason = new Error("deadline expired");
    controller.abort(reason);
    complete({ sandboxId: "sandbox-1" } as Sandbox);
    expect(await result).toBe(reason);
    expect(publish).not.toHaveBeenCalled();
    expect(sandboxApi.create).not.toHaveBeenCalled();
    expect(sandboxApi.kill).not.toHaveBeenCalled();
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
      requestTimeoutMs: 90_000,
      retries: 0,
    });
    expect(setSandbox).toHaveBeenCalledWith(connectedSandbox);
  });

  it.each(["v12", "v13"])(
    "connects a verified %s pin without listing or replacing workspaces",
    async (version) => {
      sandboxApi.getInfo.mockResolvedValue({
        state: "paused",
        metadata: {
          userID: "user-1",
          template: "terminal-agent-sandbox",
          e2bCluster: "us",
          sandboxVersion: version,
        },
      });
      const pinned = { sandboxId: "verified-e2b" } as Sandbox;
      sandboxApi.connect.mockResolvedValue(pinned);
      const setSandbox = jest.fn();

      await expect(
        ensureSandboxConnection(
          { userID: "user-1", setSandbox },
          { destinationId: "verified-e2b", triggerRegion: "us-east-1" },
        ),
      ).resolves.toEqual({ sandbox: pinned });
      expect(sandboxApi.list).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
      expect(sandboxApi.connect).toHaveBeenCalledWith(
        "verified-e2b",
        expect.anything(),
      );
      expect(setSandbox).toHaveBeenCalledWith(pinned);
      expect(getE2BSandboxVersion(pinned)).toBe(version);
      expect(Template.getTags).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the E2B pin belongs to a different user", async () => {
    sandboxApi.getInfo.mockResolvedValue({
      state: "paused",
      metadata: {
        userID: "someone-else",
        template: "terminal-agent-sandbox",
        e2bCluster: "us",
        sandboxVersion: "v12",
      },
    });
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        ensureSandboxConnection(
          { userID: "user-1", setSandbox: jest.fn() },
          { destinationId: "verified-e2b", triggerRegion: "us-east-1" },
        ),
      ).rejects.toThrow();
      expect(sandboxApi.connect).not.toHaveBeenCalled();
      expect(sandboxApi.list).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
      expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toMatchObject({
        e2b_connect_state: null,
        e2b_connect_selection_source: null,
        e2b_connect_request_timeout_ms: null,
        e2b_connect_target_fingerprint: null,
        e2b_connect_cluster: null,
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("validates a recovered pin even when the caller already holds that sandbox", async () => {
    sandboxApi.getInfo.mockResolvedValue({
      state: "paused",
      metadata: {
        userID: "someone-else",
        template: "terminal-agent-sandbox",
        e2bCluster: "us",
        sandboxVersion: "v12",
      },
    });
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        ensureSandboxConnection(
          { userID: "user-1", setSandbox: jest.fn() },
          {
            initialSandbox: { sandboxId: "verified-e2b" } as Sandbox,
            destinationId: "verified-e2b",
            triggerRegion: "us-east-1",
          },
        ),
      ).rejects.toThrow();
      expect(sandboxApi.getInfo).toHaveBeenCalledWith(
        "verified-e2b",
        expect.anything(),
      );
      expect(sandboxApi.connect).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each(["v12", "v13"])(
    "preserves a paused %s workspace instead of creating from the new template",
    async (version) => {
      const attached = { sandboxId: "sandbox-1" } as unknown as Sandbox;
      listSandbox({ state: "paused", metadata: { sandboxVersion: version } });
      sandboxApi.connect.mockResolvedValue(attached);
      const result = await ensureSandboxConnection({
        userID: "user-1",
        setSandbox: jest.fn(),
      });
      expect(result.sandbox).toBe(attached);
      expect(getE2BSandboxVersion(attached)).toBe(version);
      expect(sandboxApi.create).not.toHaveBeenCalled();
      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(Template.getTags).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "v11", "v14"])(
    "refuses a recovery pin with unsupported version %s",
    async (version) => {
      sandboxApi.getInfo.mockResolvedValue({
        state: "paused",
        metadata: {
          userID: "user-1",
          template: "terminal-agent-sandbox",
          e2bCluster: "us",
          sandboxVersion: version,
        },
      });
      const log = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          ensureSandboxConnection(
            { userID: "user-1", setSandbox: jest.fn() },
            { destinationId: "pin" },
          ),
        ).rejects.toThrow("Cloud sandbox is temporarily unavailable");
        expect(sandboxApi.connect).not.toHaveBeenCalled();
        expect(sandboxApi.create).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each([
    [
      "default-build",
      "default-build",
      "v13",
      "terminal-agent-sandbox:default-build",
    ],
    ["legacy-build", undefined, "v12", "terminal-agent-sandbox:legacy-build"],
    [
      "rollback-build",
      "newer-build",
      "v12",
      "terminal-agent-sandbox:rollback-build",
    ],
  ])(
    "creates the image generation selected by template tags (%s / %s)",
    async (defaultBuild, versionBuild, version, template) => {
      (Template.getTags as jest.Mock).mockResolvedValue([
        { tag: "default", buildId: defaultBuild },
        ...(versionBuild ? [{ tag: "v13", buildId: versionBuild }] : []),
      ]);
      sandboxApi.list.mockReturnValue({ nextItems: async () => [] });
      const created = { sandboxId: "new-workspace" } as Sandbox;
      sandboxApi.create.mockResolvedValue(created);
      await ensureSandboxConnection({
        userID: "user-1",
        setSandbox: jest.fn(),
      });
      expect(sandboxApi.create).toHaveBeenCalledWith(
        template,
        expect.objectContaining({
          metadata: expect.objectContaining({
            sandboxVersion: version,
            template: "terminal-agent-sandbox",
          }),
        }),
      );
      expect(getE2BSandboxVersion(created)).toBe(version);
    },
  );

  it.each([
    ["terminal-agent-sandbox:v13", "new-build", "v13"],
    ["terminal-agent-sandbox:stable", "stable-build", "v12"],
    [
      "terminal-agent-sandbox:82a23bdf-97a0-4d40-a8df-d0feba19b461",
      "82a23bdf-97a0-4d40-a8df-d0feba19b461",
      "v12",
    ],
  ])(
    "respects the explicitly configured template %s",
    async (template, build, version) => {
      process.env.E2B_TEMPLATE = template;
      (Template.getTags as jest.Mock).mockResolvedValue([
        { tag: "default", buildId: "default-build" },
        { tag: "v13", buildId: "new-build" },
        { tag: "stable", buildId: "stable-build" },
      ]);
      sandboxApi.list.mockReturnValue({ nextItems: async () => [] });
      sandboxApi.create.mockResolvedValue({ sandboxId: "tagged" });
      await ensureSandboxConnection({
        userID: "user-1",
        setSandbox: jest.fn(),
      });
      expect(Template.getTags).toHaveBeenCalledWith(
        "terminal-agent-sandbox",
        expect.anything(),
      );
      expect(sandboxApi.create).toHaveBeenCalledWith(
        `terminal-agent-sandbox:${build}`,
        expect.objectContaining({
          metadata: expect.objectContaining({
            sandboxVersion: version,
            template,
          }),
        }),
      );
    },
  );

  it("does not create a workspace when the selected template tag is missing", async () => {
    sandboxApi.list.mockReturnValue({ nextItems: async () => [] });
    (Template.getTags as jest.Mock).mockResolvedValue([]);
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        ensureSandboxConnection({ userID: "user-1", setSandbox: jest.fn() }),
      ).rejects.toThrow();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("does not guess a generation or create a replacement when template lookup fails", async () => {
    sandboxApi.list.mockReturnValue({ nextItems: async () => [] });
    (Template.getTags as jest.Mock).mockRejectedValue(
      new Error("template lookup unavailable"),
    );
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        ensureSandboxConnection({ userID: "user-1", setSandbox: jest.fn() }),
      ).rejects.toThrow();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
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
      "terminal-agent-sandbox:legacy-build",
      expect.objectContaining({
        network: { allowOut: [], denyOut: [] },
        timeoutMs: BASH_SANDBOX_AUTOPAUSE_TIMEOUT,
        lifecycle: { onTimeout: "pause", autoResume: true },
        secure: true,
        metadata: expect.objectContaining({ sandboxVersion: "v12" }),
      }),
    );
  });

  it("creates a new workspace with its stored network restrictions already applied", async () => {
    jest.mocked(readNetworkSettings).mockResolvedValueOnce({
      policy: { mode: "restricted", allow: ["example.test"] },
      revision: 3,
      status: "ready",
    });
    sandboxApi.list.mockReturnValue({ nextItems: jest.fn(async () => []) });
    sandboxApi.create.mockResolvedValue({ sandboxId: "restricted-workspace" });
    await ensureSandboxConnection({ userID: "user-1", setSandbox: jest.fn() });
    expect(sandboxApi.create).toHaveBeenCalledWith(
      "terminal-agent-sandbox:legacy-build",
      expect.objectContaining({
        network: { allowOut: ["example.test"], denyOut: ["0.0.0.0/0"] },
      }),
    );
  });

  it.each(["fresh", "expired"])(
    "logs the failing E2B create phase after %s selection without connect identity or a response body",
    async (selection) => {
      const errorLog = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      sandboxApi.list.mockReturnValue({
        nextItems: jest.fn(async () => []),
        hasNext: false,
      });
      if (selection === "expired") {
        listSandbox({ sandboxId: "sandbox-expired" });
        sandboxApi.connect.mockRejectedValue(new Error("sandbox not found"));
      }
      sandboxApi.create.mockRejectedValue(
        Object.assign(new Error("private token and response body"), {
          code: "SERVICE_UNAVAILABLE",
          status: 503,
        }),
      );
      try {
        await expect(
          ensureSandboxConnection({
            userID: "user-1",
            setSandbox: jest.fn(),
          }),
        ).rejects.toMatchObject({
          diagnostics: {
            e2b_phase: "create",
            e2b_error_code: "SERVICE_UNAVAILABLE",
            e2b_http_status: 503,
          },
        });
        expect(errorLog).toHaveBeenCalledWith(
          expect.stringContaining('"event":"e2b_sandbox_acquisition_failed"'),
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
          "private token and response body",
        );
        const diagnostic = errorLog.mock.calls.find(([entry]) =>
          String(entry).includes('"event":"e2b_sandbox_acquisition_failed"'),
        );
        expect(JSON.parse(String(diagnostic?.[0]))).toMatchObject({
          e2b_connect_state: null,
          e2b_connect_selection_source: null,
          e2b_connect_request_timeout_ms: null,
          e2b_connect_target_fingerprint: null,
          e2b_connect_cluster: null,
        });
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("creates a fresh EU sandbox for an EU Trigger run when EU is configured", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    process.env.E2B_EU_DOMAIN = "e2b-juliett.dev";
    const createdSandbox = { sandboxId: "sandbox-eu" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({ nextItems: jest.fn(async () => []) });
    sandboxApi.create.mockResolvedValue(createdSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "eu-central-1" },
    );

    expect(result.sandbox).toBe(createdSandbox);
    expect(sandboxApi.list).toHaveBeenCalledTimes(1);
    expect(sandboxApi.list).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "e2b-eu-test-key",
        domain: "e2b-juliett.dev",
      }),
    );
    expect(sandboxApi.create).toHaveBeenCalledWith(
      "terminal-agent-sandbox:legacy-build",
      expect.objectContaining({
        apiKey: "e2b-eu-test-key",
        domain: "e2b-juliett.dev",
        metadata: expect.objectContaining({ e2bCluster: "eu" }),
      }),
    );
  });

  it("does not discover or reuse the US cluster for an EU Trigger run", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const createdSandbox = { sandboxId: "sandbox-eu" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({ nextItems: jest.fn(async () => []) });
    sandboxApi.create.mockResolvedValue(createdSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "eu-central-1" },
    );

    expect(result.sandbox).toBe(createdSandbox);
    expect(sandboxApi.list).toHaveBeenCalledTimes(1);
    expect(sandboxApi.list).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "e2b-eu-test-key",
        domain: "e2b-juliett.dev",
      }),
    );
    expect(sandboxApi.connect).not.toHaveBeenCalled();
  });

  it("fails closed when the EU cluster is not configured", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        ensureSandboxConnection(
          { userID: "user-1", setSandbox: jest.fn() },
          { triggerRegion: "eu-central-1" },
        ),
      ).rejects.toMatchObject({
        name: E2BRegionUnavailableError.name,
        code: "E2B_EU_REGION_UNAVAILABLE",
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(sandboxApi.list).not.toHaveBeenCalled();
    expect(sandboxApi.create).not.toHaveBeenCalled();
  });

  it("keeps a US Trigger run inside the US cluster", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const createdSandbox = { sandboxId: "sandbox-us" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({ nextItems: jest.fn(async () => []) });
    sandboxApi.create.mockResolvedValue(createdSandbox);

    const result = await ensureSandboxConnection(
      { userID: "user-1", setSandbox: jest.fn() },
      { triggerRegion: "us-east-1" },
    );

    expect(result.sandbox).toBe(createdSandbox);
    expect(sandboxApi.list).toHaveBeenCalledTimes(1);
    expect(sandboxApi.list).toHaveBeenCalledWith(
      expect.not.objectContaining({
        apiKey: expect.anything(),
        domain: expect.anything(),
      }),
    );
    expect(sandboxApi.create).toHaveBeenCalledWith(
      "terminal-agent-sandbox:legacy-build",
      expect.objectContaining({
        metadata: expect.objectContaining({ e2bCluster: "us" }),
      }),
    );
  });

  it("reuses a compatible sandbox from the selected EU cluster", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const connectedSandbox = {
      sandboxId: "sandbox-eu",
    } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({
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

  it("creates the replacement in EU when a listed EU sandbox has expired", async () => {
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const createdSandbox = { sandboxId: "sandbox-eu" } as unknown as Sandbox;
    listSandbox({ sandboxId: "sandbox-expired-eu" });
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
        "terminal-agent-sandbox:legacy-build",
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

  it("preserves a paused old-version workspace and its files", async () => {
    const existingSandbox = { sandboxId: "sandbox-1" } as unknown as Sandbox;
    listSandbox({
      state: "paused",
      metadata: { sandboxVersion: "v10" },
    });
    sandboxApi.connect.mockResolvedValue(existingSandbox);
    const setSandbox = jest.fn();

    const result = await ensureSandboxConnection({
      userID: "user-1",
      setSandbox,
    });

    expect(result.sandbox).toBe(existingSandbox);
    expect(sandboxApi.kill).not.toHaveBeenCalled();
    expect(sandboxApi.connect).toHaveBeenCalled();
    expect(sandboxApi.create).not.toHaveBeenCalled();
    expect(setSandbox).toHaveBeenCalledWith(existingSandbox);
  });

  it("finds and preserves an old-template workspace on a later inventory page", async () => {
    let page = 0;
    const existing = { sandboxId: "old-source" } as unknown as Sandbox;
    sandboxApi.list.mockReturnValue({
      nextItems: jest.fn(async () =>
        ++page === 1
          ? []
          : [
              {
                sandboxId: "old-source",
                state: "paused",
                metadata: { sandboxVersion: "v10", template: "old-alias" },
              },
            ],
      ),
      get hasNext() {
        return page < 2;
      },
    });
    sandboxApi.connect.mockResolvedValue(existing);
    await expect(
      ensureSandboxConnection({ userID: "user-1", setSandbox: jest.fn() }),
    ).resolves.toEqual({ sandbox: existing });
    expect(sandboxApi.list).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { metadata: { userID: "user-1" }, state: ["running", "paused"] },
      }),
    );
    expect(sandboxApi.kill).not.toHaveBeenCalled();
    expect(sandboxApi.create).not.toHaveBeenCalled();
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
      ).rejects.toMatchObject({ diagnostics: { e2b_phase: "connect" } });

      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    ["paused", "inventory", 90_000, 1],
    ["running", "inventory", null, 3],
    ["paused", "pinned", 90_000, 1],
    ["running", "pinned", null, 3],
  ] as const)(
    "records the selected %s %s connection when the provider fails",
    async (state, selectionSource, requestTimeoutMs, attempts) => {
      jest.useFakeTimers();
      const errorLog = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const setSandbox = jest.fn();
      const privateWorkspace = "private-workspace-id";
      const info = {
        sandboxId: privateWorkspace,
        state,
        metadata: {
          userID: "user-1",
          template: "terminal-agent-sandbox",
          e2bCluster: "us",
          sandboxVersion: "v12",
          privateContext: "private-workspace-metadata",
        },
      };
      listSandbox(info);
      sandboxApi.getInfo.mockResolvedValue(info);
      sandboxApi.connect.mockRejectedValue(
        Object.assign(new Error("504: private-provider-response"), {
          status: 504,
        }),
      );
      try {
        const result = ensureSandboxConnection(
          { userID: "user-1", setSandbox },
          {
            triggerRegion: "us-east-1",
            ...(selectionSource === "pinned"
              ? { destinationId: privateWorkspace }
              : {}),
          },
        ).catch((error) => error);
        await jest.runAllTimersAsync();
        expect((await result).diagnostics).toEqual({
          e2b_phase: "connect",
          e2b_error_category: "unknown",
          e2b_http_status: 504,
        });
        expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toMatchObject({
          event: "e2b_sandbox_acquisition_failed",
          e2b_connect_state: state,
          e2b_connect_selection_source: selectionSource,
          e2b_connect_request_timeout_ms: requestTimeoutMs,
          e2b_connect_target_fingerprint:
            expect.stringMatching(/^[a-f0-9]{64}$/),
          e2b_connect_cluster: "us",
        });
        const serializedLogs = JSON.stringify(errorLog.mock.calls);
        for (const privateValue of [
          privateWorkspace,
          "private-workspace-metadata",
          "private-provider-response",
        ])
          expect(serializedLogs).not.toContain(privateValue);
        expect(sandboxApi.connect).toHaveBeenCalledTimes(attempts);
        const connectOptions = sandboxApi.connect.mock.calls[0][1];
        if (state === "paused")
          expect(connectOptions).toMatchObject({
            requestTimeoutMs: 90_000,
            retries: 0,
          });
        else expect(connectOptions).not.toHaveProperty("requestTimeoutMs");
        expect(setSandbox).not.toHaveBeenCalled();
        expect(sandboxApi.kill).not.toHaveBeenCalled();
        expect(sandboxApi.create).not.toHaveBeenCalled();
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("correlates the same selected workspace across paths without mixing clusters or identities", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    const fingerprints: string[] = [];
    try {
      for (const [cluster, selection, sandboxId] of [
        ["us", "inventory", "private-workspace-id"],
        ["us", "pinned", "private-workspace-id"],
        ["us", "inventory", "other-workspace-id"],
        ["eu", "inventory", "private-workspace-id"],
      ] as const) {
        const info = {
          sandboxId,
          state: "paused" as const,
          metadata: {
            userID: "user-1",
            template: "terminal-agent-sandbox",
            e2bCluster: cluster,
            sandboxVersion: "v12",
          },
        };
        listSandbox(info);
        sandboxApi.getInfo.mockResolvedValue(info);
        sandboxApi.connect.mockClear();
        sandboxApi.connect.mockRejectedValue(
          Object.assign(new Error("private-provider-response"), {
            status: 504,
          }),
        );
        errorLog.mockClear();
        await expect(
          ensureSandboxConnection(
            { userID: "user-1", setSandbox: jest.fn() },
            {
              triggerRegion: cluster === "eu" ? "eu-central-1" : "us-east-1",
              ...(selection === "pinned" ? { destinationId: sandboxId } : {}),
            },
          ),
        ).rejects.toMatchObject({ diagnostics: { e2b_phase: "connect" } });
        const diagnostic = JSON.parse(String(errorLog.mock.calls[0][0]));
        expect(diagnostic.e2b_connect_cluster).toBe(cluster);
        expect(diagnostic.e2b_connect_target_fingerprint).toMatch(
          /^[a-f0-9]{64}$/,
        );
        fingerprints.push(diagnostic.e2b_connect_target_fingerprint);
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(sandboxId);
        expect(sandboxApi.connect).toHaveBeenCalledTimes(1);
      }
      expect(fingerprints[0]).toBe(fingerprints[1]);
      expect(
        new Set([fingerprints[0], fingerprints[2], fingerprints[3]]).size,
      ).toBe(3);
      expect(sandboxApi.create).not.toHaveBeenCalled();
      expect(sandboxApi.kill).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each([
    "https://private.example/workspace?token=private-value",
    "x".repeat(129),
    123,
  ])(
    "omits an unsafe provider identity from connect diagnostics (%p)",
    async (value) => {
      const errorLog = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      listSandbox({ sandboxId: value as string, state: "paused" });
      sandboxApi.connect.mockRejectedValue(
        Object.assign(new Error("private-provider-response"), { status: 504 }),
      );
      try {
        await expect(
          ensureSandboxConnection({ userID: "user-1", setSandbox: jest.fn() }),
        ).rejects.toMatchObject({
          diagnostics: { e2b_phase: "connect", e2b_http_status: 504 },
        });
        expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toMatchObject({
          e2b_connect_target_fingerprint: null,
          e2b_connect_cluster: "us",
        });
        if (typeof value === "string")
          expect(JSON.stringify(errorLog.mock.calls)).not.toContain(value);
        expect(sandboxApi.connect).toHaveBeenCalledTimes(1);
        expect(sandboxApi.create).not.toHaveBeenCalled();
        expect(sandboxApi.kill).not.toHaveBeenCalled();
      } finally {
        errorLog.mockRestore();
      }
    },
  );

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
      ).rejects.toMatchObject({ diagnostics: { e2b_phase: "connect" } });

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
      ).rejects.toMatchObject({ diagnostics: { e2b_phase: "connect" } });

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
      ).rejects.toMatchObject({ diagnostics: { e2b_phase: "connect" } });

      expect(sandboxApi.kill).not.toHaveBeenCalled();
      expect(sandboxApi.create).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    ["v12", "terminal-agent-sandbox", "us", true],
    ["v11", "terminal-agent-sandbox", "us", false],
    ["v12", "legacy-template", "us", false],
    ["v12", "terminal-agent-sandbox", "eu", false],
  ])(
    "records only pinned-compatible paused targets: %s / %s / %s",
    async (version, template, cluster, recorded) => {
      process.env.E2B_TEMPLATE = "terminal-agent-sandbox";
      listSandbox({
        state: "paused",
        metadata: {
          userID: "user-1",
          sandboxVersion: version as string,
          template: template as string,
          e2bCluster: cluster as string,
        },
      });
      sandboxApi.connect.mockRejectedValue(
        Object.assign(new Error("resume rejected"), { statusCode: 400 }),
      );
      await expect(
        ensureSandboxConnection(
          { userID: "user-1", setSandbox: jest.fn() },
          {
            acquisitionId: "7ad19af5-4d14-4d4b-aab7-90734610a6da",
            triggerRegion: "us-east-1",
          },
        ),
      ).rejects.toThrow();
      expect(recordResumeFailure).toHaveBeenCalledTimes(recorded ? 1 : 0);
    },
  );

  it.each<[string, Error, boolean, boolean]>([
    [
      "SDK deadline",
      new TimeoutError("requestTimeoutMs exceeded"),
      true,
      false,
    ],
    [
      "provider gateway timeout",
      Object.assign(new SandboxError("upstream request timeout"), {
        statusCode: 504,
      }),
      true,
      false,
    ],
    ...[500, 502, 503].map<[string, Error, boolean, boolean]>((statusCode) => [
      `other provider failure ${statusCode}`,
      Object.assign(new SandboxError("provider failure"), { statusCode }),
      false,
      false,
    ]),
    [
      "unattributed HTTP status",
      Object.assign(new Error("unknown failure"), { statusCode: 504 }),
      false,
      false,
    ],
    [
      "expired sandbox",
      Object.assign(new TimeoutError("sandbox timeout"), { statusCode: 504 }),
      false,
      false,
    ],
    [
      "cancellation during provider timeout",
      Object.assign(new SandboxError("upstream request timeout"), {
        statusCode: 504,
      }),
      false,
      true,
    ],
    [
      "unknown connection failure",
      new Error("unknown connection failure"),
      false,
      false,
    ],
  ])(
    "marks only known paused connection timeouts as reconcilable: %s",
    async (_label, failure, reconcilable, cancel) => {
      process.env.E2B_TEMPLATE = "terminal-agent-sandbox";
      listSandbox({
        state: "paused",
        metadata: {
          userID: "user-1",
          sandboxVersion: "v12",
          template: "terminal-agent-sandbox",
          e2bCluster: "us",
        },
      });
      const controller = new AbortController();
      sandboxApi.connect.mockImplementation(async () => {
        if (cancel) controller.abort(new Error("user cancelled"));
        throw failure;
      });
      await expect(
        ensureSandboxConnection(
          { userID: "user-1", setSandbox: jest.fn() },
          {
            acquisitionId: "7ad19af5-4d14-4d4b-aab7-90734610a6da",
            triggerRegion: "us-east-1",
            signal: controller.signal,
          },
        ),
      ).rejects.toThrow();
      expect(recordResumeFailure).toHaveBeenCalledWith(
        expect.objectContaining({ uncertain: true, timeoutOnly: reconcilable }),
      );
      expect(sandboxApi.connect).toHaveBeenCalledTimes(1);
      expect(sandboxApi.create).not.toHaveBeenCalled();
      expect(sandboxApi.kill).not.toHaveBeenCalled();
    },
  );

  it("records a pinned paused gateway timeout without another resume", async () => {
    process.env.E2B_TEMPLATE = "terminal-agent-sandbox";
    sandboxApi.getInfo.mockResolvedValue({
      sandboxId: "pinned-sandbox",
      state: "paused",
      metadata: {
        userID: "user-1",
        sandboxVersion: "v12",
        template: "terminal-agent-sandbox",
        e2bCluster: "us",
      },
    });
    sandboxApi.connect.mockRejectedValue(
      Object.assign(new SandboxError("upstream request timeout"), {
        statusCode: 504,
      }),
    );
    await expect(
      ensureSandboxConnection(
        { userID: "user-1", setSandbox: jest.fn() },
        {
          destinationId: "pinned-sandbox",
          acquisitionId: "7ad19af5-4d14-4d4b-aab7-90734610a6da",
          triggerRegion: "us-east-1",
        },
      ),
    ).rejects.toThrow();
    expect(recordResumeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "pinned-sandbox",
        uncertain: true,
        timeoutOnly: true,
      }),
    );
    expect(sandboxApi.connect).toHaveBeenCalledTimes(1);
    expect(sandboxApi.list).not.toHaveBeenCalled();
    expect(sandboxApi.create).not.toHaveBeenCalled();
    expect(sandboxApi.kill).not.toHaveBeenCalled();
  });

  it("does not classify a publication failure as a provider gateway timeout", async () => {
    process.env.E2B_TEMPLATE = "terminal-agent-sandbox";
    listSandbox({
      state: "paused",
      metadata: {
        userID: "user-1",
        sandboxVersion: "v12",
        template: "terminal-agent-sandbox",
        e2bCluster: "us",
      },
    });
    sandboxApi.connect.mockResolvedValue({ sandboxId: "sandbox-1" });
    await expect(
      ensureSandboxConnection(
        {
          userID: "user-1",
          setSandbox: () => {
            throw Object.assign(new SandboxError("publication failed"), {
              statusCode: 504,
            });
          },
        },
        {
          acquisitionId: "7ad19af5-4d14-4d4b-aab7-90734610a6da",
          triggerRegion: "us-east-1",
        },
      ),
    ).rejects.toThrow();
    expect(recordResumeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ uncertain: true, timeoutOnly: false }),
    );
    expect(sandboxApi.connect).toHaveBeenCalledTimes(1);
    expect(sandboxApi.create).not.toHaveBeenCalled();
    expect(sandboxApi.kill).not.toHaveBeenCalled();
  });

  it("never replaces a known paused workspace after a not-found resume response", async () => {
    listSandbox({ state: "paused" });
    sandboxApi.connect.mockRejectedValue(new Error("sandbox not found"));
    sandboxApi.create.mockClear();
    await expect(
      ensureSandboxConnection({ userID: "user-1", setSandbox: jest.fn() }),
    ).rejects.toThrow();
    expect(sandboxApi.create).not.toHaveBeenCalled();
    expect(sandboxApi.kill).not.toHaveBeenCalled();
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
