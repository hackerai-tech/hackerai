import { createHmac } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { getActiveTriggerRunsForUser } from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";
import { getConfiguredE2BClustersForCleanup } from "./e2b-cluster";
import { isRecoverableE2BSandboxVersion } from "./e2b-sandbox-version";
import { cloudWorkspaceRegionKey } from "./cloud-workspace-guard";

export type WorkspaceRegionChoice = "us-east-1" | "eu-central-1";
export type WorkspaceRegionView =
  | { status: "selected"; region: string }
  | {
      status: "selection_required";
      token: string;
      choices: WorkspaceRegionChoice[];
    };

export class WorkspaceSelectionUnavailable extends Error {}

const guardKeys = (userId: string) => [
  `cloud_workspace_migration:v1:${userId}`,
  `cloud_resume_failures:v1:${userId}`,
  `cloud_recovery_consent:v1:${userId}`,
  `cloud_workspace_recovery_result:v1:${userId}`,
];

async function inspectSelection(userId: string) {
  const redis = createRedisClient();
  const secret = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!redis || !secret) throw new WorkspaceSelectionUnavailable();
  const keys = guardKeys(userId);
  const [saved, ...guards] = await redis.mget<unknown[]>(
    cloudWorkspaceRegionKey(userId),
    ...keys,
  );
  if (guards.some((value) => value !== null))
    throw new WorkspaceSelectionUnavailable();
  if (saved !== null) {
    if (!["us-east-1", "us-west-2", "eu-central-1"].includes(String(saved)))
      throw new WorkspaceSelectionUnavailable();
    return {
      redis,
      keys,
      view: { status: "selected", region: String(saved) } as const,
    };
  }
  const [parents, children] = await Promise.all([
    getActiveTriggerRunsForUser({ userId }),
    listActiveSubagentsForUser(userId),
  ]);
  if (
    parents.hasMore ||
    children.hasMore ||
    parents.runs.length ||
    children.runs.length
  )
    throw new WorkspaceSelectionUnavailable();
  const clusters = getConfiguredE2BClustersForCleanup();
  if (
    clusters.length !== 2 ||
    new Set(clusters.map((c) => c.cluster)).size !== 2
  )
    throw new WorkspaceSelectionUnavailable();
  const candidates = await Promise.all(
    clusters.map(async (cluster) => {
      const pager = Sandbox.list({
        ...cluster.connectionOptions,
        retries: 0,
        requestTimeoutMs: 10_000,
        query: { metadata: { userID: userId }, state: ["running", "paused"] },
      });
      const items = await pager.nextItems();
      // Only a complete, unambiguous pair is eligible for self-service selection.
      // More complex inventories and running workspaces stay with support.
      if (pager.hasNext || items.length !== 1)
        throw new WorkspaceSelectionUnavailable();
      const item = items[0];
      if (
        item.state !== "paused" ||
        item.metadata?.userID !== userId ||
        item.metadata?.e2bCluster !== cluster.cluster ||
        item.metadata?.template !== cluster.template ||
        !isRecoverableE2BSandboxVersion(item.metadata?.sandboxVersion)
      )
        throw new WorkspaceSelectionUnavailable();
      return {
        region:
          cluster.cluster === "eu"
            ? ("eu-central-1" as const)
            : ("us-east-1" as const),
        id: item.sandboxId,
      };
    }),
  );
  candidates.sort((a, b) => a.region.localeCompare(b.region));
  const token = createHmac("sha256", secret)
    .update(
      JSON.stringify(["cloud-workspace-selection-v1", userId, candidates]),
    )
    .digest("hex");
  return {
    redis,
    keys,
    view: {
      status: "selection_required",
      token,
      choices: candidates.map((c) => c.region),
    } as const,
  };
}

export async function workspaceRegionView(
  userId: string,
): Promise<WorkspaceRegionView> {
  return (await inspectSelection(userId)).view;
}

export async function selectWorkspaceRegion(
  userId: string,
  region: WorkspaceRegionChoice,
  token: string,
) {
  const { redis, keys, view } = await inspectSelection(userId);
  // An uncertain POST can be reconciled with GET; it must never move an existing binding.
  if (
    view.status !== "selection_required" ||
    view.token !== token ||
    !view.choices.includes(region)
  )
    throw new WorkspaceSelectionUnavailable();
  const selected = await redis.eval(
    `for i = 2, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
     if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
     redis.call('SET', KEYS[1], ARGV[1], 'NX')
     return 1`,
    [cloudWorkspaceRegionKey(userId), ...keys],
    [region],
  );
  if (selected !== 1) throw new WorkspaceSelectionUnavailable();
  const saved = await redis.get(cloudWorkspaceRegionKey(userId));
  if (saved !== region) throw new WorkspaceSelectionUnavailable();
  return { status: "selected" as const, region };
}
