import { createHmac, timingSafeEqual } from "node:crypto";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getActiveTriggerRunsForUser } from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  activityKeyFor,
  cloudWorkspaceRegionKey,
  cloudWorkspaceSelectionHistoryKey,
  cloudWorkspaceStateKey,
  readCloudWorkspaceState,
} from "./cloud-workspace-guard";
import {
  listWorkspaceInventory,
  workspaceBinding,
} from "./cloud-workspace-identity";

export type CloudWorkspaceOption = {
  id: string;
  region: TriggerRunRegion;
  lastStartedAt: string | null;
};
export type CloudWorkspaceOptions =
  | { status: "selected"; id: string; region: TriggerRunRegion }
  | {
      status: "selection_required";
      choices: CloudWorkspaceOption[];
      token: string;
      currentId?: string;
    }
  | {
      status: "waiting";
      reason: "active_tasks" | "recent_activity" | "running_workspace";
    }
  | {
      status: "protected";
      reason: "recovery" | "provisioning" | "cleanup" | "identity";
    }
  | { status: "empty" };

export class WorkspaceOptionsChanged extends Error {}

const isRegion = (value: unknown): value is TriggerRunRegion =>
  value === "us-east-1" || value === "us-west-2" || value === "eu-central-1";

async function inspect(userId: string, manage: boolean, signal?: AbortSignal) {
  const redis = createRedisClient();
  const secret = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!redis || !secret) throw new WorkspaceOptionsChanged();
  const keys = [
    cloudWorkspaceRegionKey(userId),
    cloudWorkspaceStateKey(userId),
    `cloud_resume_failures:v1:${userId}`,
    `cloud_recovery_consent:v1:${userId}`,
    `cloud_workspace_recovery_result:v1:${userId}`,
    activityKeyFor(userId),
  ];
  const [saved, existing, failures, consent, result, activity] =
    await redis.mget<unknown[]>(...keys);
  const finish = (view: CloudWorkspaceOptions) => ({
    redis,
    keys,
    saved,
    existing,
    view,
  });
  if (failures !== null || consent !== null || result !== null)
    return finish({ status: "protected", reason: "recovery" });
  const binding =
    existing === null ? null : await readCloudWorkspaceState(userId);
  if (binding && binding.phase !== "e2b")
    return finish({
      status: "protected",
      reason:
        binding.phase === "provisioning"
          ? "provisioning"
          : binding.phase === "recovery"
            ? "recovery"
            : "cleanup",
    });
  if (
    (existing !== null && !binding) ||
    (binding?.phase === "e2b" && binding.recoveryPending !== undefined) ||
    (saved !== null && !isRegion(saved)) ||
    (binding?.phase === "e2b" && saved !== null && saved !== binding.region)
  )
    return finish({ status: "protected", reason: "identity" });
  if (binding?.phase === "e2b" && !manage)
    return finish({
      status: "selected",
      id: binding.destinationId,
      region: binding.region,
    });

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
    return finish({ status: "waiting", reason: "active_tasks" });
  if (activity !== null)
    return finish({ status: "waiting", reason: "recent_activity" });
  const inventory = await listWorkspaceInventory(userId, signal);
  if (inventory.some(({ item }) => item.state === "running"))
    return finish({ status: "waiting", reason: "running_workspace" });
  if (
    inventory.length > 100 ||
    new Set(inventory.map(({ item }) => item.sandboxId)).size !==
      inventory.length ||
    (binding?.phase === "e2b" &&
      !inventory.some(
        ({ item, cluster }) =>
          item.sandboxId === binding.destinationId &&
          cluster.cluster === (binding.region === "eu-central-1" ? "eu" : "us"),
      ))
  )
    return finish({ status: "protected", reason: "identity" });
  if (!inventory.length)
    return finish(
      saved === null && binding === null
        ? { status: "empty" }
        : { status: "protected", reason: "identity" },
    );
  const choices = inventory
    .map(({ item, cluster }): CloudWorkspaceOption => {
      const started = new Date(String(item.startedAt));
      return {
        id: item.sandboxId,
        region:
          cluster.cluster === "eu"
            ? "eu-central-1"
            : saved === "us-west-2"
              ? "us-west-2"
              : "us-east-1",
        lastStartedAt: Number.isFinite(started.getTime())
          ? started.toISOString()
          : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const token = createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "cloud-workspace-options-v1",
        userId,
        saved,
        existing,
        choices.map(({ id, region }) => ({ id, region })),
      ]),
    )
    .digest("hex");
  return finish({
    status: "selection_required",
    choices,
    token,
    ...(binding?.phase === "e2b" ? { currentId: binding.destinationId } : {}),
  });
}

export async function workspaceOptions(
  userId: string,
  manage = false,
  signal?: AbortSignal,
) {
  return (await inspect(userId, manage, signal)).view;
}

/** Select only a retained identity; never connect, create, reboot or delete a workspace. */
export async function chooseWorkspace(
  userId: string,
  id: string,
  token: string,
  signal?: AbortSignal,
) {
  const { redis, keys, saved, existing, view } = await inspect(
    userId,
    true,
    signal,
  );
  if (
    view.status !== "selection_required" ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(view.token))
  )
    throw new WorkspaceOptionsChanged();
  const choice = view.choices.find((candidate) => candidate.id === id);
  if (!choice) throw new WorkspaceOptionsChanged();
  signal?.throwIfAborted();
  const binding = workspaceBinding(choice.id, choice.region, "selected");
  // Admission's activity marker and the complete previous binding participate in
  // the same CAS. A stale page cannot replace a newer choice or a recovery fence.
  const selected = await redis.eval(
    `
    local function equal(a,b)
      if type(a) ~= type(b) then return false end
      if type(a) ~= 'table' then return a == b end
      for k,v in pairs(a) do if not equal(v,b[k]) then return false end end
      for k in pairs(b) do if a[k] == nil then return false end end
      return true
    end
    for i=3,6 do if redis.call('EXISTS',KEYS[i]) == 1 then return 0 end end
    if (redis.call('GET',KEYS[1]) or '') ~= ARGV[1] then return 0 end
    local raw = redis.call('GET',KEYS[2])
    if ARGV[2] == '' then
      if raw then return 0 end
    else
      local ok,current = pcall(cjson.decode,raw or '')
      local previousOk,previous = pcall(cjson.decode,ARGV[2])
      if not ok or not previousOk or not equal(current,previous) then return 0 end
      redis.call('HSETNX',KEYS[7],current.token,raw)
    end
    redis.call('SET',KEYS[1],ARGV[3])
    redis.call('SET',KEYS[2],ARGV[4])
    return 1`,
    [...keys, cloudWorkspaceSelectionHistoryKey(userId)],
    [
      saved ?? "",
      existing === null ? "" : JSON.stringify(existing),
      choice.region,
      JSON.stringify(binding),
    ],
  );
  if (selected !== 1) throw new WorkspaceOptionsChanged();
  const confirmed = await workspaceOptions(userId);
  if (
    confirmed.status !== "selected" ||
    confirmed.id !== choice.id ||
    confirmed.region !== choice.region
  )
    throw new WorkspaceOptionsChanged();
  return confirmed;
}
