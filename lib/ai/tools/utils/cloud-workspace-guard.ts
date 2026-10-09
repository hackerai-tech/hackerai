import { randomUUID } from "node:crypto";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import type { Sandbox } from "@e2b/code-interpreter";

type RecoveredWorkspace = {
  version: 1;
  phase: "e2b";
  token: string;
  sourceId: string;
  destinationId: string;
  region: TriggerRunRegion;
  recoveryPending?: unknown;
};
type CleanupState = {
  version: 1;
  phase: "cleanup" | "deleted";
  token: string;
  migration?: RecoveredWorkspace;
};
type WorkspaceState = RecoveredWorkspace | CleanupState;

export class CloudWorkspaceUnavailableError extends Error {
  constructor() {
    super(
      "Cloud workspace needs recovery. Please retry later. Your existing workspace has been preserved.",
    );
    this.name = "CloudWorkspaceUnavailableError";
  }
}

// Keep the persisted key namespace: removing an integration must never grant
// permission to resume a stale source or replace a fenced workspace.
const keyFor = (userId: string) => `cloud_workspace_migration:v1:${userId}`;
const activityKeyFor = (userId: string) =>
  `cloud_workspace_activity:v1:${userId}`;
const ACTIVITY_TTL_SECONDS = 15 * 60;
const e2bUsers = new WeakMap<Sandbox, string>();

function isRecoveredWorkspace(value: unknown): value is RecoveredWorkspace {
  if (!value || typeof value !== "object") return false;
  const state = value as RecoveredWorkspace;
  return (
    state.version === 1 &&
    state.phase === "e2b" &&
    typeof state.token === "string" &&
    !!state.token &&
    typeof state.sourceId === "string" &&
    !!state.sourceId &&
    typeof state.destinationId === "string" &&
    !!state.destinationId &&
    ["us-east-1", "us-west-2", "eu-central-1"].includes(state.region)
  );
}

export async function readCloudWorkspaceState(
  userId: string,
): Promise<WorkspaceState | null> {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudWorkspaceUnavailableError();
    return null;
  }
  try {
    const value = await redis.get<unknown>(keyFor(userId));
    if (value === null) return null;
    if (isRecoveredWorkspace(value)) return value;
    if (value && typeof value === "object") {
      const state = value as CleanupState;
      if (
        state.version === 1 &&
        ["cleanup", "deleted"].includes(state.phase) &&
        typeof state.token === "string" &&
        !!state.token &&
        (state.migration === undefined || isRecoveredWorkspace(state.migration))
      )
        return state;
    }
    // Unknown legacy provider records and malformed records stay fenced.
    throw new CloudWorkspaceUnavailableError();
  } catch {
    throw new CloudWorkspaceUnavailableError();
  }
}

export function registerE2BWorkspaceLease(
  sandbox: Sandbox,
  userId: string,
): void {
  e2bUsers.set(sandbox, userId);
}

export async function refreshE2BWorkspaceLease(
  sandbox: Sandbox,
): Promise<void> {
  const userId = e2bUsers.get(sandbox);
  if (!userId) throw new CloudWorkspaceUnavailableError();
  await assertCloudWorkspaceAvailable(userId, sandbox.sandboxId);
}

export async function assertCloudWorkspaceAvailable(
  userId: string,
  sandboxId?: string,
): Promise<void> {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudWorkspaceUnavailableError();
    return;
  }
  try {
    const available = await redis.eval(
      `local raw = redis.call('GET', KEYS[1]); if raw then local ok, state = pcall(cjson.decode, raw); if not ok or type(state) ~= 'table' or state.version ~= 1 or state.phase ~= 'e2b' or type(state.token) ~= 'string' or state.token == '' or type(state.sourceId) ~= 'string' or state.sourceId == '' or (state.region ~= 'us-east-1' and state.region ~= 'us-west-2' and state.region ~= 'eu-central-1') or type(state.destinationId) ~= 'string' or state.destinationId == '' or state.destinationId ~= ARGV[2] then return 0 end end; redis.call('SET', KEYS[2], 'active', 'EX', ARGV[1]); return 1`,
      [keyFor(userId), activityKeyFor(userId)],
      [String(ACTIVITY_TTL_SECONDS), sandboxId ?? ""],
    );
    if (available !== 1) throw new CloudWorkspaceUnavailableError();
  } catch {
    throw new CloudWorkspaceUnavailableError();
  }
}

/** Fence cleanup before enumerating E2B so another acquisition cannot race it. */
export async function claimCloudWorkspaceCleanup(
  userId: string,
  permanent: boolean,
) {
  const observed = await readCloudWorkspaceState(userId);
  if (
    observed &&
    observed.phase !== "e2b" &&
    !(permanent && observed.phase === "deleted")
  )
    throw new CloudWorkspaceUnavailableError();
  const migration =
    observed?.phase === "e2b"
      ? observed
      : observed?.phase === "deleted"
        ? observed.migration
        : undefined;
  // Unresolved recovery may involve files outside E2B. Do not claim complete
  // account cleanup or remove its persistent record without operator recovery.
  if (migration?.recoveryPending !== undefined)
    throw new CloudWorkspaceUnavailableError();
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudWorkspaceUnavailableError();
    return { migration: null, finish: async (_success: boolean) => {} };
  }
  const state: CleanupState = {
    version: 1,
    phase: "cleanup",
    token: randomUUID(),
    ...(migration && { migration }),
  };
  const serialized = JSON.stringify(state);
  try {
    // Compare the complete record by value: formatting is not ownership, and
    // a concurrent recovery-field update must also invalidate this snapshot.
    const claimed = await redis.eval(
      `local function equal(a, b)
        if type(a) ~= type(b) then return false end
        if type(a) ~= 'table' then return a == b end
        for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
        for k in pairs(b) do if a[k] == nil then return false end end
        return true
      end
      local raw = redis.call('GET', KEYS[1])
      if ARGV[1] == '' then
        if raw then return 0 end
      else
        local currentOk, current = pcall(cjson.decode, raw or '')
        local observedOk, observed = pcall(cjson.decode, ARGV[1])
        if not currentOk or not observedOk or type(current) ~= 'table' or not equal(current, observed) then return 0 end
      end
      redis.call('SET', KEYS[1], ARGV[2]); return 1`,
      [keyFor(userId)],
      [observed ? JSON.stringify(observed) : "", serialized],
    );
    if (claimed !== 1) throw new CloudWorkspaceUnavailableError();
  } catch {
    throw new CloudWorkspaceUnavailableError();
  }
  return {
    migration: migration ?? null,
    finish: async (success: boolean) => {
      const next = permanent
        ? JSON.stringify({
            version: 1,
            phase: "deleted",
            token: state.token,
            ...(!success && migration && { migration }),
          })
        : success || !observed
          ? ""
          : JSON.stringify(observed);
      try {
        const finished = await redis.eval(
          `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end return 1`,
          [keyFor(userId)],
          [serialized, next],
        );
        if (finished !== 1) throw new CloudWorkspaceUnavailableError();
      } catch {
        throw new CloudWorkspaceUnavailableError();
      }
    },
  };
}
