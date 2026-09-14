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
};

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
): Promise<MigrationState | null> {
  const redis = createRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV === "production")
      throw new CloudMigrationUnavailableError();
    return null;
  }
  try {
    const value = await redis.get<MigrationState>(keyFor(userId));
    if (value === null) return null;
    if (
      value.version !== 1 ||
      !["checking", "miosa"].includes(value.phase) ||
      typeof value.token !== "string" ||
      typeof value.sourceId !== "string" ||
      !["us-east-1", "us-west-2"].includes(value.region)
    ) {
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
    // Compare the full original value so a stale checker cannot undo recovery.
    abandon: async () => {
      const removed = await redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
        [key],
        [serialized],
      );
      if (removed !== 1) throw new CloudMigrationUnavailableError();
    },
    commit: async () => {
      const committed = await redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 1 end return 0`,
        [key],
        [serialized, JSON.stringify({ ...state, phase: "miosa" })],
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
  if (state?.phase === "checking") {
    throw new CloudMigrationUnavailableError();
  }
}

/** Only call after both providers confirm the user's explicit workspace reset. */
export async function clearCloudMigrationAfterReset(
  userId: string,
  observed: MigrationState,
) {
  const redis = createRedisClient();
  if (!redis) throw new CloudMigrationUnavailableError();
  const removed = await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
    [keyFor(userId)],
    [JSON.stringify(observed)],
  );
  if (removed !== 1) throw new CloudMigrationUnavailableError();
}
