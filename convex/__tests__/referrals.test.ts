import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

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
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

const SERVICE_KEY = "test-service-key";

type Row = Record<string, any> & { _id: string };

function makeMockCtx(initial?: Partial<Record<string, Row[]>>) {
  const tables: Record<string, Row[]> = {
    referral_codes: [...(initial?.referral_codes ?? [])],
    referrals: [...(initial?.referrals ?? [])],
    referral_credit_balances: [...(initial?.referral_credit_balances ?? [])],
    referral_credit_ledger: [...(initial?.referral_credit_ledger ?? [])],
  };

  let nextId = 1;
  const mintId = (table: string) => `${table}-${nextId++}`;

  const getMatches = (table: string, captured: Record<string, any>) => {
    return (tables[table] ?? []).filter((row) =>
      Object.entries(captured).every(([field, value]) => row[field] === value),
    );
  };

  const ctx: any = {
    db: {
      query: jest.fn((table: string) => ({
        withIndex: jest.fn((_indexName: string, predicate: any) => {
          const captured: Record<string, any> = {};
          const captureProxy = {
            eq: (field: string, value: any) => {
              captured[field] = value;
              return captureProxy;
            },
          };
          predicate(captureProxy);
          const matches = getMatches(table, captured);
          return {
            first: async () => matches[0] ?? null,
            unique: async () => {
              if (matches.length === 0) return null;
              if (matches.length > 1) {
                throw new Error(`Expected unique ${table} row`);
              }
              return matches[0];
            },
            collect: async () => matches,
          };
        }),
      })),
      insert: jest.fn(async (table: string, doc: Record<string, any>) => {
        const row = { _id: mintId(table), ...doc };
        tables[table].push(row);
        return row._id;
      }),
      patch: jest.fn(async (id: string, patch: Record<string, any>) => {
        const row = Object.values(tables)
          .flat()
          .find((candidate) => candidate._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
      get: jest.fn(async (id: string) => {
        return (
          Object.values(tables)
            .flat()
            .find((candidate) => candidate._id === id) ?? null
        );
      }),
    },
  };

  return { ctx, tables };
}

async function referralsModule() {
  return import("../referrals");
}

describe("referrals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates one stable referral code per user", async () => {
    const { getOrCreateReferralCode } = await referralsModule();
    const { ctx, tables } = makeMockCtx();

    const first = await (getOrCreateReferralCode as any).handler(ctx, {
      userId: "user-referrer",
    });
    const second = await (getOrCreateReferralCode as any).handler(ctx, {
      userId: "user-referrer",
    });

    expect(first.code).toBe(second.code);
    expect(tables.referral_codes).toHaveLength(1);
  });

  it("rejects self-referrals", async () => {
    const { claimReferralSignup } = await referralsModule();
    const { ctx } = makeMockCtx({
      referral_codes: [
        {
          _id: "code-1",
          user_id: "user-a",
          code: "ABCD1234",
          created_at: 1,
        },
      ],
    });

    const result = await (claimReferralSignup as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      referredUserId: "user-a",
      referralCode: "ABCD1234",
    });

    expect(result).toEqual({ claimed: false, reason: "self_referral" });
  });

  it("keeps first-touch attribution and awards starter credits once", async () => {
    const { claimReferralSignup } = await referralsModule();
    const { ctx, tables } = makeMockCtx({
      referral_codes: [
        {
          _id: "code-1",
          user_id: "referrer-a",
          code: "FIRST123",
          created_at: 1,
        },
        {
          _id: "code-2",
          user_id: "referrer-b",
          code: "LAST1234",
          created_at: 1,
        },
      ],
    });

    const first = await (claimReferralSignup as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      referredUserId: "new-user",
      referralCode: "FIRST123",
      referralLandingPath: "/invite/FIRST123",
    });
    const second = await (claimReferralSignup as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      referredUserId: "new-user",
      referralCode: "LAST1234",
      referralLandingPath: "/invite/LAST1234",
    });

    expect(first.claimed).toBe(true);
    expect(second).toMatchObject({
      claimed: false,
      reason: "already_claimed",
      referrerUserId: "referrer-a",
      referralCode: "FIRST123",
    });
    expect(tables.referrals).toHaveLength(1);
    expect(tables.referral_credit_balances[0]).toMatchObject({
      user_id: "new-user",
      balance_credits: 10,
    });
    expect(tables.referral_credit_ledger).toHaveLength(1);
  });

  it("awards referrer conversion credits once", async () => {
    const { awardReferralConversion } = await referralsModule();
    const { ctx, tables } = makeMockCtx({
      referrals: [
        {
          _id: "referral-1",
          referrer_user_id: "referrer-a",
          referred_user_id: "new-user",
          referral_code: "FIRST123",
          status: "activated",
          signed_up_at: 1,
          activated_at: 2,
          updated_at: 2,
        },
      ],
    });

    const first = await (awardReferralConversion as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      referredUserId: "new-user",
      qualifyingTier: "pro",
      idempotencyKey: "sub_123",
    });
    const second = await (awardReferralConversion as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      referredUserId: "new-user",
      qualifyingTier: "pro",
      idempotencyKey: "sub_123",
    });

    expect(first).toMatchObject({
      awarded: true,
      referrerUserId: "referrer-a",
      creditsAwarded: 10,
    });
    expect(second).toMatchObject({
      awarded: false,
      reason: "already_converted",
    });
    expect(tables.referral_credit_balances[0]).toMatchObject({
      user_id: "referrer-a",
      balance_credits: 10,
    });
    expect(tables.referral_credit_ledger).toHaveLength(1);
  });

  it("does not allow referral credit spend to go negative", async () => {
    const { spendReferralCredits } = await referralsModule();
    const { ctx, tables } = makeMockCtx({
      referral_credit_balances: [
        {
          _id: "balance-1",
          user_id: "user-a",
          balance_credits: 1,
          updated_at: 1,
        },
      ],
    });

    const result = await (spendReferralCredits as any).handler(ctx, {
      serviceKey: SERVICE_KEY,
      userId: "user-a",
      amountCredits: 2,
      idempotencyKey: "spend-1",
    });

    expect(result).toMatchObject({
      success: false,
      insufficientCredits: true,
    });
    expect(tables.referral_credit_balances[0].balance_credits).toBe(1);
    expect(tables.referral_credit_ledger).toHaveLength(0);
  });
});
