/**
 * Single source of truth for E2E test user credentials.
 *
 * All scripts and e2e tests should import from here. Env vars (e.g. from .env.e2e)
 * override the defaults. Callers must load dotenv before importing if they need env.
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
    password: "hackerai123@",
  },
  pro: {
    email: "pro@hackerai.com",
    password: "hackerai123@",
  },
  ultra: {
    email: "ultra@hackerai.com",
    password: "hackerai123@",
  },
} as const;

/**
 * Returns test users as an array (for scripts that iterate over all users).
 */
export function getTestUsers(): TestUser[] {
  return [
    {
      email: process.env.TEST_FREE_TIER_USER ?? DEFAULTS.free.email,
      password: process.env.TEST_FREE_TIER_PASSWORD ?? DEFAULTS.free.password,
      tier: "free",
    },
    {
      email: process.env.TEST_PRO_TIER_USER ?? DEFAULTS.pro.email,
      password: process.env.TEST_PRO_TIER_PASSWORD ?? DEFAULTS.pro.password,
      tier: "pro",
    },
    {
      email: process.env.TEST_ULTRA_TIER_USER ?? DEFAULTS.ultra.email,
      password: process.env.TEST_ULTRA_TIER_PASSWORD ?? DEFAULTS.ultra.password,
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
