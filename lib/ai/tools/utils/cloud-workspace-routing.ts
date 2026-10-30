import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { readFailures } from "@/lib/cloud-recovery/store";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  CloudWorkspaceUnavailableError,
  cloudWorkspaceRegionKey,
  readCloudWorkspaceState,
} from "./cloud-workspace-guard";
import { getConfiguredE2BClustersForCleanup } from "./e2b-cluster";

function storedRegion(value: unknown): TriggerRunRegion {
  if (
    value !== "us-east-1" &&
    value !== "us-west-2" &&
    value !== "eu-central-1"
  )
    throw new CloudWorkspaceUnavailableError();
  return value;
}

/** Geolocation chooses initial placement only. Never migrate or wake a workspace. */
export async function resolveCloudWorkspaceRegion({
  userId,
  preferredRegion,
  signal,
}: {
  userId: string;
  preferredRegion: TriggerRunRegion;
  signal?: AbortSignal;
}): Promise<TriggerRunRegion> {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudWorkspaceUnavailableError();
    return preferredRegion;
  }
  signal?.throwIfAborted();
  const workspace = await readCloudWorkspaceState(userId);
  if (workspace && workspace.phase !== "e2b")
    throw new CloudWorkspaceUnavailableError();
  const failed = process.env.CLOUD_DISK_RECOVERY_TARGETS
    ? await readFailures(userId)
    : null;
  if (
    workspace &&
    failed &&
    (workspace.region !== failed.region ||
      workspace.destinationId !== failed.sandboxId)
  )
    throw new CloudWorkspaceUnavailableError();
  const authoritative = workspace?.region ?? failed?.region;
  const key = cloudWorkspaceRegionKey(userId);
  const saved = await redis.get(key);
  if (saved !== null) {
    const region = storedRegion(saved);
    if (authoritative && authoritative !== region)
      throw new CloudWorkspaceUnavailableError();
    signal?.throwIfAborted();
    return region;
  }

  let selected = authoritative;
  let existingCluster: "us" | "eu" | undefined;
  if (!selected) {
    // Bootstrap legacy accounts from existing inventory, never the current IP.
    // A failed regional read cannot establish that no files exist there.
    const clusters = getConfiguredE2BClustersForCleanup();
    if (!clusters.length) throw new CloudWorkspaceUnavailableError();
    const { Sandbox } = await import("@e2b/code-interpreter");
    const occupied = await Promise.all(
      clusters.map(async (cluster) => {
        const list = Sandbox.list({
          ...cluster.connectionOptions,
          retries: 0,
          requestTimeoutMs: 10_000,
          query: { metadata: { userID: userId }, state: ["running", "paused"] },
        });
        const items = await list.nextItems({ signal });
        if (items.some((item) => item.metadata?.userID !== userId))
          throw new CloudWorkspaceUnavailableError();
        if (!items.length && list.hasNext)
          throw new CloudWorkspaceUnavailableError();
        return items.length ? cluster.cluster : null;
      }),
    );
    const regions = occupied.filter((region) => region !== null);
    // There is no honest automatic choice between two existing file stores.
    if (regions.length > 1) throw new CloudWorkspaceUnavailableError();
    existingCluster = regions[0] ?? undefined;
    selected =
      regions[0] === "eu"
        ? "eu-central-1"
        : regions[0] === "us"
          ? preferredRegion === "us-west-2"
            ? "us-west-2"
            : "us-east-1"
          : preferredRegion;
  }
  signal?.throwIfAborted();
  // First admission wins even when simultaneous requests arrive from two regions.
  // No TTL: expiration must never send a returning user to another file store.
  await redis.set(key, selected, { nx: true });
  const region = storedRegion(await redis.get(key));
  if (
    (authoritative && authoritative !== region) ||
    (existingCluster &&
      existingCluster !== (region === "eu-central-1" ? "eu" : "us"))
  )
    throw new CloudWorkspaceUnavailableError();
  signal?.throwIfAborted();
  return region;
}
