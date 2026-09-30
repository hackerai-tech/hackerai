import { createHash, randomUUID } from "node:crypto";
import { Sandbox as E2BSandbox } from "@e2b/code-interpreter";
import type { Sandbox as MiosaSandbox } from "@miosa/sdk";
import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  commitRecoveredE2BWorkspace,
  readCloudMigrationState,
} from "@/lib/ai/tools/utils/cloud-migration-state";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import { miosaExternalUserId } from "@/lib/ai/tools/utils/miosa-identity";
import { waitForMiosaReadiness } from "@/lib/ai/tools/utils/miosa-readiness";
import { createMiosaClient } from "@/lib/ai/tools/utils/miosa-sandbox";
import { transferCommand } from "@/lib/ai/tools/utils/workspace-transfer-program";
import { assertTriggerRunRegion } from "@/lib/api/trigger-region";

// This is a controlled operator task for an already-fenced recovery. Remove it
// after the verified cutover; never offer it as a general migration queue.
const REGION = "us-east-1";
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 9 * 1024 ** 3;
const MAX_WORKSPACE_BYTES = 12 * 1024 ** 3;
const digestPattern = /^[a-f0-9]{64}$/;
const recoverySchema = z.object({
  operation: z.literal("miosa-to-e2b"),
  phase: z.literal("claimed"),
  miosaId: z.string().uuid(),
  e2bId: z.string().min(1),
  ownerRunId: z.string().min(1),
});
const externalFiles = [
  "/usr/share/wordlists/rockyou.txt",
  "/usr/share/android-framework-res/framework-res.apk",
] as const;

type Capture = {
  digest: string;
  homeDigest: string;
  entries: number;
  bytes: number;
  archiveDigest: string;
  archiveBytes: number;
};

function safeCapture(stdout: string): Capture {
  if (stdout.length > 1024) throw new Error("Invalid workspace proof");
  const value = JSON.parse(stdout) as Capture;
  if (
    !digestPattern.test(value.digest) ||
    !digestPattern.test(value.homeDigest) ||
    !digestPattern.test(value.archiveDigest) ||
    !Number.isSafeInteger(value.entries) ||
    value.entries < 1 ||
    value.entries > 250_000 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_WORKSPACE_BYTES ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes < 1 ||
    value.archiveBytes > MAX_ARCHIVE_BYTES
  )
    throw new Error("Invalid workspace proof");
  return value;
}

async function miosaCommand(
  sandbox: MiosaSandbox,
  command: string,
  timeoutSec: number,
): Promise<string> {
  try {
    const result = await sandbox.exec.run(command, { timeoutSec });
    if (result.exitCode !== 0 || result.timedOut || result.stdout.length > 1024)
      throw new Error("Command rejected");
    return result.stdout.trim();
  } catch {
    throw new Error("MIOSA recovery command failed");
  }
}

async function e2bCommand(
  sandbox: E2BSandbox,
  command: string,
  timeoutMs = 60_000,
): Promise<string> {
  try {
    const result = await sandbox.commands.run(command, {
      user: "root",
      cwd: "/",
      timeoutMs,
    });
    if (result.exitCode !== 0 || result.stdout.length > 1024)
      throw new Error("Command rejected");
    return result.stdout.trim();
  } catch {
    throw new Error("E2B recovery command failed");
  }
}

async function copyFile(
  source: MiosaSandbox,
  target: E2BSandbox,
  sourcePath: string,
  destinationPath: string,
  size: number,
  expectedDigest: string,
  chunkPath: string,
) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_ARCHIVE_BYTES ||
    !digestPattern.test(expectedDigest)
  )
    throw new Error("Invalid transfer proof");
  const digest = createHash("sha256");
  let lastLeaseRefresh = Date.now();
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, size - offset);
    const prepare = `/usr/bin/python3 -I -c 'import os; s=open("${sourcePath}","rb"); s.seek(${offset}); b=s.read(${length}); assert len(b)==${length}; f=open("${chunkPath}","wb"); f.write(b); f.close(); s.close()'`;
    await miosaCommand(source, prepare, 90);
    const bytes = await source.files.read(chunkPath);
    if (bytes.length !== length)
      throw new Error("Source chunk length mismatch");
    digest.update(bytes);
    const buffer = Uint8Array.from(bytes).buffer as ArrayBuffer;
    await target.files.write(chunkPath, buffer);
    const append = `/usr/bin/python3 -I -c 'import os; s="${chunkPath}"; d="${destinationPath}"; b=open(s,"rb").read(); assert len(b)==${length}; f=open(d,"r+b" if os.path.exists(d) else "w+b"); f.seek(${offset}); f.write(b); f.truncate(${offset + length}); f.flush(); os.fsync(f.fileno()); f.close(); os.unlink(s)'`;
    await e2bCommand(target, append, 90_000);
    if (Date.now() - lastLeaseRefresh > 3 * 60_000) {
      await target.setTimeout(20 * 60_000);
      lastLeaseRefresh = Date.now();
    }
  }
  if (digest.digest("hex") !== expectedDigest)
    throw new Error("Transfer digest mismatch");
  const targetHash = await e2bCommand(
    target,
    `/usr/bin/sha256sum '${destinationPath}'`,
    12 * 60_000,
  );
  if (targetHash.split(/\s/)[0] !== expectedDigest)
    throw new Error("Destination digest mismatch");
}

async function sourceFileProof(source: MiosaSandbox, path: string) {
  const raw = await miosaCommand(
    source,
    `/usr/bin/python3 -I -c 'import hashlib,json,os; p="${path}"; n=os.path.getsize(p); assert 0<n<=${512 * 1024 ** 2}; h=hashlib.sha256(); f=open(p,"rb"); [h.update(b) for b in iter(lambda:f.read(1048576),b"")]; f.close(); print(json.dumps({"bytes":n,"digest":h.hexdigest()}))'`,
    600,
  );
  const proof = JSON.parse(raw) as { bytes: number; digest: string };
  if (
    !Number.isSafeInteger(proof.bytes) ||
    proof.bytes < 1 ||
    proof.bytes > 512 * 1024 ** 2 ||
    !digestPattern.test(proof.digest)
  )
    throw new Error("Invalid external tool proof");
  return proof;
}

export const recoverMiosaE2BWorkspace = schemaTask({
  id: "recover-miosa-e2b-workspace-2026-09-29",
  schema: z
    .object({
      userId: z.string().regex(/^user_[A-Z0-9]+$/),
      cloneId: z.string().uuid().optional(),
      snapshotId: z.string().uuid().optional(),
      minEntries: z.number().int().positive().max(250_000),
      minBytes: z.number().int().positive().max(MAX_WORKSPACE_BYTES),
    })
    .refine((value) => !!value.cloneId !== !!value.snapshotId),
  queue: { concurrencyLimit: 1 },
  maxDuration: 4 * 60 * 60,
  retry: { maxAttempts: 1 },
  machine: { preset: "small-1x" },
  run: async (
    { userId, cloneId, snapshotId, minEntries, minBytes },
    { ctx },
  ) => {
    if (ctx.environment.type.toLowerCase() !== "production")
      throw new AbortTaskRunError("Recovery is production-only");
    assertTriggerRunRegion({
      requestedRegion: REGION,
      actualRegion: ctx.run.region,
      environmentType: ctx.environment.type,
    });
    if (
      !process.env.MIOSA_API_KEY?.trim() ||
      !process.env.E2B_API_KEY?.trim() ||
      !process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
    )
      throw new AbortTaskRunError("Recovery provider configuration missing");
    const fence = await readCloudMigrationState(userId);
    const recoveryResult = recoverySchema.safeParse(
      fence?.phase === "cleanup"
        ? (fence as typeof fence & { recovery?: Record<string, unknown> })
            .recovery
        : undefined,
    );
    if (!recoveryResult.success)
      throw new AbortTaskRunError("Recovery fence identity mismatch");
    const recovery = recoveryResult.data;
    const miosa = await createMiosaClient(65 * 60_000, 0);
    const original = await miosa.sandboxes.get(recovery.miosaId);
    if (
      original.state !== "paused" ||
      original.data.external_user_id !== miosaExternalUserId(userId)
    )
      throw new AbortTaskRunError(
        "Source identity or preservation state mismatch",
      );
    if (snapshotId) {
      const snapshot = (await original.snapshots.list()).find(
        (candidate) => candidate.id === snapshotId,
      );
      if (snapshot?.status !== "ready")
        throw new AbortTaskRunError("Recovery snapshot is not ready");
    }
    let clone = cloneId
      ? await miosa.sandboxes.get(cloneId)
      : await original.snapshots.restore(snapshotId!);
    const verifiedCloneId = clone.id;
    if (
      clone.id === original.id ||
      clone.data.external_user_id !== original.data.external_user_id ||
      clone.data.template_id !== original.data.template_id
    )
      throw new AbortTaskRunError("Recovery clone identity mismatch");
    if (clone.state === "paused") clone = await clone.resume(randomUUID());
    await waitForMiosaReadiness(clone);
    const stage = `/.hackerai-migration-${randomUUID()}`;
    const capture = safeCapture(
      await miosaCommand(
        clone,
        transferCommand("export", stage, "miosa-to-e2b"),
        60 * 60,
      ),
    );
    if (capture.entries < minEntries || capture.bytes < minBytes)
      throw new Error("Recovery snapshot is missing expected workspace data");
    const verified = JSON.parse(
      await miosaCommand(
        clone,
        transferCommand("verify-source", stage, "miosa-to-e2b"),
        60 * 60,
      ),
    ) as Partial<Capture>;
    if (
      verified.digest !== capture.digest ||
      verified.homeDigest !== capture.homeDigest ||
      verified.entries !== capture.entries ||
      verified.bytes !== capture.bytes
    )
      throw new Error("Source changed during recovery");
    const cluster = getE2BClusterRouting(REGION).createCluster;
    const previousTarget = await E2BSandbox.getInfo(recovery.e2bId, {
      ...cluster.connectionOptions,
    });
    if (
      previousTarget.metadata?.userID !== userId ||
      previousTarget.metadata?.template !== cluster.template ||
      previousTarget.metadata?.e2bCluster !== cluster.cluster ||
      previousTarget.metadata?.sandboxVersion !== "v12"
    )
      throw new AbortTaskRunError("E2B project or customer identity mismatch");
    const target = await E2BSandbox.create(cluster.template, {
      ...cluster.connectionOptions,
      timeoutMs: 20 * 60_000,
      lifecycle: { onTimeout: "pause", autoResume: true },
      secure: true,
      metadata: {
        userID: userId,
        template: cluster.template,
        secure: "true",
        sandboxVersion: "v12",
        e2bCluster: cluster.cluster,
        recoverySourceId: recovery.miosaId,
        recoveryCloneId: verifiedCloneId,
      },
    });
    await e2bCommand(target, `mkdir -m 700 '${stage}'`);
    const chunkPath = "/tmp/hackerai-recovery-chunk";
    await copyFile(
      clone,
      target,
      `${stage}/source.tar.gz`,
      `${stage}/source.tar.gz`,
      capture.archiveBytes,
      capture.archiveDigest,
      chunkPath,
    );
    const restored = JSON.parse(
      await e2bCommand(
        target,
        transferCommand("restore", stage, "miosa-to-e2b"),
        60 * 60_000,
      ),
    ) as { archiveDigest?: string; homeDigest?: string };
    if (
      restored.archiveDigest !== capture.archiveDigest ||
      restored.homeDigest !== capture.homeDigest
    )
      throw new Error("Restored workspace verification failed");
    for (const path of externalFiles) {
      const proof = await sourceFileProof(clone, path);
      await e2bCommand(
        target,
        `mkdir -p '${path.substring(0, path.lastIndexOf("/"))}'`,
      );
      await copyFile(
        clone,
        target,
        path,
        path,
        proof.bytes,
        proof.digest,
        chunkPath,
      );
    }
    await e2bCommand(target, transferCommand("install", stage, "miosa-to-e2b"));
    const home = JSON.parse(
      await e2bCommand(
        target,
        transferCommand("verify-home", stage, "miosa-to-e2b"),
        60 * 60_000,
      ),
    ) as { homeDigest?: string };
    if (home.homeDigest !== capture.homeDigest)
      throw new Error("Installed workspace verification failed");
    await target.pause();
    const resumed = await E2BSandbox.connect(target.sandboxId, {
      ...cluster.connectionOptions,
      timeoutMs: 20 * 60_000,
    });
    const persisted = JSON.parse(
      await e2bCommand(
        resumed,
        transferCommand("verify-home", stage, "miosa-to-e2b"),
        60 * 60_000,
      ),
    ) as { homeDigest?: string };
    if (persisted.homeDigest !== capture.homeDigest)
      throw new Error("Workspace persistence verification failed");
    const info = await E2BSandbox.getInfo(target.sandboxId, {
      ...cluster.connectionOptions,
    });
    if (
      info.metadata?.userID !== userId ||
      info.metadata?.recoverySourceId !== recovery.miosaId ||
      info.metadata?.recoveryCloneId !== verifiedCloneId
    )
      throw new Error("Destination identity mismatch");
    await commitRecoveredE2BWorkspace({
      userId,
      sourceId: recovery.miosaId,
      previousE2BId: recovery.e2bId,
      recoveryOwnerRunId: recovery.ownerRunId,
      destinationId: target.sandboxId,
      region: REGION,
    });
    const pinned = await readCloudMigrationState(userId);
    if (
      pinned?.phase !== "e2b" ||
      pinned.sourceId !== recovery.miosaId ||
      pinned.destinationId !== target.sandboxId ||
      pinned.region !== REGION
    )
      throw new Error("Recovery pin read-back failed");
    return {
      status: "verified_and_pinned",
      destinationId: target.sandboxId,
      entries: capture.entries,
      bytes: capture.bytes,
      archiveBytes: capture.archiveBytes,
    };
  },
});
