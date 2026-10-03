import { getTestUserEmails, getTestUsers } from "../test-users-config";

const tiers = ["FREE", "PRO", "ULTRA"];
const keys = tiers.flatMap((tier) => [
  `TEST_${tier}_TIER_USER`,
  `TEST_${tier}_TIER_PASSWORD`,
]);
let original: Record<string, string | undefined>;

beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
});

afterEach(() => {
  keys.forEach((key) => {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  });
});

test("email-only maintenance works without passwords and honors overrides", () => {
  process.env.TEST_PRO_TIER_USER = "pro-preview@example.test";
  expect(getTestUserEmails()).toEqual({
    free: "free@hackerai.com",
    pro: "pro-preview@example.test",
    ultra: "ultra@hackerai.com",
  });
  expect(() => getTestUsers()).toThrow("TEST_FREE_TIER_PASSWORD");
});

test("authentication requires each password and returns configured credentials", () => {
  process.env.TEST_FREE_TIER_PASSWORD = "synthetic-free";
  process.env.TEST_PRO_TIER_PASSWORD = "synthetic-pro";
  expect(() => getTestUsers()).toThrow("TEST_ULTRA_TIER_PASSWORD");
  process.env.TEST_ULTRA_TIER_PASSWORD = "synthetic-ultra";
  expect(
    getTestUsers().map(({ tier, password }) => ({ tier, password })),
  ).toEqual([
    { tier: "free", password: "synthetic-free" },
    { tier: "pro", password: "synthetic-pro" },
    { tier: "ultra", password: "synthetic-ultra" },
  ]);
});
