import { randomUUID } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  activityKeyFor,
  assertCloudWorkspaceAvailable,
  cloudWorkspaceRegionKey,
  cloudWorkspaceStateKey,
  CloudWorkspaceUnavailableError,
  readCloudWorkspaceState,
  type ProvisioningWorkspace,
  type RecoveredWorkspace,
} from "./cloud-workspace-guard";
import {
  getConfiguredE2BClustersForCleanup,
  getE2BClusterRouting,
  type E2BClusterConfig,
} from "./e2b-cluster";

export function workspaceBinding(
  sandboxId: string,
  region: TriggerRunRegion,
  origin: NonNullable<RecoveredWorkspace["origin"]>,
  token: string = randomUUID(),
): RecoveredWorkspace {
  return {
    version: 1,
    phase: "e2b",
    token,
    sourceId: sandboxId,
    destinationId: sandboxId,
    region,
    origin,
  };
}

type ListedWorkspace = Awaited<
  ReturnType<ReturnType<typeof Sandbox.list>["nextItems"]>
>[number];

export function isOwnedWorkspace(
  item: ListedWorkspace,
  cluster: E2BClusterConfig,
  userId: string,
) {
  return (
    !!item.sandboxId &&
    ["running", "paused"].includes(item.state) &&
    item.metadata?.userID === userId &&
    item.metadata?.template === cluster.template &&
    (item.metadata?.e2bCluster === cluster.cluster ||
      (cluster.cluster === "us" && item.metadata?.e2bCluster === undefined))
  );
}

/** Complete discovery is required before adoption or first creation. Never wake files. */
export async function listWorkspaceInventory(
  userId: string,
  signal?: AbortSignal,
) {
  const clusters = getConfiguredE2BClustersForCleanup();
  // Missing credentials are an unknown inventory, never evidence of no files.
  if (clusters.length !== 2) throw new CloudWorkspaceUnavailableError();
  return (
    await Promise.all(
      clusters.map(async (cluster) => {
        const pager = Sandbox.list({
          ...cluster.connectionOptions,
          retries: 0,
          requestTimeoutMs: 10_000,
          query: { metadata: { userID: userId }, state: ["running", "paused"] },
        });
        const items: ListedWorkspace[] = [];
        let pages = 0;
        do {
          if (++pages > 100) throw new CloudWorkspaceUnavailableError();
          items.push(...(await pager.nextItems({ signal })));
        } while (pager.hasNext);
        if (items.some((item) => !isOwnedWorkspace(item, cluster, userId)))
          throw new CloudWorkspaceUnavailableError();
        return items.map((item) => ({ item, cluster }));
      }),
    )
  ).flat();
}

/** Atomically pin an existing identity or reserve one first-creation attempt. */
export async function reserveWorkspace(args: {
  userId: string;
  region: TriggerRunRegion;
  expectedRegion: string | null;
  sandboxId?: string;
}) {
  const redis = createRedisClient();
  if (!redis) throw new CloudWorkspaceUnavailableError();
  // This also excludes confirmed recovery and establishes activity before the CAS.
  await assertCloudWorkspaceAvailable(args.userId);
  const next = args.sandboxId
    ? workspaceBinding(args.sandboxId, args.region, "adopted")
    : ({
        version: 1,
        phase: "provisioning",
        step: "reserved",
        token: randomUUID(),
        region: args.region,
      } satisfies ProvisioningWorkspace);
  await redis.eval(
    `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
     local region = redis.call('GET', KEYS[2])
     if (region or '') ~= ARGV[1] or redis.call('EXISTS', KEYS[3]) == 0 then return 0 end
     redis.call('SET', KEYS[1], ARGV[2]); redis.call('SET', KEYS[2], ARGV[3]); return 1`,
    [
      cloudWorkspaceStateKey(args.userId),
      cloudWorkspaceRegionKey(args.userId),
      activityKeyFor(args.userId),
    ],
    [args.expectedRegion ?? "", JSON.stringify(next), args.region],
  );
  const saved = await readCloudWorkspaceState(args.userId);
  if (
    !saved ||
    (saved.phase !== "e2b" && saved.phase !== "provisioning") ||
    (args.sandboxId &&
      (saved.phase !== "e2b" ||
        saved.destinationId !== args.sandboxId ||
        saved.region !== args.region))
  )
    throw new CloudWorkspaceUnavailableError();
  return saved;
}

/** Only the successful reserved -> creating CAS may call Sandbox.create, once. */
export async function startWorkspaceCreation(
  userId: string,
  reserved: ProvisioningWorkspace,
) {
  const redis = createRedisClient();
  if (!redis || reserved.step !== "reserved")
    throw new CloudWorkspaceUnavailableError();
  const creating: ProvisioningWorkspace = { ...reserved, step: "creating" };
  const changed = await redis.eval(
    `local ok, state = pcall(cjson.decode, redis.call('GET', KEYS[1]) or '')
     if not ok or state.version ~= 1 or state.phase ~= 'provisioning' or state.step ~= 'reserved' or state.token ~= ARGV[1] or state.region ~= ARGV[2] then return 0 end
     if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
     redis.call('SET', KEYS[1], ARGV[3]); return 1`,
    [cloudWorkspaceStateKey(userId), cloudWorkspaceRegionKey(userId)],
    [reserved.token, reserved.region, JSON.stringify(creating)],
  );
  if (changed !== 1) throw new CloudWorkspaceUnavailableError();
  return creating;
}

/** Persist even a late provider response. Unknown outcomes retain the creating fence. */
export async function finishWorkspaceCreation(
  userId: string,
  creating: ProvisioningWorkspace,
  sandboxId: string,
) {
  const redis = createRedisClient();
  if (!redis || !sandboxId || creating.step !== "creating")
    throw new CloudWorkspaceUnavailableError();
  const binding = workspaceBinding(
    sandboxId,
    creating.region,
    "created",
    creating.token,
  );
  const changed = await redis.eval(
    `local ok, state = pcall(cjson.decode, redis.call('GET', KEYS[1]) or '')
     if not ok or state.version ~= 1 or state.token ~= ARGV[1] or state.region ~= ARGV[2] then return 0 end
     if state.phase == 'e2b' and state.destinationId == ARGV[3] then return 1 end
     if state.phase ~= 'provisioning' or state.step ~= 'creating' or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
     redis.call('SET', KEYS[1], ARGV[4]); return 1`,
    [cloudWorkspaceStateKey(userId), cloudWorkspaceRegionKey(userId)],
    [creating.token, creating.region, sandboxId, JSON.stringify(binding)],
  );
  if (changed !== 1) throw new CloudWorkspaceUnavailableError();
  return binding;
}

/** A retry may adopt its own completed create, never dispatch another provider create. */
export async function reconcileWorkspaceCreation(
  userId: string,
  creating: ProvisioningWorkspace,
  signal?: AbortSignal,
) {
  let failureReason:
    | "inventory_lookup_failed"
    | "inventory_validation_failed"
    | "inventory_incomplete"
    | "no_matching_workspace"
    | "multiple_matching_workspaces"
    | "workspace_identity_mismatch"
    | "creation_token_mismatch"
    | "request_aborted"
    | "binding_finalize_unconfirmed" = "inventory_lookup_failed";
  try {
    const cluster = getE2BClusterRouting(creating.region).createCluster;
    const pager = Sandbox.list({
      ...cluster.connectionOptions,
      retries: 0,
      requestTimeoutMs: 10_000,
      query: {
        metadata: { userID: userId, workspaceCreationToken: creating.token },
        state: ["running", "paused"],
      },
    });
    const items = await pager.nextItems({ signal });
    failureReason = "inventory_validation_failed";
    const rejection = pager.hasNext
      ? "inventory_incomplete"
      : items.length === 0
        ? "no_matching_workspace"
        : items.length !== 1
          ? "multiple_matching_workspaces"
          : !isOwnedWorkspace(items[0], cluster, userId)
            ? "workspace_identity_mismatch"
            : items[0].metadata?.workspaceCreationToken !== creating.token
              ? "creation_token_mismatch"
              : undefined;
    if (rejection) {
      failureReason = rejection;
      throw new CloudWorkspaceUnavailableError();
    }
    failureReason = "request_aborted";
    signal?.throwIfAborted();
    failureReason = "binding_finalize_unconfirmed";
    return await finishWorkspaceCreation(userId, creating, items[0].sandboxId);
  } catch (error) {
    try {
      const reason =
        failureReason === "inventory_lookup_failed" && signal?.aborted
          ? "request_aborted"
          : failureReason === "binding_finalize_unconfirmed" &&
              error instanceof CloudWorkspaceUnavailableError
            ? "binding_rejected"
            : failureReason;
      // One closed reason per reconciliation; never include inventory, tokens,
      // workspace identities or provider/store error contents.
      console.warn("Cloud workspace creation reconciliation failed", {
        event: "cloud_workspace_creation_reconcile_failed",
        reason,
      });
    } catch {
      // Diagnostics must not replace the original rejection or retry a commit.
    }
    throw error;
  }
}
