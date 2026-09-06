import "server-only";

import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import { POINTS_PER_DOLLAR } from "./token-bucket";
import { createRedisClient } from "./redis";
import type { LimitCapReason } from "@/lib/limit-pressure";

/**
 * Paid daily free allowance.
 *
 * One rule, no flags: any paid plan that has exhausted its included monthly
 * usage may keep working on the low-cost model, up to this much provider
 * cost per UTC day. There is no per-day request cap; the cost cap is the
 * only limit and the mid-run budget monitor cuts a run off when it is hit.
 * Ask and Agent share the same daily pool.
 */
export const PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD_DEFAULT = 0.25;

/**
 * Reserve one rescue request. Only the cost cap is enforced. The request
 * counter is still incremented so analytics can report how many rescue
 * requests a user made in a day.
 */
const RESERVE_PAID_DAILY_FREE_ALLOWANCE_SCRIPT = `
local requestKey = KEYS[1]
local costKey = KEYS[2]
local costLimit = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

local currentRequests = tonumber(redis.call("GET", requestKey) or "0")
local currentCost = tonumber(redis.call("GET", costKey) or "0")

if currentCost >= costLimit then
  return {0, "cost_limit_reached", currentRequests, currentCost}
end

local nextRequests = redis.call("INCRBY", requestKey, 1)
if nextRequests == 1 then
  redis.call("PEXPIRE", requestKey, ttlMs)
end

if redis.call("EXISTS", costKey) == 0 then
  redis.call("SET", costKey, currentCost, "PX", ttlMs)
else
  redis.call("PEXPIRE", costKey, ttlMs)
end

return {1, "ok", nextRequests, currentCost}
`;

const RECORD_PAID_DAILY_FREE_ALLOWANCE_COST_SCRIPT = `
local costKey = KEYS[1]
local costPoints = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

if costPoints <= 0 then
  return tonumber(redis.call("GET", costKey) or "0")
end

local nextCost = redis.call("INCRBY", costKey, costPoints)
redis.call("PEXPIRE", costKey, ttlMs)
return nextCost
`;

export type PaidDailyFreeAllowanceUnavailableReason =
  | "unsupported_model"
  | "unsupported_subscription"
  | "not_monthly_exhausted"
  | "attachments_not_supported"
  | "redis_unavailable"
  | "cost_limit_reached";

export interface PaidDailyFreeAllowanceStatus {
  type: "paid_daily_free_allowance";
  available: boolean;
  /** Rescue requests started today (analytics only, never a limit). */
  requestsUsed: number;
  costLimitDollars: number;
  costUsedDollars: number;
  costRemainingDollars: number;
  costLimitPoints: number;
  costUsedPoints: number;
  costRemainingPoints: number;
  resetTime: Date;
  resetTimestamp: number;
  unavailableReason?: PaidDailyFreeAllowanceUnavailableReason;
  rateLimitSkipped?: boolean;
}

export interface PaidDailyFreeAllowanceReservation {
  allowed: boolean;
  status: PaidDailyFreeAllowanceStatus;
  blockReason?: PaidDailyFreeAllowanceUnavailableReason;
}

export type PaidDailyFreeAllowanceCostRecordResult =
  | {
      recorded: true;
      costPoints: number;
      costDollars: number;
      nextCostPoints: number;
      nextCostDollars: number;
    }
  | {
      recorded: false;
      costPoints: number;
      costDollars: number;
      unavailableReason: "redis_unavailable";
    };

export type PaidDailyFreeAllowanceMetadata = {
  type: "paid_daily_free_allowance";
  available: boolean;
  requestsUsed: number;
  costLimitDollars: number;
  costUsedDollars: number;
  costRemainingDollars: number;
  resetTimestamp: number;
  unavailableReason?: PaidDailyFreeAllowanceUnavailableReason;
  rateLimitSkipped?: boolean;
};

type PaidDailyFreeAllowanceContext = {
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  capReason?: LimitCapReason;
  hasAttachments?: boolean;
  /**
   * The user's explicit model choice. The rescue always runs on the
   * low-cost model, so it is only offered when the user is on Auto;
   * `undefined`/`null` means no explicit choice, which is Auto.
   */
  selectedModel?: SelectedModel | null;
};

function envNumber({
  name,
  defaultValue,
  min,
  max,
}: {
  name: string;
  defaultValue: number;
  min: number;
  max: number;
}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

/** Daily cost cap. `PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD=0` disables it. */
export function getPaidDailyFreeAllowanceCostLimitDollars(): number {
  return envNumber({
    name: "PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD",
    defaultValue: PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD_DEFAULT,
    min: 0,
    max: 100,
  });
}

function dollarsToPoints(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.ceil(dollars * POINTS_PER_DOLLAR);
}

function pointsToDollars(points: number): number {
  return Math.round((points / POINTS_PER_DOLLAR) * 10_000) / 10_000;
}

function getRedisClient() {
  try {
    return createRedisClient();
  } catch {
    return null;
  }
}

function getCurrentUtcDayWindow(now = new Date()) {
  const bucket = now.toISOString().slice(0, 10);
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );

  return {
    bucket,
    reset,
    ttlMs: Math.max(1, reset - now.getTime()),
  };
}

export function getPaidDailyFreeAllowanceKeys(
  userId: string,
  bucket = getCurrentUtcDayWindow().bucket,
) {
  const prefix = `paid_daily_free_allowance:${userId}:${bucket}`;
  return {
    requestsKey: `${prefix}:requests`,
    costKey: `${prefix}:cost`,
  };
}

function baseStatus(
  reason?: PaidDailyFreeAllowanceUnavailableReason,
): PaidDailyFreeAllowanceStatus {
  const costLimitDollars = getPaidDailyFreeAllowanceCostLimitDollars();
  const costLimitPoints = dollarsToPoints(costLimitDollars);
  const { reset } = getCurrentUtcDayWindow();

  return {
    type: "paid_daily_free_allowance",
    available: false,
    requestsUsed: 0,
    costLimitDollars,
    costUsedDollars: 0,
    costRemainingDollars: costLimitDollars,
    costLimitPoints,
    costUsedPoints: 0,
    costRemainingPoints: costLimitPoints,
    resetTime: new Date(reset),
    resetTimestamp: reset,
    ...(reason && { unavailableReason: reason }),
  };
}

function getStaticUnavailableReason(
  ctx: PaidDailyFreeAllowanceContext,
): PaidDailyFreeAllowanceUnavailableReason | null {
  if (ctx.subscription === "free") return "unsupported_subscription";
  if (ctx.capReason !== "monthly_exhausted") return "not_monthly_exhausted";
  // Ask attachments may require a more expensive multimodal route. Agent
  // attachments stay eligible because the allowance uses the cheap Agent
  // model and records the run's model, tool, and sandbox costs together.
  if (ctx.mode === "ask" && ctx.hasAttachments) {
    return "attachments_not_supported";
  }
  // The rescue is a low-cost-model fallback. A user who explicitly picked a
  // premium model is asked to add credits instead of being silently
  // downgraded.
  if (ctx.selectedModel != null && ctx.selectedModel !== "auto") {
    return "unsupported_model";
  }
  return null;
}

export async function getPaidDailyFreeAllowanceStatus(
  ctx: PaidDailyFreeAllowanceContext,
): Promise<PaidDailyFreeAllowanceStatus> {
  const staticReason = getStaticUnavailableReason(ctx);
  if (staticReason) return baseStatus(staticReason);

  const costLimitDollars = getPaidDailyFreeAllowanceCostLimitDollars();
  const costLimitPoints = dollarsToPoints(costLimitDollars);
  const { bucket, reset } = getCurrentUtcDayWindow();

  const redis = getRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        ...baseStatus(),
        available: costLimitPoints > 0,
        rateLimitSkipped: true,
      };
    }

    return baseStatus("redis_unavailable");
  }

  const { requestsKey, costKey } = getPaidDailyFreeAllowanceKeys(
    ctx.userId,
    bucket,
  );
  let rawRequestsUsed: unknown;
  let rawCostUsed: unknown;
  try {
    [rawRequestsUsed, rawCostUsed] = await Promise.all([
      redis.get(requestsKey),
      redis.get(costKey),
    ]);
  } catch {
    return baseStatus("redis_unavailable");
  }

  const requestsUsed = Math.max(0, Number(rawRequestsUsed ?? 0));
  const costUsedPoints = Math.max(0, Number(rawCostUsed ?? 0));
  const costRemainingPoints = Math.max(0, costLimitPoints - costUsedPoints);
  const unavailableReason =
    costRemainingPoints <= 0 ? "cost_limit_reached" : undefined;

  return {
    type: "paid_daily_free_allowance",
    available: !unavailableReason && costLimitPoints > 0,
    requestsUsed,
    costLimitDollars,
    costUsedDollars: pointsToDollars(costUsedPoints),
    costRemainingDollars: pointsToDollars(costRemainingPoints),
    costLimitPoints,
    costUsedPoints,
    costRemainingPoints,
    resetTime: new Date(reset),
    resetTimestamp: reset,
    ...(unavailableReason && { unavailableReason }),
  };
}

export async function reservePaidDailyFreeAllowanceRequest(
  ctx: PaidDailyFreeAllowanceContext,
): Promise<PaidDailyFreeAllowanceReservation> {
  const status = await getPaidDailyFreeAllowanceStatus(ctx);
  if (!status.available) {
    return { allowed: false, status, blockReason: status.unavailableReason };
  }

  const redis = getRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        allowed: true,
        status: {
          ...status,
          requestsUsed: status.requestsUsed + 1,
          rateLimitSkipped: true,
        },
      };
    }

    return {
      allowed: false,
      status: {
        ...status,
        available: false,
        unavailableReason: "redis_unavailable",
      },
      blockReason: "redis_unavailable",
    };
  }

  const { bucket, reset, ttlMs } = getCurrentUtcDayWindow();
  const { requestsKey, costKey } = getPaidDailyFreeAllowanceKeys(
    ctx.userId,
    bucket,
  );
  let result: [
    number,
    PaidDailyFreeAllowanceUnavailableReason | "ok",
    number,
    number,
  ];
  try {
    result = (await redis.eval(
      RESERVE_PAID_DAILY_FREE_ALLOWANCE_SCRIPT,
      [requestsKey, costKey],
      [status.costLimitPoints, ttlMs],
    )) as [
      number,
      PaidDailyFreeAllowanceUnavailableReason | "ok",
      number,
      number,
    ];
  } catch {
    return {
      allowed: false,
      status: {
        ...status,
        available: false,
        unavailableReason: "redis_unavailable",
      },
      blockReason: "redis_unavailable",
    };
  }

  const [allowedRaw, rawReason, requestsUsedRaw, costUsedRaw] = result;
  const allowed = allowedRaw === 1;
  const requestsUsed = Math.max(0, Number(requestsUsedRaw ?? 0));
  const costUsedPoints = Math.max(0, Number(costUsedRaw ?? 0));
  const costRemainingPoints = Math.max(
    0,
    status.costLimitPoints - costUsedPoints,
  );
  const blockReason = allowed ? undefined : rawReason;
  const nextStatus: PaidDailyFreeAllowanceStatus = {
    ...status,
    available: allowed && costRemainingPoints > 0,
    requestsUsed,
    costUsedPoints,
    costUsedDollars: pointsToDollars(costUsedPoints),
    costRemainingPoints,
    costRemainingDollars: pointsToDollars(costRemainingPoints),
    resetTime: new Date(reset),
    resetTimestamp: reset,
    ...(blockReason &&
      blockReason !== "ok" && {
        unavailableReason: blockReason,
      }),
  };

  return {
    allowed,
    status: nextStatus,
    ...(blockReason && blockReason !== "ok" && { blockReason }),
  };
}

export async function recordPaidDailyFreeAllowanceCost(
  userId: string,
  costDollars: number,
): Promise<PaidDailyFreeAllowanceCostRecordResult> {
  const costPoints = dollarsToPoints(costDollars);
  if (costPoints <= 0) {
    return {
      recorded: true,
      costPoints: 0,
      costDollars: 0,
      nextCostPoints: 0,
      nextCostDollars: 0,
    };
  }

  const redis = getRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      return {
        recorded: true,
        costPoints,
        costDollars: pointsToDollars(costPoints),
        nextCostPoints: costPoints,
        nextCostDollars: pointsToDollars(costPoints),
      };
    }
    return {
      recorded: false,
      costPoints,
      costDollars: pointsToDollars(costPoints),
      unavailableReason: "redis_unavailable",
    };
  }

  const { bucket, ttlMs } = getCurrentUtcDayWindow();
  const { costKey } = getPaidDailyFreeAllowanceKeys(userId, bucket);
  let nextCost: unknown;
  try {
    nextCost = await redis.eval(
      RECORD_PAID_DAILY_FREE_ALLOWANCE_COST_SCRIPT,
      [costKey],
      [costPoints, ttlMs],
    );
  } catch {
    return {
      recorded: false,
      costPoints,
      costDollars: pointsToDollars(costPoints),
      unavailableReason: "redis_unavailable",
    };
  }

  const nextCostPoints = Math.max(0, Number(nextCost ?? 0));
  return {
    recorded: true,
    costPoints,
    costDollars: pointsToDollars(costPoints),
    nextCostPoints,
    nextCostDollars: pointsToDollars(nextCostPoints),
  };
}

export function paidDailyFreeAllowanceStatusToMetadata(
  status: PaidDailyFreeAllowanceStatus,
): PaidDailyFreeAllowanceMetadata {
  return {
    type: status.type,
    available: status.available,
    requestsUsed: status.requestsUsed,
    costLimitDollars: status.costLimitDollars,
    costUsedDollars: status.costUsedDollars,
    costRemainingDollars: status.costRemainingDollars,
    resetTimestamp: status.resetTimestamp,
    ...(status.unavailableReason && {
      unavailableReason: status.unavailableReason,
    }),
    ...(status.rateLimitSkipped && { rateLimitSkipped: true }),
  };
}
