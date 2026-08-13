import { createRedisClient } from "@/lib/rate-limit/redis";

const TEAM_SEAT_OPERATION_LOCK_TTL_SECONDS = 60;
const TEAM_SEAT_OPERATION_LOCK_RENEW_INTERVAL_MS = 15 * 1000;

const RENEW_TEAM_SEAT_OPERATION_LOCK_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]
local ttl = ARGV[2]

if redis.call("GET", key) == token then
  return redis.call("EXPIRE", key, ttl)
end

return 0
`;

const RELEASE_TEAM_SEAT_OPERATION_LOCK_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]

if redis.call("GET", key) == token then
  return redis.call("DEL", key)
end

return 0
`;

export class TeamSeatOperationLockUnavailableError extends Error {
  constructor() {
    super("Team seat operation locking is unavailable");
    this.name = "TeamSeatOperationLockUnavailableError";
  }
}

export type TeamSeatOperationLock = {
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
};

export async function acquireTeamSeatOperationLock(
  organizationId: string,
): Promise<TeamSeatOperationLock | null> {
  const redis = createRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return { assertOwned: async () => {}, release: async () => {} };
    }
    throw new TeamSeatOperationLockUnavailableError();
  }

  const lockKey = `team_seat_operation_lock:${organizationId}`;
  const lockToken = crypto.randomUUID();
  let acquired: string | null;

  try {
    acquired = await redis.set(lockKey, lockToken, {
      nx: true,
      ex: TEAM_SEAT_OPERATION_LOCK_TTL_SECONDS,
    });
  } catch {
    throw new TeamSeatOperationLockUnavailableError();
  }

  if (acquired !== "OK") return null;

  let released = false;
  let renewalFailure: TeamSeatOperationLockUnavailableError | null = null;
  let renewalInFlight: Promise<void> | null = null;

  const renew = async () => {
    if (released) return;
    try {
      const renewed = await redis.eval(
        RENEW_TEAM_SEAT_OPERATION_LOCK_SCRIPT,
        [lockKey],
        [lockToken, String(TEAM_SEAT_OPERATION_LOCK_TTL_SECONDS)],
      );
      if (renewed !== 1) throw new TeamSeatOperationLockUnavailableError();
    } catch {
      renewalFailure = new TeamSeatOperationLockUnavailableError();
      throw renewalFailure;
    }
  };

  const startRenewal = () => {
    if (released || renewalInFlight) return;
    renewalInFlight = renew()
      .catch(() => {})
      .finally(() => {
        renewalInFlight = null;
      });
  };
  const renewalTimer = setInterval(
    startRenewal,
    TEAM_SEAT_OPERATION_LOCK_RENEW_INTERVAL_MS,
  );

  return {
    assertOwned: async () => {
      if (renewalFailure) throw renewalFailure;
      if (renewalInFlight) await renewalInFlight;
      if (renewalFailure) throw renewalFailure;
      await renew();
    },
    release: async () => {
      if (released) return;
      clearInterval(renewalTimer);
      if (renewalInFlight) await renewalInFlight.catch(() => {});
      await redis.eval(
        RELEASE_TEAM_SEAT_OPERATION_LOCK_SCRIPT,
        [lockKey],
        [lockToken],
      );
      released = true;
    },
  };
}
