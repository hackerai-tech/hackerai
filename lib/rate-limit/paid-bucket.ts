import type { Redis } from "@upstash/redis";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Shared by request billing and the Convex usage display. Rejecting a debit
 * must not spend points. Monthly paid cycles and delinquency holds never
 * refill on a timer; only a paid invoice can replace them. Legacy/annual
 * buckets retain their existing 30-day allowance schedule. */
export const PAID_BUCKET_LIMIT_SCRIPT = `
local key = KEYS[1]
local tierMax = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local debit = tonumber(ARGV[4])
local allocation = tonumber(redis.call("HGET", key, "cycleAllocation")) or tierMax
allocation = math.max(0, math.min(tierMax, allocation))
local tokens = tonumber(redis.call("HGET", key, "tokens"))
local refilledAt = tonumber(redis.call("HGET", key, "refilledAt")) or now
local periodEnd = tonumber(redis.call("HGET", key, "billingPeriodEndMs"))
local held = redis.call("HGET", key, "billingTransitionType") == "payment_failed"
if not tokens then tokens = allocation end
tokens = math.max(0, math.min(allocation, tokens))

local reset = periodEnd or (refilledAt + interval)
if not held then
  if periodEnd then
    if now >= periodEnd then tokens = 0 end
  elseif now >= reset then
    refilledAt = refilledAt + math.floor((now - refilledAt) / interval) * interval
    tokens = allocation
    reset = refilledAt + interval
  end
end

local success = debit <= tokens
if success then tokens = tokens - debit end
redis.call("HSET", key, "tokens", tokens, "refilledAt", refilledAt)
if held or periodEnd then
  -- Expiry must not erase a payment hold or let an unpaid monthly cycle
  -- initialize itself at full capacity after inactivity.
  redis.call("PERSIST", key)
else
  redis.call("PEXPIRE", key, math.max(1, reset - now + interval))
end
return {success and 1 or 0, tokens, reset, allocation}
`;

export async function limitPaidBucket(
  redis: Pick<Redis, "eval">,
  storageKey: string,
  tierMax: number,
  debit: number = 0,
  nowMs: number = Date.now(),
) {
  if (!Number.isFinite(debit) || debit < 0) {
    throw new Error("Invalid paid usage debit");
  }
  const [success, remaining, reset, limit] = await redis.eval<
    [number, number, number, number],
    [number, number, number, number]
  >(
    PAID_BUCKET_LIMIT_SCRIPT,
    [storageKey],
    [tierMax, THIRTY_DAYS_MS, nowMs, Math.ceil(debit)],
  );
  return { success: success === 1, remaining, reset, limit };
}
