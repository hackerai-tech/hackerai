#!/usr/bin/env tsx

/**
 * Local/dev helper for manually testing the paid daily free allowance flow.
 *
 * Usage:
 *   pnpm paid-allowance:dev prime pro
 *   pnpm paid-allowance:dev status pro
 *   pnpm paid-allowance:dev reset pro
 */

import { config } from "dotenv";
import { resolve } from "path";
import { Redis } from "@upstash/redis";
import { WorkOS } from "@workos-inc/node";
import { getTestUsersRecord } from "./test-users-config";

config({ path: resolve(process.cwd(), ".env.e2e") });
config({ path: resolve(process.cwd(), ".env.local") });

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const POINTS_PER_DOLLAR = 10_000;

type SupportedTier = "pro" | "pro-plus" | "ultra";
type Action = "prime" | "reset" | "status" | "block-request" | "block-cost";

const MONTHLY_CREDITS: Record<SupportedTier, number> = {
  pro: 250_000,
  "pro-plus": 600_000,
  ultra: 2_000_000,
};

const TEST_USERS = getTestUsersRecord();

function usage() {
  console.log(`
Paid Daily Free Allowance Dev Helper

Usage:
  pnpm paid-allowance:dev <action> <user> [tier]

Actions:
  prime          Exhaust the paid monthly bucket and clear today's allowance.
  reset          Restore the monthly bucket and clear today's allowance.
  status         Show monthly and allowance counters.
  block-request  Mark today's allowance request counter as consumed.
  block-cost     Mark today's allowance cost counter as consumed.

Users:
  pro | ultra | user@example.com

Tier:
  pro | pro-plus | ultra
  Defaults to the matching test user tier, or pro for arbitrary emails.

Examples:
  pnpm paid-allowance:dev prime pro
  pnpm paid-allowance:dev status pro
  pnpm paid-allowance:dev reset pro
`);
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing ${name} in .env.local`);
    process.exit(1);
  }
  return value;
}

function parseAction(value: string | undefined): Action {
  const action = value as Action | undefined;
  if (
    action === "prime" ||
    action === "reset" ||
    action === "status" ||
    action === "block-request" ||
    action === "block-cost"
  ) {
    return action;
  }

  usage();
  process.exit(1);
}

function parseTier(value: string | undefined, fallback: SupportedTier) {
  if (!value) return fallback;
  if (value === "pro" || value === "pro-plus" || value === "ultra") {
    return value;
  }

  console.error(`Unsupported tier "${value}". Use pro, pro-plus, or ultra.`);
  process.exit(1);
}

function resolveUser(input: string | undefined): {
  email: string;
  defaultTier: SupportedTier;
} {
  if (!input || input === "pro") {
    return { email: TEST_USERS.pro.email, defaultTier: "pro" };
  }

  if (input === "ultra") {
    return { email: TEST_USERS.ultra.email, defaultTier: "ultra" };
  }

  if (input.includes("@")) {
    return { email: input, defaultTier: "pro" };
  }

  console.error(`Unsupported user "${input}". Use pro, ultra, or an email.`);
  process.exit(1);
}

async function getUserId(email: string): Promise<string> {
  const workos = new WorkOS(
    requireEnv("WORKOS_API_KEY", process.env.WORKOS_API_KEY),
    {
      clientId: requireEnv("WORKOS_CLIENT_ID", process.env.WORKOS_CLIENT_ID),
    },
  );

  const usersList = await workos.userManagement.listUsers({ email });
  const user = usersList.data[0];
  if (!user) {
    throw new Error(`No WorkOS user found for ${email}`);
  }

  return user.id;
}

function monthlyKey(userId: string, tier: SupportedTier) {
  return `usage:monthly:${userId}:${tier}`;
}

function todayAllowanceKeys(userId: string) {
  const bucket = new Date().toISOString().slice(0, 10);
  const prefix = `paid_daily_free_allowance:${userId}:${bucket}`;
  return {
    requestsKey: `${prefix}:requests`,
    costKey: `${prefix}:cost`,
  };
}

async function clearAllowance(redis: Redis, userId: string) {
  const { requestsKey, costKey } = todayAllowanceKeys(userId);
  await redis.del(requestsKey);
  await redis.del(costKey);
}

async function setMonthlyTokens(
  redis: Redis,
  userId: string,
  tier: SupportedTier,
  tokens: number,
) {
  const key = monthlyKey(userId, tier);
  await redis.hset(key, {
    refilledAt: Date.now(),
    tokens,
    cycleAllocation: tokens,
    cycleTierMax: MONTHLY_CREDITS[tier],
    cycleStartedAt: Date.now(),
  });
  await redis.expire(key, THIRTY_DAYS_SECONDS);
}

async function printStatus(redis: Redis, userId: string, tier: SupportedTier) {
  const key = monthlyKey(userId, tier);
  const monthly = await redis.hgetall<Record<string, unknown>>(key);
  const { requestsKey, costKey } = todayAllowanceKeys(userId);
  const [requestsUsed, costUsed] = await Promise.all([
    redis.get<number>(requestsKey),
    redis.get<number>(costKey),
  ]);

  console.log(`User ID: ${userId}`);
  console.log(`Monthly key: ${key}`);
  console.log(`Monthly tokens: ${monthly?.tokens ?? "not initialized"}`);
  console.log(`Monthly limit tokens: ${MONTHLY_CREDITS[tier]}`);
  console.log(`Allowance requests used today: ${requestsUsed ?? 0}`);
  console.log(
    `Allowance cost used today: $${(((costUsed ?? 0) as number) / POINTS_PER_DOLLAR).toFixed(4)}`,
  );
}

async function main() {
  const action = parseAction(process.argv[2]);
  const user = resolveUser(process.argv[3]);
  const tier = parseTier(process.argv[4], user.defaultTier);

  const redis = new Redis({
    url: requireEnv("UPSTASH_REDIS_REST_URL", REDIS_URL),
    token: requireEnv("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN),
  });
  const userId = await getUserId(user.email);
  const allowanceCostLimitPoints = Math.ceil(
    Number(process.env.PAID_DAILY_FREE_ALLOWANCE_COST_LIMIT_USD ?? "0.10") *
      POINTS_PER_DOLLAR,
  );
  const allowanceRequestLimit = Math.floor(
    Number(process.env.PAID_DAILY_FREE_ALLOWANCE_REQUESTS_PER_DAY ?? "1"),
  );
  const { requestsKey, costKey } = todayAllowanceKeys(userId);

  if (action === "prime") {
    await setMonthlyTokens(redis, userId, tier, 0);
    await clearAllowance(redis, userId);
    console.log(
      `Primed ${user.email} (${tier}): monthly bucket exhausted and today's allowance cleared.`,
    );
  } else if (action === "reset") {
    await setMonthlyTokens(redis, userId, tier, MONTHLY_CREDITS[tier]);
    await clearAllowance(redis, userId);
    console.log(
      `Reset ${user.email} (${tier}): monthly bucket restored and today's allowance cleared.`,
    );
  } else if (action === "block-request") {
    await redis.set(requestsKey, allowanceRequestLimit, {
      ex: THIRTY_DAYS_SECONDS,
    });
    console.log(`Blocked by request count for ${user.email} today.`);
  } else if (action === "block-cost") {
    await redis.set(costKey, allowanceCostLimitPoints, {
      ex: THIRTY_DAYS_SECONDS,
    });
    console.log(`Blocked by cost cap for ${user.email} today.`);
  }

  await printStatus(redis, userId, tier);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
