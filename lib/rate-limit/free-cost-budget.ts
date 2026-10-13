import { ChatSDKError } from "@/lib/errors";
import { getLimitPressureContext } from "@/lib/limit-pressure";
import { FREE_AGENT_DAILY_COST_DOLLARS } from "@/lib/experiments/free-agent-budget";
import type { FreeLimitPolicy } from "./free-config";
import {
  checkFreeMonthlyCostLimit,
  type FreeMonthlyCostSnapshot,
} from "./free-monthly-cost";
import { createRedisClient } from "./redis";
import { POINTS_PER_DOLLAR } from "./token-bucket";

// Keep the original day's ledger through the maximum durable wait/run lifetime.
// Revalidation and settlement must never switch an in-flight run to tomorrow's quota.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const keyFor = (subject: string, bucket: string) =>
  `free_agent_daily_cost:${subject}:${bucket}`;

export async function checkFreeCostBudget(
  subject: string,
  policy?: FreeLimitPolicy,
): Promise<FreeMonthlyCostSnapshot> {
  const window = policy?.agentDailyBudget;
  if (!window) return checkFreeMonthlyCostLimit(subject, policy);
  if (Date.now() >= window.resetTimestamp)
    throw new ChatSDKError(
      "rate_limit:chat",
      "This Agent run's daily allowance window has ended. Start a new Agent request to use today's allowance.",
      {
        subscription: "free",
        resetTimestamp: window.resetTimestamp,
        capReason: "free_daily_cost_exhausted",
        ...getLimitPressureContext({
          subscription: "free",
          capReason: "free_daily_cost_exhausted",
        }),
      },
    );
  const redis = createRedisClient();
  if (!redis && process.env.NODE_ENV === "production")
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service is not configured",
    );
  const limit = Math.ceil(FREE_AGENT_DAILY_COST_DOLLARS * POINTS_PER_DOLLAR);
  const rawUsed = redis
    ? Number((await redis.get(keyFor(subject, window.bucket))) ?? 0)
    : 0;
  if (!Number.isFinite(rawUsed) || rawUsed < 0)
    throw new ChatSDKError(
      "rate_limit:chat",
      "Rate limiting service returned invalid usage",
    );
  const remaining = Math.max(0, limit - rawUsed);
  if (remaining <= 0)
    throw new ChatSDKError(
      "rate_limit:chat",
      "You've used today's free Agent allowance. It resets at midnight UTC. Upgrade for higher limits.",
      {
        subscription: "free",
        resetTimestamp: window.resetTimestamp,
        capReason: "free_daily_cost_exhausted",
        ...getLimitPressureContext({
          subscription: "free",
          capReason: "free_daily_cost_exhausted",
        }),
      },
    );
  return {
    monthlyLimitPoints: limit,
    monthlyRemainingAtStart: remaining,
    monthlyResetTime: new Date(window.resetTimestamp),
    capReasonOnExhaustion: "free_daily_cost_exhausted",
    budgetPeriod: "daily",
    extraUsageEnabledAtStart: false,
    extraUsageHasBalanceAtStart: false,
    extraUsageBalanceAtStart: 0,
    extraUsageAutoReload: false,
    ...(!redis && { rateLimitSkipped: true }),
  };
}

const SETTLE_DAILY_COST = `
local daily = tonumber(redis.call("GET", KEYS[1]) or "0")
local monthly = tonumber(redis.call("GET", KEYS[2]) or "0")
local previous = tonumber(redis.call("GET", KEYS[3]) or "0")
if not daily or not monthly or not previous or daily < 0 or monthly < 0 or previous < 0 or daily ~= math.floor(daily) or monthly ~= math.floor(monthly) or previous ~= math.floor(previous) then
  return redis.error_reply("Invalid free cost ledger")
end
local target = tonumber(ARGV[1])
if target <= previous then return previous end
local delta = target - previous
redis.call("INCRBY", KEYS[1], delta)
redis.call("PEXPIREAT", KEYS[1], ARGV[2])
local monthly = redis.call("INCRBY", KEYS[2], delta)
if monthly == delta then redis.call("PEXPIREAT", KEYS[2], ARGV[3]) end
redis.call("SET", KEYS[3], target)
redis.call("PEXPIREAT", KEYS[3], ARGV[2])
return target
`;

/** Cumulative settlement is atomic across daily, monthly and per-attempt ledgers.
 * Retrying a write after a lost Redis response must not double-charge the run.
 */
export class FreeDailyCostSettlement {
  settledPoints = 0;
  constructor(
    private readonly subject: string,
    private readonly policy: FreeLimitPolicy,
    private readonly settlementId: string,
  ) {}

  async settle(totalCostDollars: number): Promise<void> {
    if (!Number.isFinite(totalCostDollars) || totalCostDollars < 0)
      throw new Error("Invalid Free Agent settlement cost");
    const window = this.policy.agentDailyBudget;
    if (!window) throw new Error("Daily settlement requires a daily budget");
    const target = Math.ceil(totalCostDollars * POINTS_PER_DOLLAR);
    if (target <= this.settledPoints) return;
    const redis = createRedisClient();
    if (!redis) {
      if (process.env.NODE_ENV === "production")
        throw new Error("Rate limiting service is not configured");
      return;
    }
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const monthReset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const result = Number(
      await redis.eval(
        SETTLE_DAILY_COST,
        [
          keyFor(this.subject, window.bucket),
          `free_monthly_cost:${this.subject}:${month}`,
          `free_agent_daily_settlement:${this.subject}:${this.settlementId}`,
        ],
        [target, window.resetTimestamp + RETENTION_MS, monthReset],
      ),
    );
    if (!Number.isFinite(result) || result < target)
      throw new Error("Invalid Free Agent settlement result");
    this.settledPoints = Math.max(this.settledPoints, result);
  }
}
