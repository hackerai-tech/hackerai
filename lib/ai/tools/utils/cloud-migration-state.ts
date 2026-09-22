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
};

type CleanupState = {
  version: 1;
  phase: "cleanup" | "deleted";
  token: string;
  // Retain the destination pin for crash recovery and failed deletion retries.
  migration?: MigrationState;
  sourceId?: never;
  region?: never;
  destinationId?: never;
};

function isMigrationState(value: MigrationState): boolean {
  return (
    value.version === 1 &&
    ["checking", "miosa"].includes(value.phase) &&
    typeof value.token === "string" &&
    typeof value.sourceId === "string" &&
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
  await assertCloudWorkspaceAvailable(userId, "e2b");
}

export async function readCloudMigrationState(
  userId: string,
): Promise<MigrationState | CleanupState | null> {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudMigrationUnavailableError();
    return null;
  }
  try {
    const value = await redis.get<MigrationState | CleanupState>(
      keyFor(userId),
    );
    if (value === null) return null;
    const valid =
      value.phase === "cleanup" || value.phase === "deleted"
        ? value.version === 1 &&
          typeof value.token === "string" &&
          !!value.token &&
          (value.migration === undefined ||
            (value.migration.phase === "miosa" &&
              isMigrationState(value.migration)))
        : isMigrationState(value as MigrationState);
    if (!valid) {
      throw new CloudMigrationUnavailableError();
    }
    return value;
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
) {
  if (provider === "e2b") {
    const redis = createRedisClient();
    if (!redis) {
      if (process.env.NODE_ENV === "production")
        throw new CloudMigrationUnavailableError();
      return;
    }
    try {
      // Acquiring/renewing E2B use and claiming migration share the same atomic
      // boundary. A checker cannot slip between a state read and SDK use.
      const available = await redis.eval(
        `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call('SET', KEYS[2], 'active', 'EX', ARGV[1]); return 1`,
        [keyFor(userId), activityKeyFor(userId)],
        [String(ACTIVITY_TTL_SECONDS)],
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
    observed?.phase === "miosa"
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
