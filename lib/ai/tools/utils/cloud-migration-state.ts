import { randomUUID } from "node:crypto";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import type { Sandbox } from "@e2b/code-interpreter";

type MigrationState = {
  version: 1;
  phase: "checking" | "miosa";
  token: string;
  sourceId: string;
  region: TriggerRunRegion;
  // File migrations pin an exact verified destination. Never recreate it empty.
  destinationId?: string;
  // Optional for legacy records. An attempt, not just a run, owns the fence:
  // a retry must not mistake a previous crashed attempt for a live migration.
  owner?: { runId: string; attempt: number };
};

/** Exact E2B destination: restored files, or a fresh workspace with recoveryPending. */
export type RecoveredE2BState = {
  version: 1;
  phase: "e2b";
  token: string;
  sourceId: string;
  destinationId: string;
  region: TriggerRunRegion;
  // A fresh fallback restores execution, not files. Retain the entire previous
  // fence so recovery can reconcile both workspaces without overwriting either.
  recoveryPending?: MigrationState | CleanupState;
};

type CleanupState = {
  version: 1;
  phase: "cleanup" | "deleted";
  token: string;
  // Retain the destination pin for crash recovery and failed deletion retries.
  migration?: MigrationState | RecoveredE2BState;
  sourceId?: never;
  region?: never;
  destinationId?: never;
  recovery?: {
    operation: string;
    miosaId?: string;
    [key: string]: unknown;
  };
};

export type CloudMigrationState =
  MigrationState | RecoveredE2BState | CleanupState;

export function canUseFreshE2BFallback(state: CloudMigrationState): boolean {
  return (
    ((state.phase === "checking" || state.phase === "miosa") &&
      !!state.sourceId) ||
    (state.phase === "cleanup" &&
      state.recovery?.operation === "miosa-to-e2b" &&
      typeof state.recovery.miosaId === "string" &&
      !!state.recovery.miosaId)
  );
}

/** Atomically replace only the observed migration fence. Older migration jobs
 * lose their compare-and-set ownership; the original files remain untouched. */
export async function pinFreshE2BFallback(options: {
  userId: string;
  observed: CloudMigrationState;
  destinationId: string;
  region: TriggerRunRegion;
}): Promise<boolean> {
  if (!canUseFreshE2BFallback(options.observed))
    throw new CloudMigrationUnavailableError();
  const redis = createRedisClient();
  if (!redis) throw new CloudMigrationUnavailableError();
  const sourceId =
    options.observed.phase === "checking" || options.observed.phase === "miosa"
      ? options.observed.sourceId
      : options.observed.phase === "cleanup"
        ? options.observed.recovery!.miosaId!
        : "";
  const next: RecoveredE2BState = {
    version: 1,
    phase: "e2b",
    token: randomUUID(),
    sourceId,
    destinationId: options.destinationId,
    region: options.region,
    recoveryPending: options.observed as MigrationState | CleanupState,
  };
  try {
    return (
      (await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2]); return 1`,
        [keyFor(options.userId)],
        [JSON.stringify(options.observed), JSON.stringify(next)],
      )) === 1
    );
  } catch {
    throw new CloudMigrationUnavailableError();
  }
}

function isRecoveredE2BState(value: RecoveredE2BState): boolean {
  return (
    value.version === 1 &&
    value.phase === "e2b" &&
    typeof value.token === "string" &&
    !!value.token &&
    typeof value.sourceId === "string" &&
    !!value.sourceId &&
    typeof value.destinationId === "string" &&
    !!value.destinationId &&
    ["us-east-1", "us-west-2", "eu-central-1"].includes(value.region)
  );
}

function isMigrationState(value: MigrationState): boolean {
  return (
    value.version === 1 &&
    ["checking", "miosa"].includes(value.phase) &&
    typeof value.token === "string" &&
    typeof value.sourceId === "string" &&
    (value.owner === undefined ||
      (typeof value.owner?.runId === "string" &&
        value.owner.runId.startsWith("run_") &&
        Number.isInteger(value.owner.attempt) &&
        value.owner.attempt > 0)) &&
    (value.destinationId === undefined ||
      (typeof value.destinationId === "string" && !!value.destinationId)) &&
    ["us-east-1", "us-west-2"].includes(value.region)
  );
}

export class CloudMigrationUnavailableError extends Error {
  constructor() {
    super(
      "Cloud workspace migration needs recovery. Please retry later. Your existing workspace has been preserved.",
    );
    this.name = "CloudMigrationUnavailableError";
  }
}

const keyFor = (userId: string) => `cloud_workspace_migration:v1:${userId}`;
const activityKeyFor = (userId: string) =>
  `cloud_workspace_activity:v1:${userId}`;
// Longer than one maximum terminal command and the E2B auto-pause tail.
const ACTIVITY_TTL_SECONDS = 15 * 60;
const e2bUsers = new WeakMap<Sandbox, string>();

export function registerE2BMigrationLease(sandbox: Sandbox, userId: string) {
  e2bUsers.set(sandbox, userId);
}

export async function refreshE2BMigrationLease(sandbox: Sandbox) {
  const userId = e2bUsers.get(sandbox);
  if (!userId) throw new CloudMigrationUnavailableError();
  await assertCloudWorkspaceAvailable(userId, "e2b", sandbox.sandboxId);
}

export async function readCloudMigrationState(
  userId: string,
): Promise<MigrationState | RecoveredE2BState | CleanupState | null> {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudMigrationUnavailableError();
    return null;
  }
  try {
    const value = await redis.get<
      MigrationState | RecoveredE2BState | CleanupState
    >(keyFor(userId));
    if (value === null) return null;
    const valid =
      value.phase === "cleanup" || value.phase === "deleted"
        ? value.version === 1 &&
          typeof value.token === "string" &&
          !!value.token &&
          (value.migration === undefined ||
            (value.migration.phase === "e2b"
              ? isRecoveredE2BState(value.migration)
              : value.migration.phase === "miosa" &&
                isMigrationState(value.migration)))
        : value.phase === "e2b"
          ? isRecoveredE2BState(value)
          : isMigrationState(value as MigrationState);
    if (!valid) {
      throw new CloudMigrationUnavailableError();
    }
    return value;
  } catch {
    throw new CloudMigrationUnavailableError();
  }
}

/** Complete the one-way recovery only after the destination's files and
 * pause/resume behavior have been verified. The existing cleanup fence stays
 * in place if another operator changes it or any check fails. */
export async function commitRecoveredE2BWorkspace(options: {
  userId: string;
  sourceId: string;
  previousE2BId: string;
  recoveryOwnerRunId: string;
  destinationId: string;
  region: TriggerRunRegion;
}) {
  const redis = createRedisClient();
  if (!redis) throw new CloudMigrationUnavailableError();
  const state: RecoveredE2BState = {
    version: 1,
    phase: "e2b",
    token: randomUUID(),
    sourceId: options.sourceId,
    destinationId: options.destinationId,
    region: options.region,
  };
  try {
    const committed = await redis.eval(
      `local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end; local ok, old = pcall(cjson.decode, raw); if not ok or type(old) ~= 'table' or old.version ~= 1 or old.phase ~= 'cleanup' or type(old.recovery) ~= 'table' or old.recovery.operation ~= 'miosa-to-e2b' or old.recovery.phase ~= 'claimed' or old.recovery.miosaId ~= ARGV[1] or old.recovery.e2bId ~= ARGV[2] or old.recovery.ownerRunId ~= ARGV[3] then return 0 end; redis.call('SET', KEYS[1], ARGV[4]); return 1`,
      [keyFor(options.userId)],
      [
        options.sourceId,
        options.previousE2BId,
        options.recoveryOwnerRunId,
        JSON.stringify(state),
      ],
    );
    if (committed !== 1) throw new CloudMigrationUnavailableError();
  } catch {
    throw new CloudMigrationUnavailableError();
  }
}

/** A durable fence, not an expiring lease: a crashed checker needs recovery,
 * never automatic permission for a second writer on the old filesystem. */
export async function claimCloudMigration(
  userId: string,
  sourceId: string,
  region: TriggerRunRegion,
  owner?: MigrationState["owner"],
) {
  const redis = createRedisClient();
  if (!redis) throw new CloudMigrationUnavailableError();
  const key = keyFor(userId);
  const state: MigrationState = {
    version: 1,
    phase: "checking",
    token: randomUUID(),
    sourceId,
    region,
    ...(owner && { owner }),
  };
  const serialized = JSON.stringify(state);
  try {
    const claimed = await redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end redis.call('SET', KEYS[1], ARGV[1]); return 1`,
      [key, activityKeyFor(userId)],
      [serialized],
    );
    if (claimed !== 1) return null;
  } catch {
    throw new CloudMigrationUnavailableError();
  }
  return {
    token: state.token,
    // Compare the full original value so a stale checker cannot undo recovery.
    abandon: async () => {
      const removed = await redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
        [key],
        [serialized],
      );
      if (removed !== 1) throw new CloudMigrationUnavailableError();
    },
    commit: async (destinationId?: string) => {
      const committed = await redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 1 end return 0`,
        [key],
        [
          serialized,
          JSON.stringify({
            ...state,
            phase: "miosa",
            ...(destinationId && { destinationId }),
          }),
        ],
      );
      if (committed !== 1) throw new CloudMigrationUnavailableError();
      // No TTL: once Miosa can accept writes, neither flag rollback nor a
      // later acquisition failure may silently expose the retained E2B copy.
    },
  };
}

export async function assertCloudWorkspaceAvailable(
  userId: string,
  provider: "e2b" | "miosa",
  sandboxId?: string,
) {
  if (provider === "e2b") {
    const redis = createRedisClient();
    if (!redis) {
      if (process.env.NODE_ENV === "production")
        throw new CloudMigrationUnavailableError();
      return;
    }
    try {
      // Older workers reject every migration key. New workers may only renew
      // an exact, verified E2B pin; a checking/cleanup state remains fenced.
      const available = await redis.eval(
        `local raw = redis.call('GET', KEYS[1]); if raw then local ok, state = pcall(cjson.decode, raw); if not ok or type(state) ~= 'table' or state.phase ~= 'e2b' or type(state.destinationId) ~= 'string' or state.destinationId == '' or state.destinationId ~= ARGV[2] then return 0 end end; redis.call('SET', KEYS[2], 'active', 'EX', ARGV[1]); return 1`,
        [keyFor(userId), activityKeyFor(userId)],
        [String(ACTIVITY_TTL_SECONDS), sandboxId ?? ""],
      );
      if (available !== 1) throw new CloudMigrationUnavailableError();
      return;
    } catch {
      throw new CloudMigrationUnavailableError();
    }
  }
  const state = await readCloudMigrationState(userId);
  if (state && state.phase !== "miosa") {
    throw new CloudMigrationUnavailableError();
  }
}

/** Own the migration key before enumerating either provider. Older workers also
 * reject this key, so they cannot claim after cleanup's provider snapshot. */
export async function claimCloudWorkspaceCleanup(
  userId: string,
  permanent: boolean,
) {
  const observed = await readCloudMigrationState(userId);
  if (
    observed &&
    observed.phase !== "miosa" &&
    observed.phase !== "e2b" &&
    !(permanent && observed.phase === "deleted")
  ) {
    throw new CloudMigrationUnavailableError();
  }
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudMigrationUnavailableError();
    // Local provider cleanup remains usable without Redis; migration cannot
    // claim at all in that configuration.
    return { migration: null, finish: async (_success: boolean) => {} };
  }
  const key = keyFor(userId);
  const migration =
    observed?.phase === "miosa" || observed?.phase === "e2b"
      ? observed
      : observed?.phase === "deleted"
        ? (observed.migration ?? null)
        : null;
  const state: CleanupState = {
    version: 1,
    phase: "cleanup",
    token: randomUUID(),
    ...(migration && { migration }),
  };
  const serialized = JSON.stringify(state);
  try {
    const claimed = await redis.eval(
      `if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2]); return 1`,
      [key],
      [observed ? JSON.stringify(observed) : "", serialized],
    );
    if (claimed !== 1) throw new CloudMigrationUnavailableError();
  } catch {
    throw new CloudMigrationUnavailableError();
  }
  return {
    migration,
    finish: async (success: boolean) => {
      // Account deletion never grants queued jobs permission again, including
      // after partial provider failure. A later deletion attempt may retry.
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
          [key],
          [serialized, next],
        );
        if (finished !== 1) throw new CloudMigrationUnavailableError();
      } catch {
        throw new CloudMigrationUnavailableError();
      }
    },
  };
}
