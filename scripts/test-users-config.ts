/**
 * Single source of truth for E2E test user credentials.
 *
 * All scripts and e2e tests should import from here. Env vars (e.g. from .env.e2e)
 * supply passwords. Callers must load dotenv before calling these functions.
 */

export type TestUserTier = "free" | "pro" | "ultra";

export interface TestUser {
  email: string;
  password: string;
  tier: TestUserTier;
}

const DEFAULTS = {
  free: {
    email: "free@hackerai.com",
  },
  pro: {
    email: "pro@hackerai.com",
  },
  ultra: {
    email: "ultra@hackerai.com",
  },
} as const;

function testPassword(tier: TestUserTier): string {
  const key = `TEST_${tier.toUpperCase()}_TIER_PASSWORD`;
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Set ${key} in the protected Preview .env.e2e configuration`,
    );
  }
  return value;
}

/** Email-only maintenance does not require authentication credentials. */
export function getTestUserEmails(): Record<TestUserTier, string> {
  return {
    free: process.env.TEST_FREE_TIER_USER ?? DEFAULTS.free.email,
    pro: process.env.TEST_PRO_TIER_USER ?? DEFAULTS.pro.email,
    ultra: process.env.TEST_ULTRA_TIER_USER ?? DEFAULTS.ultra.email,
  };
}

/**
 * Returns test users as an array (for scripts that iterate over all users).
 */
export function getTestUsers(): TestUser[] {
  const emails = getTestUserEmails();
  return [
    {
      email: emails.free,
      password: testPassword("free"),
      tier: "free",
    },
    {
      email: emails.pro,
      password: testPassword("pro"),
      tier: "pro",
    },
    {
      email: emails.ultra,
      password: testPassword("ultra"),
      tier: "ultra",
    },
  ];
}

/**
 * Returns test users as a record keyed by tier (for e2e fixtures and scripts that look up by tier).
 */
export function getTestUsersRecord(): Record<TestUserTier, TestUser> {
  const users = getTestUsers();
  return {
    free: users[0],
    pro: users[1],
    ultra: users[2],
  };
}
