import {
  isOwnedWorkspace,
  reconcileWorkspaceCreation,
  reserveWorkspace,
} from "./cloud-workspace-identity";
import { CloudWorkspaceSelectionRequiredError } from "./cloud-workspace-selection-error";
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
        console.warn("Cloud workspace routing operation failed", {
          event: "cloud_workspace_routing_operation_failed",
          phase,
          ...(inventoryCluster ? { inventory_cluster: inventoryCluster } : {}),
          error_kind:
            CloudWorkspaceUnavailableError.getDiagnosticErrorKind(error),
          request_aborted: signal?.aborted === true,
          user_id: userId.slice(0, 128),
        });
      } catch {
        // Preserve the original exception even if diagnostic output fails.
      }
    }
  };
  const observeCancellation = (
    phase: Parameters<typeof reportOperationFailure>[0],
  ) => {
    // A shared cancellation identifies the active phase, not one regional provider.
    const onAbort = () => reportOperationFailure(phase, signal?.reason);
    try {
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    } catch {
      // Optional diagnostics must not affect cancellation or the operation itself.
    }
    return () => {
      try {
        signal?.removeEventListener("abort", onAbort);
      } catch {
        /* Diagnostics only. */
      }
    };
  };
  const observeOperation = async <T>(
    phase: Parameters<typeof reportOperationFailure>[0],
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    const stopObserving = observeCancellation(phase);
    try {
      return await operation();
    } catch (error) {
      reportOperationFailure(phase, error);
      throw error;
    } finally {
      stopObserving();
    }
  };
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw unavailable("store_unavailable");
    return preferredRegion;
  }
  signal?.throwIfAborted();
  let workspace = await observeOperation("workspace_state_read", () =>
    readCloudWorkspaceState(userId),
  );
  if (workspace?.phase === "provisioning") {
    if (workspace.step === "reserved") return workspace.region;
    const creating = workspace;
    workspace = await observeOperation("workspace_state_read", () =>
      reconcileWorkspaceCreation(userId, creating, signal),
    );
  }
  if (workspace && workspace.phase !== "e2b")
    throw unavailable("workspace_blocked");
  const failed = await observeOperation("recovery_evidence_read", () =>
    readFailures(userId),
  );
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
    if (workspace) {
      signal?.throwIfAborted();
      return region;
    }
  }

  let sandboxId = workspace?.destinationId ?? failed?.sandboxId;
  let selected = authoritative;
  let existingCluster: "us" | "eu" | undefined;
  if (!selected) {
    // Bootstrap legacy accounts from existing inventory, never the current IP.
    // A failed regional read cannot establish that no files exist there.
    const clusters = getConfiguredE2BClustersForCleanup();
    if (clusters.length !== 2) throw unavailable("inventory_unconfigured");
    const { Sandbox } = await observeOperation(
      "inventory_sdk_load",
      () => import("@e2b/code-interpreter"),
    );
    const occupied = await Promise.all(
      clusters.map(async (cluster) => {
        const stopObserving = observeCancellation("inventory_list");
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
          if (list.hasNext) throw unavailable("inventory_incomplete");
          if (items.some((item) => !isOwnedWorkspace(item, cluster, userId)))
            throw unavailable("inventory_owner_mismatch");
          return items.map((item) => ({ item, cluster }));
        } catch (error) {
          // Report here before a sibling can classify a later inventory result.
          reportOperationFailure("inventory_list", error, cluster.cluster);
          throw error;
        } finally {
          stopObserving();
        }
      }),
    );
    const inventory = occupied.flat();
    // A prior region choice identifies a workspace only when that region has
    // exactly one candidate. Never use inventory order or the current IP.
    const preferred =
      saved === null
        ? []
        : inventory.filter(
            ({ cluster }) =>
              cluster.cluster === (saved === "eu-central-1" ? "eu" : "us"),
          );
    const candidates = preferred.length ? preferred : inventory;
    if (candidates.length > 1) {
      unavailable("inventory_multiple_clusters");
      throw new CloudWorkspaceSelectionRequiredError();
    }
    const candidate = candidates[0];
    if (!candidate && saved !== null) {
      // A legacy placement with missing inventory is not proof of a new account.
      throw unavailable("inventory_incomplete");
    }
    existingCluster = candidate?.cluster.cluster;
    sandboxId = candidate?.item.sandboxId;
    selected =
      existingCluster === "eu"
        ? "eu-central-1"
        : existingCluster === "us"
          ? saved === "us-west-2" || preferredRegion === "us-west-2"
            ? "us-west-2"
            : "us-east-1"
          : preferredRegion;
  }
  signal?.throwIfAborted();
  if (!workspace) {
    const binding = await observeOperation("region_binding_claim", () =>
      reserveWorkspace({
        userId,
        region: selected!,
        expectedRegion: saved as string | null,
        sandboxId,
      }),
    );
    signal?.throwIfAborted();
    return binding.region;
  }
  // Older recovered bindings may predate the separate routing key.
  await observeOperation("region_binding_claim", () =>
    redis.set(key, workspace.region, { nx: true }),
  );
  const region = await observeOperation("region_binding_confirm", () =>
    redis.get(key),
  );
  if (!isStoredRegion(region)) throw unavailable("claimed_region_invalid");
  if (region !== workspace.region) throw unavailable("claimed_region_conflict");
  signal?.throwIfAborted();
  return region;
}
