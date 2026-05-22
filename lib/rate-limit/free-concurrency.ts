import { ChatSDKError } from "@/lib/errors";
import { FREE_RUN_LOCK_TTL_SECONDS } from "./free-config";
import { createRedisClient } from "./redis";

const RELEASE_FREE_RUN_LOCK_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]

if redis.call("GET", key) == token then
  return redis.call("DEL", key)
end

return 0
`;

export type FreeRunConcurrencyLock = {
  release: () => Promise<void>;
  rateLimitSkipped?: boolean;
};

const freeRunLockKey = (userId: string) => `free_run_lock:${userId}`;

export async function acquireFreeRunConcurrencyLock(
  userId: string,
  ttlSeconds = FREE_RUN_LOCK_TTL_SECONDS,
): Promise<FreeRunConcurrencyLock> {
  const redis = createRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        rateLimitSkipped: true,
        release: async () => {},
      };
    }
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  }

  const lockKey = freeRunLockKey(userId);
  const lockToken = crypto.randomUUID();
  const acquired = await redis.set(lockKey, lockToken, {
    nx: true,
    ex: Math.max(1, Math.trunc(ttlSeconds)),
  });

  if (acquired !== "OK") {
    throw new ChatSDKError(
      "rate_limit:chat",
      "You already have a free request running. Please wait for it to finish before starting another one.",
    );
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await redis.eval(RELEASE_FREE_RUN_LOCK_SCRIPT, [lockKey], [lockToken]);
    },
  };
}
