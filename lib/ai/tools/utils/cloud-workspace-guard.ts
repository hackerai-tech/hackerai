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
export type RecoveryState = {
  version: 1;
  phase: "recovery";
  token: string;
  operatorId: string;
  sandboxId: string;
  region: TriggerRunRegion;
  startedAt: string;
  previous: RecoveredWorkspace | null;
  step?: string;
  backupSnapshotId?: string;
  entryCount?: number;
  metadataHmacSha256?: string;
};
type WorkspaceState = RecoveredWorkspace | CleanupState | RecoveryState;

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
const recoveryResultKeyFor = (userId: string) =>
  `cloud_workspace_recovery_result:v1:${userId}`;
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

function isRecoveryState(value: unknown): value is RecoveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as RecoveryState;
  return (
    state.version === 1 &&
    state.phase === "recovery" &&
    typeof state.token === "string" &&
    !!state.token &&
    typeof state.operatorId === "string" &&
    !!state.operatorId &&
    typeof state.sandboxId === "string" &&
    !!state.sandboxId &&
    ["us-east-1", "us-west-2", "eu-central-1"].includes(state.region) &&
    typeof state.startedAt === "string" &&
    !!state.startedAt &&
    (state.step === undefined || typeof state.step === "string") &&
    (state.backupSnapshotId === undefined ||
      typeof state.backupSnapshotId === "string") &&
    (state.entryCount === undefined || typeof state.entryCount === "number") &&
    (state.metadataHmacSha256 === undefined ||
      typeof state.metadataHmacSha256 === "string") &&
    (state.previous === null || isRecoveredWorkspace(state.previous))
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
    if (isRecoveryState(value)) return value;
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

/**
 * A durable, non-expiring fence. An interrupted provider call can complete
 * after the caller has timed out, so only an operator may resolve this state.
 * The activity key must have expired before claiming, which drains ordinary
 * lease heartbeats and recent acquisitions before the reboot starts.
 */
export async function claimE2BDiskRecovery(args: {
  userId: string;
  sandboxId: string;
  region: TriggerRunRegion;
  token: string;
  operatorId: string;
  customerConsent?: { key: string; token: string };
}): Promise<{
  state: RecoveryState;
  update: (
    progress: Pick<
      RecoveryState,
      "step" | "backupSnapshotId" | "entryCount" | "metadataHmacSha256"
    >,
  ) => Promise<void>;
  finish: (result: string) => Promise<void>;
}> {
  const redis = createRedisClient();
  if (!redis) throw new CloudWorkspaceUnavailableError();
  const previous = await readCloudWorkspaceState(args.userId);
  if (
    previous &&
    (previous.phase !== "e2b" ||
      previous.destinationId !== args.sandboxId ||
      previous.region !== args.region ||
      previous.recoveryPending !== undefined ||
      (args.customerConsent &&
        Object.keys(previous).some(
          (key) =>
            ![
              "version",
              "phase",
              "token",
              "sourceId",
              "destinationId",
              "region",
            ].includes(key),
        )))
  )
    throw new CloudWorkspaceUnavailableError();
  const state: RecoveryState = {
    version: 1,
    phase: "recovery",
    token: args.token,
    operatorId: args.operatorId,
    sandboxId: args.sandboxId,
    region: args.region,
    startedAt: new Date().toISOString(),
    previous,
  };
  let serialized = JSON.stringify(state);
  // Compare the complete prior record and require no recent normal activity.
  // A different owner, malformed record, or cleanup fence is never overwritten.
  const claimed = await redis.eval(
    `local raw = redis.call('GET', KEYS[1]);
     if ARGV[4] ~= '' then
       local consentRaw = redis.call('GET', KEYS[4]);
       local ok, consent = pcall(cjson.decode, consentRaw or '')
       if not ok or consent.token ~= ARGV[4] or consent.status ~= 'confirmed' or consent.target.sandboxId ~= ARGV[5] or consent.target.region ~= ARGV[6] then return 0 end
     end
     if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
     local last = redis.call('GET', KEYS[3]);
     if last then local ok, result = pcall(cjson.decode, last); if not ok or type(result) ~= 'table' or type(result.token) ~= 'string' or result.status ~= 'verified_paused' or result.token == ARGV[3] then return 0 end end
     if ARGV[1] == '' then if raw then return 0 end
     else
       local function equal(a, b)
         if type(a) ~= type(b) then return false end
         if type(a) ~= 'table' then return a == b end
         for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
         for k in pairs(b) do if a[k] == nil then return false end end
         return true
       end
       local ok, current = pcall(cjson.decode, raw or '')
       local expectedOk, expected = pcall(cjson.decode, ARGV[1])
       if not ok or not expectedOk or not equal(current, expected) then return 0 end
     end
     if ARGV[4] ~= '' then local consent = cjson.decode(redis.call('GET', KEYS[4])); consent.status = 'executing'; redis.call('SET', KEYS[4], cjson.encode(consent)) end
     redis.call('SET', KEYS[1], ARGV[2]); return 1`,
    [
      keyFor(args.userId),
      activityKeyFor(args.userId),
      recoveryResultKeyFor(args.userId),
      ...(args.customerConsent ? [args.customerConsent.key] : []),
    ],
    [
      previous ? JSON.stringify(previous) : "",
      serialized,
      args.token,
      args.customerConsent?.token ?? "",
      args.sandboxId,
      args.region,
    ],
  );
  if (claimed !== 1) throw new CloudWorkspaceUnavailableError();
  return {
    state,
    update: async (progress) => {
      const next = JSON.stringify({ ...state, ...progress });
      const updated = await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2]); return 1`,
        [keyFor(args.userId)],
        [serialized, next],
      );
      if (updated !== 1) throw new CloudWorkspaceUnavailableError();
      Object.assign(state, progress);
      serialized = next;
    },
    finish: async (result: string) => {
      const finished = await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
         redis.call('SET', KEYS[2], ARGV[3]);
         if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
         return 1`,
        [keyFor(args.userId), recoveryResultKeyFor(args.userId)],
        [
          serialized,
          previous
            ? JSON.stringify(previous)
            : args.customerConsent
              ? JSON.stringify({
                  version: 1,
                  phase: "e2b",
                  token: args.token,
                  sourceId: args.sandboxId,
                  destinationId: args.sandboxId,
                  region: args.region,
                })
              : "",
          result,
        ],
      );
      if (finished !== 1) throw new CloudWorkspaceUnavailableError();
    },
  };
}

export async function readE2BDiskRecoveryResult(
  userId: string,
): Promise<unknown> {
  const redis = createRedisClient();
  if (!redis) throw new CloudWorkspaceUnavailableError();
  return redis.get(recoveryResultKeyFor(userId));
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
