import { randomUUID } from "node:crypto";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";

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
    if ((await redis.set(key, serialized, { nx: true })) !== "OK")
      throw new CloudMigrationUnavailableError();
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
  const state = await readCloudMigrationState(userId);
  if (state && (state.phase === "checking" || provider !== "miosa")) {
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
