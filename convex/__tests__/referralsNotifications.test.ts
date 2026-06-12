import { describe, it, expect, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    array: jest.fn(() => "array"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    any: jest.fn(() => "any"),
  },
  ConvexError: class ConvexError extends Error {
    data: any;
    constructor(data: any) {
      super(typeof data === "string" ? data : data.message);
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));
jest.mock("../lib/logger", () => ({
  convexLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const SERVICE_KEY = "test-service-key";
const USER_ID = "user_referrer";
const REFERRED_USER_ID = "user_referred";

type Row = Record<string, any> & { _id: string };
type Tables = Record<string, Row[]>;

function makeMockCtx(initialTables: Partial<Tables>, userId = USER_ID) {
  const tables: Tables = {
    referral_attributions: [],
    referral_codes: [],
    referral_rewards: [],
    extra_usage: [],
    team_extra_usage: [],
    user_customization: [],
    ...initialTables,
  };
  const queryCalls: string[] = [];

  const findById = (id: string) => {
    for (const rows of Object.values(tables)) {
      const row = rows.find((candidate) => candidate._id === id);
      if (row) return row;
    }
    return null;
  };

  const ctx: any = {
    auth: {
      getUserIdentity: jest.fn(async () => ({ subject: userId })),
    },
    db: {
      query: jest.fn((table: string) => {
        queryCalls.push(table);
        const rows = tables[table] ?? [];

        return {
          withIndex: jest.fn((_indexName: string, predicate: any) => {
            const filters: Array<{ field: string; value: unknown }> = [];
            const q = {
              eq: (field: string, value: unknown) => {
                filters.push({ field, value });
                return q;
              },
            };
            predicate(q);

            const matches = rows.filter((row) =>
              filters.every((filter) => row[filter.field] === filter.value),
            );
            const chain = {
              first: jest.fn(async () => matches[0] ?? null),
              order: jest.fn(() => ({
                first: jest.fn(async () => matches[0] ?? null),
                take: jest.fn(async (limit: number) => matches.slice(0, limit)),
              })),
              take: jest.fn(async (limit: number) => matches.slice(0, limit)),
            };

            return chain;
          }),
        };
      }),
      get: jest.fn(async (id: string) => findById(id)),
      insert: jest.fn(async (table: string, doc: Record<string, any>) => {
        const row = {
          _id: `${table}_${tables[table].length + 1}`,
          ...doc,
        };
        tables[table].push(row);
        return row._id;
      }),
      patch: jest.fn(async (id: string, patch: Record<string, any>) => {
        const row = findById(id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
    },
  };

  return { ctx, tables, queryCalls };
}

describe("referral reward notifications", () => {
  it("returns only unseen awarded conversion rewards for the signed-in referrer", async () => {
    const { getUnreadRewardNotifications } = await import("../referrals");
    const { ctx } = makeMockCtx({
      referral_rewards: [
        {
          _id: "reward_unseen",
          reward_type: "referrer_conversion",
          status: "awarded",
          referrer_user_id: USER_ID,
          amount_dollars: 10,
          created_at: 100,
        },
        {
          _id: "reward_seen",
          reward_type: "referrer_conversion",
          status: "awarded",
          referrer_user_id: USER_ID,
          amount_dollars: 10,
          created_at: 90,
          notification_seen_at: 95,
        },
        {
          _id: "reward_signup",
          reward_type: "referred_signup",
          status: "awarded",
          referrer_user_id: USER_ID,
          amount_dollars: 0,
          amount_units: 10,
          created_at: 80,
        },
        {
          _id: "reward_other_user",
          reward_type: "referrer_conversion",
          status: "awarded",
          referrer_user_id: "user_other",
          amount_dollars: 10,
          created_at: 70,
        },
      ],
    });

    await expect(
      getUnreadRewardNotifications.handler(ctx, {}),
    ).resolves.toEqual([
      {
        rewardId: "reward_unseen",
        amountDollars: 10,
        createdAt: 100,
      },
    ]);
  });

  it("marks only the signed-in referrer's awarded conversion rewards as seen", async () => {
    const { markRewardNotificationsSeen } = await import("../referrals");
    const { ctx, tables } = makeMockCtx({
      referral_rewards: [
        {
          _id: "reward_own",
          reward_type: "referrer_conversion",
          status: "awarded",
          referrer_user_id: USER_ID,
          amount_dollars: 10,
          created_at: 100,
        },
        {
          _id: "reward_other",
          reward_type: "referrer_conversion",
          status: "awarded",
          referrer_user_id: "user_other",
          amount_dollars: 10,
          created_at: 100,
        },
      ],
    });

    await markRewardNotificationsSeen.handler(ctx, {
      rewardIds: ["reward_own", "reward_other"],
    });

    expect(tables.referral_rewards[0].notification_seen_at).toEqual(
      expect.any(Number),
    );
    expect(tables.referral_rewards[1].notification_seen_at).toBeUndefined();
  });

  it("adds referrer credits without changing their extra usage preference", async () => {
    const { awardConversionReward } = await import("../referrals");
    const { ctx, tables, queryCalls } = makeMockCtx({
      referral_attributions: [
        {
          _id: "attribution_1",
          referred_user_id: REFERRED_USER_ID,
          referrer_user_id: USER_ID,
          referral_code: "ABC1234",
          referrer_subscription_tier: "pro",
          status: "attributed",
          sign_up_reward_status: "awarded",
          conversion_reward_status: "pending",
          created_at: 1,
          updated_at: 1,
        },
      ],
      referral_codes: [
        {
          _id: "code_1",
          user_id: USER_ID,
          code: "ABC1234",
          status: "active",
          referrer_subscription_tier: "pro",
          created_at: 1,
          updated_at: 1,
        },
      ],
      user_customization: [
        {
          _id: "customization_1",
          user_id: USER_ID,
          extra_usage_enabled: false,
          updated_at: 1,
        },
      ],
    });

    const result = await awardConversionReward.handler(ctx, {
      serviceKey: SERVICE_KEY,
      referrerRewardDollars: 10,
      referredUserId: REFERRED_USER_ID,
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      stripeInvoiceId: "in_123",
      plan: "pro-monthly-plan",
      tier: "pro",
    });

    expect(result.status).toBe("awarded");
    expect(tables.extra_usage).toMatchObject([
      {
        user_id: USER_ID,
        balance_points: 100_000,
      },
    ]);
    expect(tables.user_customization[0].extra_usage_enabled).toBe(false);
    expect(queryCalls).not.toContain("user_customization");
  });

  it("withholds conversion rewards from free referrer codes", async () => {
    const { awardConversionReward } = await import("../referrals");
    const { ctx, tables } = makeMockCtx({
      referral_attributions: [
        {
          _id: "attribution_1",
          referred_user_id: REFERRED_USER_ID,
          referrer_user_id: USER_ID,
          referral_code: "FREE123",
          referrer_subscription_tier: "free",
          status: "attributed",
          sign_up_reward_status: "awarded",
          conversion_reward_status: "pending",
          created_at: 1,
          updated_at: 1,
        },
      ],
      referral_codes: [
        {
          _id: "code_1",
          user_id: USER_ID,
          code: "FREE123",
          status: "active",
          referrer_subscription_tier: "free",
          created_at: 1,
          updated_at: 1,
        },
      ],
    });

    const result = await awardConversionReward.handler(ctx, {
      serviceKey: SERVICE_KEY,
      referrerRewardDollars: 10,
      referredUserId: REFERRED_USER_ID,
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      stripeInvoiceId: "in_123",
      plan: "pro-monthly-plan",
      tier: "pro",
    });

    expect(result.status).toBe("withheld");
    expect(result.reason).toBe("ineligible_referrer_tier");
    expect(tables.referral_attributions[0]).toMatchObject({
      conversion_reward_status: "withheld",
      withheld_reason: "ineligible_referrer_tier",
    });
    expect(tables.referral_rewards).toMatchObject([
      expect.objectContaining({
        reward_type: "referrer_conversion",
        status: "withheld",
        reason: "ineligible_referrer_tier",
      }),
    ]);
    expect(tables.extra_usage).toEqual([]);
    expect(tables.user_customization).toEqual([]);
    expect(tables.team_extra_usage).toEqual([]);
  });

  it("awards paid credits when an originally free referrer upgrades before conversion", async () => {
    const { awardConversionReward } = await import("../referrals");
    const { ctx, tables } = makeMockCtx({
      referral_attributions: [
        {
          _id: "attribution_1",
          referred_user_id: REFERRED_USER_ID,
          referrer_user_id: USER_ID,
          referral_code: "UPGRADE",
          referrer_subscription_tier: "free",
          status: "attributed",
          sign_up_reward_status: "awarded",
          conversion_reward_status: "pending",
          created_at: 1,
          updated_at: 1,
        },
      ],
      referral_codes: [
        {
          _id: "code_1",
          user_id: USER_ID,
          code: "UPGRADE",
          status: "active",
          referrer_subscription_tier: "pro",
          created_at: 1,
          updated_at: 1,
        },
      ],
      user_customization: [
        {
          _id: "customization_1",
          user_id: USER_ID,
          extra_usage_enabled: false,
          updated_at: 1,
        },
      ],
    });

    const result = await awardConversionReward.handler(ctx, {
      serviceKey: SERVICE_KEY,
      referrerRewardDollars: 10,
      referredUserId: REFERRED_USER_ID,
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      stripeInvoiceId: "in_123",
      plan: "pro-monthly-plan",
      tier: "pro",
    });

    expect(result.status).toBe("awarded");
    expect(result.referrerSubscriptionTier).toBe("pro");
    expect(tables.extra_usage).toMatchObject([
      {
        user_id: USER_ID,
        balance_points: 100_000,
      },
    ]);
    expect(tables.user_customization[0].extra_usage_enabled).toBe(false);
  });
});
