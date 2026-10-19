import { createHmac, timingSafeEqual } from "node:crypto";
import { Sandbox, type SandboxInfo } from "@e2b/code-interpreter";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getE2BClusterRouting } from "./e2b-cluster";
import {
  claimE2BDiskRecovery,
  readCloudWorkspaceState,
  readE2BDiskRecoveryResult,
} from "./cloud-workspace-guard";

export const REBOOT_REQUEST_TIMEOUT_MS = 300_000;
const VERIFICATION_TIMEOUT_MS = 30_000;
const WORKSPACE_PATH = "/home/user";
const INTENT = "I accept loss of running processes and unflushed writes";
const KEY_PROOF_CONTEXT = "hackerai-e2b-disk-recovery-target-v1";

export type DiskRecoveryAuthorization = {
  version: 1;
  environment: "preview" | "production";
  operatorId: string;
  idempotencyKey: string;
  userId: string;
  sandboxId: string;
  region: TriggerRunRegion;
  e2bAccount: string;
  e2bProject: string;
  expectedApiKeyHmacSha256: string;
  expectedRedisHost: string;
  expectedConvexUrl: string;
  expectedTemplate: string;
  expectedSandboxVersion: string;
  intent: typeof INTENT;
  trafficQuiesced: true;
};

export class DiskRecoveryError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DiskRecoveryError";
  }
}

const hmac = (key: string, value: string) =>
  createHmac("sha256", key).update(value).digest("hex");
const matchesHmac = (actual: string, expected: string) =>
  timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

export function validateDiskRecoveryAuthorization(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): DiskRecoveryAuthorization {
  if (!raw || typeof raw !== "object")
    throw new DiskRecoveryError(
      "authorization",
      "Invalid authorization record",
    );
  const value = raw as Record<string, unknown>;
  const strings = [
    "operatorId",
    "idempotencyKey",
    "userId",
    "sandboxId",
    "e2bAccount",
    "e2bProject",
    "expectedRedisHost",
    "expectedConvexUrl",
    "expectedTemplate",
    "expectedSandboxVersion",
  ];
  if (
    value.version !== 1 ||
    strings.some(
      (key) => typeof value[key] !== "string" || !(value[key] as string).trim(),
    ) ||
    !["preview", "production"].includes(value.environment as string) ||
    !["us-east-1", "us-west-2", "eu-central-1"].includes(
      value.region as string,
    ) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.idempotencyKey as string,
    ) ||
    value.intent !== INTENT ||
    value.trafficQuiesced !== true ||
    typeof value.expectedApiKeyHmacSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.expectedApiKeyHmacSha256)
  )
    throw new DiskRecoveryError(
      "authorization",
      "Incomplete or invalid authorization record",
    );
  const auth = value as DiskRecoveryAuthorization;
  const key =
    auth.region === "eu-central-1" ? env.E2B_EU_API_KEY : env.E2B_API_KEY;
  const redisUrl = env.UPSTASH_REDIS_REST_URL;
  if (
    !key ||
    !redisUrl ||
    !env.UPSTASH_REDIS_REST_TOKEN ||
    !matchesHmac(hmac(key, KEY_PROOF_CONTEXT), auth.expectedApiKeyHmacSha256) ||
    new URL(redisUrl).host !== auth.expectedRedisHost ||
    env.NEXT_PUBLIC_CONVEX_URL !== auth.expectedConvexUrl ||
    env.HACKERAI_ENVIRONMENT !== auth.environment
  )
    throw new DiskRecoveryError(
      "authorization",
      "Runtime environment does not match the authorized target",
    );
  return auth;
}

function assertIdentity(
  info: SandboxInfo,
  auth: DiskRecoveryAuthorization,
): void {
  const cluster = getE2BClusterRouting(auth.region).createCluster;
  if (
    info.sandboxId !== auth.sandboxId ||
    info.state !== "paused" ||
    info.metadata?.userID !== auth.userId ||
    info.metadata?.e2bCluster !== cluster.cluster ||
    info.metadata?.template !== auth.expectedTemplate ||
    info.metadata?.sandboxVersion !== auth.expectedSandboxVersion
  )
    throw new DiskRecoveryError(
      "identity",
      "Paused sandbox identity or region changed",
    );
}

async function observeWorkspace(
  sandbox: Sandbox,
  key: string,
): Promise<{ count: number; metadataHmacSha256: string }> {
  const command = await sandbox.commands.run("true", {
    timeoutMs: VERIFICATION_TIMEOUT_MS,
    requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
  });
  if (command.exitCode !== 0)
    throw new DiskRecoveryError("readiness", "Harmless command failed");
  const entries = await sandbox.files.list(WORKSPACE_PATH, {
    requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
  });
  if (entries.length > 1000)
    throw new DiskRecoveryError(
      "inventory",
      "Top-level inventory exceeds safe bound",
    );
  const metadata = entries
    .map(({ name, type, size, modifiedTime }) => ({
      name,
      type,
      size,
      modifiedTime: modifiedTime?.toISOString() ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    count: entries.length,
    metadataHmacSha256: hmac(key, JSON.stringify(metadata)),
  };
}

export async function recoverE2BDiskOnly(
  auth: DiskRecoveryAuthorization,
  customer?: { consentKey: string; assertIdle: () => Promise<void> },
): Promise<Record<string, unknown>> {
  // Enforce authorization even if a future caller bypasses the CLI.
  validateDiskRecoveryAuthorization(auth);
  const existingResult = await readE2BDiskRecoveryResult(auth.userId);
  if (
    existingResult &&
    typeof existingResult === "object" &&
    (existingResult as { token?: string }).token === auth.idempotencyKey
  ) {
    if (
      (existingResult as { status?: string }).status !== "verified_paused" ||
      (existingResult as { sandboxId?: string }).sandboxId !== auth.sandboxId ||
      (existingResult as { region?: string }).region !== auth.region
    )
      throw new DiskRecoveryError(
        "idempotency",
        "Stored result does not match the authorized sandbox",
      );
    return existingResult as Record<string, unknown>;
  }
  const state = await readCloudWorkspaceState(auth.userId);
  if (state?.phase === "recovery")
    throw new DiskRecoveryError(
      "fenced",
      "Recovery is already fenced; inspect provider state before any continuation",
    );
  const cluster = getE2BClusterRouting(auth.region).createCluster;
  const fingerprintKey =
    auth.region === "eu-central-1"
      ? process.env.E2B_EU_API_KEY!
      : process.env.E2B_API_KEY!;
  const connectionOptions = cluster.connectionOptions ?? {};
  const getInfo = () =>
    Sandbox.getInfo(auth.sandboxId, {
      ...connectionOptions,
      requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
    });
  const assertTarget = async () => {
    const info = await getInfo();
    assertIdentity(info, auth);
    if (
      customer &&
      (info.lifecycle?.autoResume !== false ||
        info.lifecycle?.onTimeout !== "pause")
    )
      throw new DiskRecoveryError(
        "traffic",
        "Inbound auto-resume cannot be safely isolated",
      );
    // Unknown extra metadata can encode a preservation hold or provider action.
    if (
      customer &&
      Object.keys(info.metadata ?? {}).some(
        (key) =>
          ![
            "userID",
            "e2bCluster",
            "template",
            "sandboxVersion",
            "secure",
          ].includes(key),
      )
    )
      throw new DiskRecoveryError(
        "preservation",
        "Workspace requires operator review",
      );
  };
  await assertTarget();
  if (customer) await customer.assertIdle();
  const claim = await claimE2BDiskRecovery({
    userId: auth.userId,
    sandboxId: auth.sandboxId,
    region: auth.region,
    token: auth.idempotencyKey,
    operatorId: auth.operatorId,
    ...(customer && {
      customerConsent: { key: customer.consentKey, token: auth.idempotencyKey },
    }),
  });
  let stage = "identity";
  try {
    // Recheck after fencing: never reboot a sandbox that was started by
    // inbound auto-resume or a connection already in flight.
    await assertTarget();
    if (customer) await customer.assertIdle();
    stage = "reboot";
    const sandbox = await Sandbox.connect(auth.sandboxId, {
      ...connectionOptions,
      onResume: "reboot",
      requestTimeoutMs: REBOOT_REQUEST_TIMEOUT_MS,
      timeoutMs: 30 * 60 * 1000,
    });
    if (sandbox.sandboxId !== auth.sandboxId)
      throw new DiskRecoveryError(
        stage,
        "Provider returned a different sandbox",
      );
    await claim.update({ step: "reboot_connected" });
    stage = "inventory";
    const probePath = `/home/user/.hackerai-recovery-${auth.idempotencyKey}`;
    const probe = hmac(fingerprintKey, auth.idempotencyKey);
    if (customer) {
      // The random path is exclusive to this attempt. Test only our own bytes.
      await sandbox.files.write(probePath, probe, {
        requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
      });
      if (
        (await sandbox.files.read(probePath, {
          requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
        })) !== probe
      )
        throw new DiskRecoveryError(
          "file_access",
          "Recovery probe readback failed",
        );
    }
    const observed = await observeWorkspace(sandbox, fingerprintKey);
    await claim.update({ step: "inventory_observed", ...observed });
    stage = "backup";
    // A separate ready-state snapshot is required before replacing the
    // paused memory snapshot. Its ID is retained in the operator result.
    const backup = await sandbox.createSnapshot({
      requestTimeoutMs: REBOOT_REQUEST_TIMEOUT_MS,
    });
    if (customer) {
      if (!backup.snapshotId)
        throw new DiskRecoveryError(
          "backup",
          "Provider did not return a backup receipt",
        );
      const backups = Sandbox.listSnapshots({
        ...connectionOptions,
        sandboxId: auth.sandboxId,
        requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
      });
      let found = false;
      let pages = 0;
      do {
        if (++pages > 10)
          throw new DiskRecoveryError(
            "backup",
            "Backup inventory exceeds safe bound",
          );
        found = (await backups.nextItems()).some(
          (item) => item.snapshotId === backup.snapshotId,
        );
      } while (!found && backups.hasNext);
      if (!found)
        throw new DiskRecoveryError(
          "backup",
          "Backup could not be independently verified",
        );
    }
    await claim.update({
      step: "backup_created",
      backupSnapshotId: backup.snapshotId,
    });
    stage = "pause";
    if (!(await sandbox.pause({ requestTimeoutMs: REBOOT_REQUEST_TIMEOUT_MS })))
      throw new DiskRecoveryError(
        stage,
        "Provider did not confirm a new snapshot",
      );
    if ((await getInfo()).state !== "paused")
      throw new DiskRecoveryError(stage, "Pause state could not be verified");
    if (customer) await assertTarget();
    await claim.update({ step: "recovered_state_paused" });
    stage = "normal_resume";
    const resumed = await Sandbox.connect(auth.sandboxId, {
      ...connectionOptions,
      requestTimeoutMs: REBOOT_REQUEST_TIMEOUT_MS,
      timeoutMs: 30 * 60 * 1000,
    });
    if (customer && resumed.sandboxId !== auth.sandboxId)
      throw new DiskRecoveryError(
        "normal_resume",
        "Provider returned a different sandbox",
      );
    if (
      customer &&
      (await resumed.files.read(probePath, {
        requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
      })) !== probe
    )
      throw new DiskRecoveryError(
        "file_persistence",
        "Recovery probe did not persist across normal resume",
      );
    const after = await observeWorkspace(resumed, fingerprintKey);
    if (after.metadataHmacSha256 !== observed.metadataHmacSha256)
      throw new DiskRecoveryError(
        stage,
        "Top-level file metadata changed after normal resume",
      );
    await claim.update({ step: "normal_resume_verified" });
    if (customer)
      await resumed.files.remove(probePath, {
        requestTimeoutMs: VERIFICATION_TIMEOUT_MS,
      });
    stage = "final_pause";
    if (!(await resumed.pause({ requestTimeoutMs: REBOOT_REQUEST_TIMEOUT_MS })))
      throw new DiskRecoveryError(
        stage,
        "Provider did not confirm a final snapshot",
      );
    if ((await getInfo()).state !== "paused")
      throw new DiskRecoveryError(
        stage,
        "Final pause state could not be verified",
      );
    if (customer) await assertTarget();
    await claim.update({ step: "final_state_paused" });
    const result = {
      token: auth.idempotencyKey,
      status: "verified_paused",
      sandboxId: auth.sandboxId,
      region: auth.region,
      entryCount: observed.count,
      metadataHmacSha256: observed.metadataHmacSha256,
      backupSnapshotId: backup.snapshotId,
      completedAt: new Date().toISOString(),
    };
    stage = "release";
    await claim.finish(JSON.stringify(result));
    return result;
  } catch (error) {
    if (customer)
      await claim.update({ step: "support_required" }).catch(() => {});
    // This fence intentionally has no TTL. A timed-out SDK call can still
    // finish provider-side, and automatic retries could discard more state.
    let fence: "retained" | "unknown" = "unknown";
    try {
      const completed = await readE2BDiskRecoveryResult(auth.userId);
      if (
        stage === "release" &&
        completed &&
        typeof completed === "object" &&
        (completed as { token?: string }).token === auth.idempotencyKey &&
        (completed as { status?: string }).status === "verified_paused" &&
        (completed as { sandboxId?: string }).sandboxId === auth.sandboxId &&
        (completed as { region?: string }).region === auth.region
      )
        return completed as Record<string, unknown>;
      const current = await readCloudWorkspaceState(auth.userId);
      if (
        current?.phase === "recovery" &&
        current.token === auth.idempotencyKey
      )
        fence = "retained";
    } catch {
      // A failed readback must never be described as a confirmed fence.
    }
    throw new DiskRecoveryError(
      stage,
      fence === "retained"
        ? "Recovery stopped; durable fence retained. Inspect the exact sandbox before manual continuation"
        : "Recovery stopped; fence status uncertain. Inspect Redis and the exact sandbox before any continuation",
      {
        fence,
        providerStatus:
          error && typeof error === "object" && "statusCode" in error
            ? (error as { statusCode: unknown }).statusCode
            : undefined,
        reason: error instanceof Error ? error.name : "unknown",
      },
    );
  }
}
