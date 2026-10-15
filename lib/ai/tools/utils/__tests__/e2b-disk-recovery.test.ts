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
import { createHash } from "node:crypto";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { getInfo: jest.fn(), connect: jest.fn() },
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
  expectedApiKeySha256: createHash("sha256").update(key).digest("hex"),
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
  getInfo.mockResolvedValue(info as never);
  claim.mockResolvedValue({ state: {} as never, finish, update } as never);
  finish.mockResolvedValue(undefined);
  update.mockResolvedValue(undefined);
  pause.mockResolvedValue(true);
  snapshot.mockResolvedValue({ snapshotId: "backup-1" });
  run.mockResolvedValue({ exitCode: 0 });
  list.mockResolvedValue([{ name: "synthetic.txt", type: "file", size: 4 }]);
  connect.mockResolvedValue({
    sandboxId: auth.sandboxId,
    commands: { run },
    files: { list },
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
  });

  it.each([
    ["provider_409", Object.assign(new Error("conflict"), { statusCode: 409 })],
    ["timeout", new Error("timeout")],
    [
      "unsupported",
      Object.assign(new Error("unsupported"), { statusCode: 400 }),
    ],
  ])("retains the fence after %s with no retry", async (_, error) => {
    connect.mockRejectedValueOnce(error);
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "reboot",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it("keeps a recoverable fence if snapshot or explicit pause fails", async () => {
    snapshot.mockRejectedValueOnce(new Error("snapshot unavailable"));
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "backup",
    });
    expect(pause).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    snapshot.mockResolvedValue({ snapshotId: "backup-1" });
    pause.mockRejectedValueOnce(new Error("pause failed"));
    await expect(recoverE2BDiskOnly(auth)).rejects.toMatchObject({
      stage: "pause",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "backup_created",
        backupSnapshotId: "backup-1",
      }),
    );
    expect(finish).not.toHaveBeenCalled();
  });

  it("keeps the fence when ordinary resume or metadata verification fails", async () => {
    connect
      .mockResolvedValueOnce({
        sandboxId: auth.sandboxId,
        commands: { run },
        files: { list },
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
