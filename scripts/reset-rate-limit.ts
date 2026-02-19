#!/usr/bin/env tsx

/**
 * Reset Rate Limit Utility for Test Users
 *
 * This script allows you to reset rate limits for test users in your local environment.
 *
 * Usage:
 *   pnpm tsx scripts/reset-rate-limit.ts <user>
 *
 * Examples:
 *   # Reset all rate limits for free tier test user
 *   pnpm tsx scripts/reset-rate-limit.ts free
 *
 *   # Reset all rate limits for pro tier test user
 *   pnpm tsx scripts/reset-rate-limit.ts pro
 *
 *   # Reset all rate limits for ultra tier test user
 *   pnpm tsx scripts/reset-rate-limit.ts ultra
 *
 *   # Reset all test users at once
 *   pnpm tsx scripts/reset-rate-limit.ts --all
 */

import { config } from "dotenv";
import { resolve } from "path";
import { Redis } from "@upstash/redis";
import { WorkOS } from "@workos-inc/node";
import { getTestUsersRecord } from "./test-users-config";

// Load .env.e2e first so TEST_* can override, then .env.local
config({ path: resolve(process.cwd(), ".env.e2e") });
config({ path: resolve(process.cwd(), ".env.local") });

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

type TestUserTier = "free" | "pro" | "ultra";

const TEST_USERS = getTestUsersRecord();

async function getUserId(email: string): Promise<string | null> {
  const workos = new WorkOS(process.env.WORKOS_API_KEY, {
    clientId: process.env.WORKOS_CLIENT_ID,
  });

  try {
    const usersList = await workos.userManagement.listUsers({ email });
    if (usersList.data.length > 0) {
      return usersList.data[0].id;
    }
    return null;
  } catch (error) {
    console.error(`❌ Error fetching user: ${error}`);
    return null;
  }
}

async function resetRateLimitForUser(
  user: string,
  userEmail: string,
): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.error("❌ Error: Redis is not configured in .env.local");
    console.log(
      "\nTo configure Redis, add the following to your .env.local file:",
    );
    console.log("  UPSTASH_REDIS_REST_URL=https://your-endpoint.upstash.io");
    console.log("  UPSTASH_REDIS_REST_TOKEN=your_token_here");
    process.exit(1);
  }

  console.log(`\n🔍 Looking up user ID for ${userEmail}...`);

  const userId = await getUserId(userEmail);
  if (!userId) {
    console.error(`❌ Error: User ${userEmail} not found`);
    console.log("\n💡 Tip: Run the following to create test users:");
    console.log("   pnpm test:e2e:users:create");
    process.exit(1);
  }

  console.log(`✅ Found user ID: ${userId}`);

  const redis = new Redis({
    url: REDIS_URL,
    token: REDIS_TOKEN,
  });

  const label = ["free", "pro", "ultra"].includes(user)
    ? `${user} tier user`
    : user;
  console.log(`\n🔄 Resetting all rate limits for ${label}...\n`);

  try {
    // Get all keys for this user using pattern matching
    const pattern = `*${userId}*`;
    const allKeys = await redis.keys(pattern);

    if (!allKeys || allKeys.length === 0) {
      console.log(`ℹ️  No rate limit keys found for ${userEmail}`);
      return;
    }

    console.log(`📊 Found ${allKeys.length} rate limit key(s) to delete\n`);

    // Delete all matching keys
    for (const key of allKeys) {
      await redis.del(key);
      console.log(`✅ Deleted: ${key}`);
    }

    console.log(`\n✨ All rate limits reset for ${label}!`);
  } catch (error) {
    console.error("\n❌ Error resetting rate limits:", error);
    process.exit(1);
  }
}

async function resetAllTestUsers(): Promise<void> {
  console.log("\n🔄 Resetting rate limits for all test users...\n");

  for (const [user, { email }] of Object.entries(TEST_USERS)) {
    await resetRateLimitForUser(user as TestUserTier, email);
    console.log();
  }

  console.log("✨ All test user rate limits have been reset!\n");
}

// Main CLI handler
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Reset Rate Limit Utility for Test Users

Usage:
  pnpm rate-limit:reset <user>
  pnpm rate-limit:reset --all

Arguments:
  user           Test user tier: free | pro | ultra

Options:
  --all          Reset rate limits for all test users
  --help, -h     Show this help message

Examples:
  # Reset rate limits for free tier test user
  pnpm rate-limit:reset free

  # Reset rate limits for pro tier test user
  pnpm rate-limit:reset pro

  # Reset rate limits for ultra tier test user
  pnpm rate-limit:reset ultra

  # Reset all test users at once
  pnpm rate-limit:reset --all

Test Users:
  free   -> ${TEST_USERS.free.email}
  pro    -> ${TEST_USERS.pro.email}
  ultra  -> ${TEST_USERS.ultra.email}

Note: This script automatically looks up user IDs from WorkOS
      and deletes all rate limit keys for the specified user.
`);
    process.exit(0);
  }

  // Check for WorkOS credentials
  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
    console.error(
      "❌ Error: WORKOS_API_KEY and WORKOS_CLIENT_ID must be set in .env.local",
    );
    process.exit(1);
  }

  // Handle --all flag
  if (args[0] === "--all") {
    await resetAllTestUsers();
    return;
  }

  // Parse user argument
  const arg = args[0];

  // Check if it's an email address (arbitrary user)
  if (arg.includes("@")) {
    await resetRateLimitForUser(arg, arg);
    return;
  }

  const user = arg as TestUserTier;

  // Validate user
  if (!TEST_USERS[user]) {
    console.error(
      `❌ Error: Invalid user "${user}". Must be: free | pro | ultra | an email address`,
    );
    console.log("\n💡 Tip: Use --help to see available options");
    process.exit(1);
  }

  const { email } = TEST_USERS[user];
  await resetRateLimitForUser(user, email);
}

main().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
