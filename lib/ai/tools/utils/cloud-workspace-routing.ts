import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { readFailures } from "@/lib/cloud-recovery/store";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  CloudWorkspaceUnavailableError,
  cloudWorkspaceRegionKey,
  readCloudWorkspaceState,
} from "./cloud-workspace-guard";
import { getConfiguredE2BClustersForCleanup } from "./e2b-cluster";

function isStoredRegion(value: unknown): value is TriggerRunRegion {
  return (
    value === "us-east-1" || value === "us-west-2" || value === "eu-central-1"
  );
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
  let reportedFailure = false;
  const unavailable = (
    reason:
      | "store_unavailable"
      | "workspace_blocked"
      | "recovery_evidence_conflict"
      | "stored_region_invalid"
      | "stored_region_conflict"
      | "inventory_unconfigured"
      | "inventory_owner_mismatch"
      | "inventory_incomplete"
      | "inventory_multiple_clusters"
      | "claimed_region_invalid"
      | "claimed_region_conflict",
  ): CloudWorkspaceUnavailableError => {
    // Parallel inventory checks share one bounded, content-free diagnostic.
    if (!reportedFailure) {
      reportedFailure = true;
      try {
        console.warn("Cloud workspace routing unavailable", {
          event: "cloud_workspace_routing_unavailable",
          reason,
          user_id: userId.slice(0, 128),
        });
      } catch {
        // Diagnostics must never change the workspace protection decision.
      }
    }
    return new CloudWorkspaceUnavailableError();
  };
  const reportOperationFailure = (
    phase:
      | "workspace_state_read"
      | "recovery_evidence_read"
      | "region_binding_read"
      | "inventory_sdk_load"
      | "inventory_list"
      | "region_binding_claim"
      | "region_binding_confirm",
    error: unknown,
    inventoryCluster?: "us" | "eu",
  ): void => {
    // Only the first failed operation owns attribution, including parallel lists.
    if (!reportedFailure) {
      reportedFailure = true;
      try {
        const errorName =
          error instanceof Error ||
          (typeof DOMException !== "undefined" && error instanceof DOMException)
            ? error.name
            : undefined;
        console.warn("Cloud workspace routing operation failed", {
          event: "cloud_workspace_routing_operation_failed",
          phase,
          ...(inventoryCluster ? { inventory_cluster: inventoryCluster } : {}),
          error_kind:
            errorName === "TimeoutError"
              ? "timeout"
              : errorName === "AbortError"
                ? "abort"
                : "other",
          request_aborted: signal?.aborted === true,
          user_id: userId.slice(0, 128),
        });
      } catch {
        // Preserve the original exception even if diagnostic output fails.
      }
    }
  };
  const observeOperation = async <T>(
    phase: Parameters<typeof reportOperationFailure>[0],
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      reportOperationFailure(phase, error);
      throw error;
    }
  };
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw unavailable("store_unavailable");
    return preferredRegion;
  }
  signal?.throwIfAborted();
  const workspace = await observeOperation("workspace_state_read", () =>
    readCloudWorkspaceState(userId),
  );
  if (workspace && workspace.phase !== "e2b")
    throw unavailable("workspace_blocked");
  const failed = process.env.CLOUD_DISK_RECOVERY_TARGETS
    ? await observeOperation("recovery_evidence_read", () =>
        readFailures(userId),
      )
    : null;
  if (
    workspace &&
    failed &&
    (workspace.region !== failed.region ||
      workspace.destinationId !== failed.sandboxId)
  )
    throw unavailable("recovery_evidence_conflict");
  const authoritative = workspace?.region ?? failed?.region;
  const key = cloudWorkspaceRegionKey(userId);
  const saved = await observeOperation("region_binding_read", () =>
    redis.get(key),
  );
  if (saved !== null) {
    if (!isStoredRegion(saved)) throw unavailable("stored_region_invalid");
    const region = saved;
    if (authoritative && authoritative !== region)
      throw unavailable("stored_region_conflict");
    signal?.throwIfAborted();
    return region;
  }

  let selected = authoritative;
  let existingCluster: "us" | "eu" | undefined;
  if (!selected) {
    // Bootstrap legacy accounts from existing inventory, never the current IP.
    // A failed regional read cannot establish that no files exist there.
    const clusters = getConfiguredE2BClustersForCleanup();
    if (!clusters.length) throw unavailable("inventory_unconfigured");
    const { Sandbox } = await observeOperation(
      "inventory_sdk_load",
      () => import("@e2b/code-interpreter"),
    );
    const occupied = await Promise.all(
      clusters.map(async (cluster) => {
        try {
          const list = Sandbox.list({
            ...cluster.connectionOptions,
            retries: 0,
            requestTimeoutMs: 10_000,
            query: {
              metadata: { userID: userId },
              state: ["running", "paused"],
            },
          });
          const items = await list.nextItems({ signal });
          if (items.some((item) => item.metadata?.userID !== userId))
            throw unavailable("inventory_owner_mismatch");
          if (!items.length && list.hasNext)
            throw unavailable("inventory_incomplete");
          return items.length ? cluster.cluster : null;
        } catch (error) {
          // Report here before a sibling can classify a later inventory result.
          reportOperationFailure("inventory_list", error, cluster.cluster);
          throw error;
        }
      }),
    );
    const regions = occupied.filter((region) => region !== null);
    // There is no honest automatic choice between two existing file stores.
    if (regions.length > 1) throw unavailable("inventory_multiple_clusters");
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
  await observeOperation("region_binding_claim", () =>
    redis.set(key, selected, { nx: true }),
  );
  const region = await observeOperation("region_binding_confirm", () =>
    redis.get(key),
  );
  if (!isStoredRegion(region)) throw unavailable("claimed_region_invalid");
  if (
    (authoritative && authoritative !== region) ||
    (existingCluster &&
      existingCluster !== (region === "eu-central-1" ? "eu" : "us"))
  )
    throw unavailable("claimed_region_conflict");
  signal?.throwIfAborted();
  return region;
}
