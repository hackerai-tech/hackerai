import { Sandbox } from "@e2b/code-interpreter";
import {
  claimE2BDiskRecovery,
  readCloudWorkspaceState,
  readE2BDiskRecoveryResult,
} from "../cloud-workspace-guard";
import {
  recoverE2BDiskOnly,
  validateDiskRecoveryAuthorization,
  REBOOT_REQUEST_TIMEOUT_MS,
} from "../e2b-disk-recovery";
import { createHmac } from "node:crypto";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    getInfo: jest.fn(),
    getMetrics: jest.fn(),
    connect: jest.fn(),
    listSnapshots: jest.fn(),
  },
}));
jest.mock("../cloud-workspace-guard", () => ({
  claimE2BDiskRecovery: jest.fn(),
  readCloudWorkspaceState: jest.fn(),
  readE2BDiskRecoveryResult: jest.fn(),
}));

const getInfo = jest.mocked(Sandbox.getInfo);
const connect = jest.mocked(Sandbox.connect);
const claim = jest.mocked(claimE2BDiskRecovery);
const state = jest.mocked(readCloudWorkspaceState);
const result = jest.mocked(readE2BDiskRecoveryResult);
const finish = jest.fn();
const update = jest.fn();
const pause = jest.fn();
const snapshot = jest.fn();
const run = jest.fn();
const list = jest.fn();
const write = jest.fn();
const read = jest.fn();
const remove = jest.fn();
const key = "test-api-key";
const originalEnv = process.env;
const auth = {
  version: 1 as const,
  environment: "preview" as const,
  operatorId: "ticket",
  idempotencyKey: "7ad19af5-4d14-4d4b-aab7-90734610a6da",
  userId: "user-1",
  sandboxId: "sandbox-1",
  region: "us-east-1" as const,
  e2bAccount: "verified-account",
  e2bProject: "verified-project",
  expectedApiKeyHmacSha256: createHmac("sha256", key)
    .update("hackerai-e2b-disk-recovery-target-v1")
    .digest("hex"),
  expectedRedisHost: "example.upstash.io",
  expectedConvexUrl: "https://preview.convex.cloud",
  expectedTemplate: "template-1",
  expectedSandboxVersion: "v12",
  intent: "I accept loss of running processes and unflushed writes" as const,
  trafficQuiesced: true as const,
};
const info = {
  sandboxId: auth.sandboxId,
  state: "paused",
  metadata: {
    userID: auth.userId,
    e2bCluster: "us",
    template: auth.expectedTemplate,
    sandboxVersion: auth.expectedSandboxVersion,
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env = {
    ...originalEnv,
    E2B_API_KEY: key,
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
    NEXT_PUBLIC_CONVEX_URL: "https://preview.convex.cloud",
    HACKERAI_ENVIRONMENT: "preview",
  };
  result.mockResolvedValue(null);
  state.mockResolvedValue(null);
  getInfo.mockImplementation(
    async () =>
      ({
        ...info,
        state:
          connect.mock.calls.length > pause.mock.calls.length
            ? "running"
            : "paused",
      }) as never,
  );
  jest.mocked(Sandbox.getMetrics).mockResolvedValue([]);
  claim.mockResolvedValue({ state: {} as never, finish, update } as never);
  finish.mockResolvedValue(undefined);
  update.mockResolvedValue(undefined);
  pause.mockResolvedValue(true);
  snapshot.mockResolvedValue({ snapshotId: "backup-1" });
  run.mockResolvedValue({ exitCode: 0 });
  list.mockResolvedValue([{ name: "synthetic.txt", type: "file", size: 4 }]);
  let bytes = "";
  write.mockImplementation(async (_path, value) => {
    bytes = value;
  });
  read.mockImplementation(async () => bytes);
  remove.mockResolvedValue(undefined);
  jest.mocked(Sandbox.listSnapshots).mockReturnValue({
    hasNext: false,
    nextItems: async () => [{ snapshotId: "backup-1" }],
  } as never);
  connect.mockResolvedValue({
    sandboxId: auth.sandboxId,
    commands: { run },
    files: { list, write, read, remove },
    pause,
    createSnapshot: snapshot,
  } as never);
});
afterAll(() => {
  process.env = originalEnv;
});

describe("operator authorization", () => {
  const env = {
    E2B_API_KEY: key,
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
    NEXT_PUBLIC_CONVEX_URL: auth.expectedConvexUrl,
    HACKERAI_ENVIRONMENT: "preview",
  };
  it("requires an informed decision and exact environment/key fingerprint", () => {
    expect(validateDiskRecoveryAuthorization(auth, env)).toEqual(auth);
    expect(() =>
      validateDiskRecoveryAuthorization({ ...auth, intent: "recover" }, env),
    ).toThrow();
    expect(() =>
      validateDiskRecoveryAuthorization(auth, { ...env, E2B_API_KEY: "wrong" }),
    ).toThrow();
    expect(() =>
      validateDiskRecoveryAuthorization(auth, {
        ...env,
        HACKERAI_ENVIRONMENT: "production",
      }),
    ).toThrow();
    expect(() =>
      validateDiskRecoveryAuthorization(auth, {
        ...env,
        UPSTASH_REDIS_REST_URL: "https://other.upstash.io",
      }),
    ).toThrow();
  });
  it("requires the correct regional key for Europe", () => {
    const euAuth = { ...auth, region: "eu-central-1" };
    expect(() => validateDiskRecoveryAuthorization(euAuth, env)).toThrow();
    expect(
      validateDiskRecoveryAuthorization(euAuth, {
        ...env,
        E2B_EU_API_KEY: key,
      }),
    ).toEqual(euAuth);
  });
});

describe("disk-only recovery", () => {
  it("never touches the provider for an idempotent completed request", async () => {
    result.mockResolvedValue({
      token: auth.idempotencyKey,
      status: "verified_paused",
      sandboxId: auth.sandboxId,
      region: auth.region,
    });
    await expect(recoverE2BDiskOnly(auth)).resolves.toMatchObject({
      status: "verified_paused",
    });
    expect(getInfo).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("never reuses a completion receipt for another sandbox", async () => {
    result.mockResolvedValue({
      token: auth.idempotencyKey,
      status: "verified_paused",
      sandboxId: "other",
      region: auth.region,
    });
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "idempotency",
    });
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("refuses an existing fence or wrong identity before a reboot", async () => {
    state.mockResolvedValue({ phase: "recovery" } as never);
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "fenced",
    });
    expect(claim).not.toHaveBeenCalled();
    state.mockResolvedValue(null);
    getInfo.mockResolvedValue({
      ...info,
      metadata: { ...info.metadata, userID: "other" },
    } as never);
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "identity",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires the exact migrated destination and region", async () => {
    claim.mockRejectedValueOnce(new Error("migrated region mismatch"));
    await expect(recoverE2BDiskOnly(auth)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("rechecks state after the durable claim, and leaves a fence on a race", async () => {
    getInfo
      .mockResolvedValueOnce(info as never)
      .mockResolvedValueOnce({ ...info, state: "running" } as never);
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "identity",
    });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("reboots only once, captures backup, pauses, normally resumes and pauses again", async () => {
    const value = await recoverE2BDiskOnly(auth);
    expect(value).toMatchObject({
      status: "verified_paused",
      backupSnapshotId: "backup-1",
      entryCount: 1,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(
      1,
      auth.sandboxId,
      expect.objectContaining({
        onResume: "reboot",
        retries: 0,
        requestTimeoutMs: REBOOT_REQUEST_TIMEOUT_MS,
      }),
    );
    expect(connect).toHaveBeenNthCalledWith(
      2,
      auth.sandboxId,
      expect.not.objectContaining({ onResume: "reboot" }),
    );
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "backup_created",
        backupSnapshotId: "backup-1",
      }),
    );
    expect(pause).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("keeps the operator fence if the backup receipt cannot be read back", async () => {
    jest.mocked(Sandbox.listSnapshots).mockReturnValue({
      hasNext: false,
      nextItems: async () => [],
    } as never);
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "backup",
    });
    expect(pause).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("keeps the operator fence if probe bytes do not survive normal resume", async () => {
    read.mockImplementationOnce(async () =>
      createHmac("sha256", key).update(auth.idempotencyKey).digest("hex"),
    );
    read.mockResolvedValueOnce("lost");
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "normal_resume",
    });
    expect(finish).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a different sandbox returned by the operator's normal reconnect", async () => {
    const sandbox = await connect(auth.sandboxId);
    connect.mockClear();
    connect.mockResolvedValueOnce(sandbox).mockResolvedValueOnce({
      ...sandbox,
      sandboxId: "other",
    });
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "normal_resume",
    });
    expect(finish).not.toHaveBeenCalled();
  });

  it("retains the fence when ownership changes during a pause", async () => {
    getInfo.mockImplementation(
      async () =>
        ({
          ...info,
          state:
            connect.mock.calls.length > pause.mock.calls.length
              ? "running"
              : "paused",
          metadata: {
            ...info.metadata,
            userID: pause.mock.calls.length ? "other" : auth.userId,
          },
        }) as never,
    );
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "pause",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it("completes verified recovery when optional resource metrics are unavailable", async () => {
    jest.mocked(Sandbox.getMetrics).mockRejectedValue(new Error("unavailable"));
    await expect(recoverE2BDiskOnly(auth)).resolves.toMatchObject({
      status: "verified_paused",
      diagnostics: { before: { metrics: null }, after: { metrics: null } },
    });
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["provider_409", Object.assign(new Error("conflict"), { statusCode: 409 })],
    ["timeout", new Error("timeout")],
    [
      "cancellation",
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
    ],
    [
      "unsupported",
      Object.assign(new Error("unsupported"), { statusCode: 400 }),
    ],
  ])("retains the fence after %s with no retry", async (_, error) => {
    state.mockResolvedValueOnce(null).mockResolvedValue({
      phase: "recovery",
      token: auth.idempotencyKey,
    } as never);
    connect.mockRejectedValueOnce(error);
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "reboot",
      details: { fence: "retained" },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it.each(["backup", "pause"])(
    "keeps a recoverable fence if %s fails",
    async (stage) => {
      if (stage === "backup")
        snapshot.mockRejectedValueOnce(new Error("snapshot unavailable"));
      else pause.mockRejectedValueOnce(new Error("pause failed"));
      await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({ stage });
      if (stage === "backup") expect(pause).not.toHaveBeenCalled();
      else
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({
            step: "backup_created",
            backupSnapshotId: "backup-1",
          }),
        );
      expect(finish).not.toHaveBeenCalled();
    },
  );

  it("keeps the fence when ordinary resume or metadata verification fails", async () => {
    connect
      .mockResolvedValueOnce({
        sandboxId: auth.sandboxId,
        commands: { run },
        files: { list, write, read, remove },
        pause,
        createSnapshot: snapshot,
      } as never)
      .mockRejectedValueOnce(new Error("normal restore failed"));
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "normal_resume",
    });
    expect(finish).not.toHaveBeenCalled();
  });
});

describe("customer recovery verification", () => {
  const idle = jest.fn();
  const write = jest.fn();
  const read = jest.fn();
  const remove = jest.fn();
  const customer = {
    consentKey: "cloud_recovery_consent:v1:user-1",
    assertIdle: idle,
  };
  beforeEach(() => {
    idle.mockResolvedValue(undefined);
    getInfo.mockImplementation(
      async () =>
        ({
          ...info,
          state:
            connect.mock.calls.length > pause.mock.calls.length
              ? "running"
              : "paused",
          lifecycle: { autoResume: true, onTimeout: "pause" },
        }) as never,
    );
    let bytes = "";
    write.mockImplementation(async (_path, value) => {
      bytes = value;
    });
    read.mockImplementation(async () => bytes);
    remove.mockResolvedValue(undefined);
    connect.mockResolvedValue({
      sandboxId: auth.sandboxId,
      commands: { run },
      files: { list, write, read, remove },
      pause,
      createSnapshot: snapshot,
    } as never);
    jest.mocked(Sandbox.listSnapshots).mockReturnValue({
      hasNext: false,
      nextItems: async () => [{ snapshotId: "backup-1" }],
    } as never);
  });
  it("requires a known pause lifecycle, even when auto-resume is enabled", async () => {
    getInfo.mockResolvedValueOnce({
      ...info,
      lifecycle: { onTimeout: "pause" },
    } as never);
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "traffic",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it("retains the fence and does not retry when a conflicting provider start refuses reboot", async () => {
    connect.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { status: 409 }),
    );
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "reboot",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ step: "support_required" });
    expect(finish).not.toHaveBeenCalled();
  });
  it("proves our own bytes persisted across normal resume before releasing", async () => {
    await expect(recoverE2BDiskOnly(auth, customer)).resolves.toMatchObject({
      status: "verified_ready",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        customerConsent: {
          key: customer.consentKey,
          token: auth.idempotencyKey,
        },
      }),
    );
    expect(
      connect.mock.calls.filter(([, opts]) => opts?.onResume === "reboot"),
    ).toHaveLength(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
  it("keeps the fence on lost probe contents", async () => {
    read.mockResolvedValueOnce("corrupt");
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "inventory",
    });
    expect(finish).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ step: "support_required" });
  });
  it("keeps the fence when bytes change across resume", async () => {
    const probe = createHmac("sha256", key)
      .update(auth.idempotencyKey)
      .digest("hex");
    read.mockResolvedValueOnce(probe).mockResolvedValueOnce("different");
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "normal_resume",
    });
    expect(finish).not.toHaveBeenCalled();
  });
  it("does not replace the memory snapshot without independent backup readback", async () => {
    jest
      .mocked(Sandbox.listSnapshots)
      .mockReturnValue({ hasNext: false, nextItems: async () => [] } as never);
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "backup",
    });
    expect(pause).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
  it("leaves a durable fence after a timeout and never retries reboot", async () => {
    connect.mockRejectedValueOnce(new Error("provider timeout"));
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "reboot",
    });
    state.mockResolvedValue({
      phase: "recovery",
      token: auth.idempotencyKey,
    } as never);
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "fenced",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });
  it("does not publish readiness if final normal reconnection fails", async () => {
    const sandbox = {
      sandboxId: auth.sandboxId,
      commands: { run },
      files: { list, write, read, remove },
      pause,
      createSnapshot: snapshot,
    } as never;
    connect
      .mockResolvedValueOnce(sandbox)
      .mockResolvedValueOnce(sandbox)
      .mockRejectedValueOnce(new Error("reconnect timeout"));
    await expect(recoverE2BDiskOnly(auth, customer)).rejects.toMatchObject({
      stage: "reconnect",
    });
    expect(finish).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ step: "support_required" });
  });
});
