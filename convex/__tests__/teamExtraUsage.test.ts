import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
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
jest.mock("../lib/logger", () => ({
  convexLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const SERVICE_KEY = "test-service-key";
const ORIGINAL_SERVICE_KEY = process.env.CONVEX_SERVICE_ROLE_KEY;
beforeAll(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;
});
afterAll(() => {
  if (ORIGINAL_SERVICE_KEY === undefined) {
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
  } else {
    process.env.CONVEX_SERVICE_ROLE_KEY = ORIGINAL_SERVICE_KEY;
  }
});

const ORG_ID = "org_123";
const USER_ID = "user_abc";
const OTHER_USER_ID = "user_xyz";

const POINTS_PER_DOLLAR = 10_000;

type TeamRow = {
  _id: string;
  organization_id: string;
  enabled?: boolean;
  balance_points: number;
  auto_reload_enabled?: boolean;
  auto_reload_threshold_points?: number;
  auto_reload_amount_dollars?: number;
  monthly_cap_points?: number;
  monthly_spent_points?: number;
  monthly_reset_date?: string;
  first_successful_charge_at?: number;
  cumulative_spend_dollars?: number;
  override_monthly_cap_dollars?: number;
  auto_reload_consecutive_failures?: number;
  auto_reload_disabled_reason?: string;
  updated_at: number;
};

type MemberRow = {
  _id: string;
  organization_id: string;
  user_id: string;
  monthly_limit_points?: number;
  monthly_spent_points?: number;
  monthly_reset_date?: string;
  disabled?: boolean;
  updated_at: number;
};

type WebhookRow = {
  _id: string;
  event_id: string;
  processed_at: number;
  status?: "pending" | "completed";
};

/**
 * Mock ctx that simulates the three tables touched by team extra usage:
 * team_extra_usage, team_member_usage, processed_webhooks. Index lookups
 * resolve by walking the relevant array; .collect() returns all rows
 * matching the captured org_id filter.
 */
function makeMockCtx(opts?: {
  team?: TeamRow[];
  members?: MemberRow[];
  webhooks?: WebhookRow[];
}) {
  const team: TeamRow[] = [...(opts?.team ?? [])];
  const members: MemberRow[] = [...(opts?.members ?? [])];
  const webhooks: WebhookRow[] = [...(opts?.webhooks ?? [])];

  let nextId = 1;
  const mintId = () => `id-${nextId++}`;

  const buildQuery = (table: string) => {
    return {
      withIndex: jest.fn((_indexName: string, predicate: any) => {
        const captured: Record<string, string> = {};
        let depth = 0;
        const captureProxy = {
          eq: (field: string, value: string) => {
            captured[field] = value;
            depth++;
            return captureProxy;
          },
        };
        predicate(captureProxy);

        const matches = (() => {
          if (table === "team_extra_usage") {
            return team.filter(
              (r) => r.organization_id === captured.organization_id,
            );
          }
          if (table === "team_member_usage") {
            return members.filter((r) => {
              if (r.organization_id !== captured.organization_id) return false;
              if (captured.user_id && r.user_id !== captured.user_id)
                return false;
              return true;
            });
          }
          if (table === "processed_webhooks") {
            return webhooks.filter((r) => r.event_id === captured.event_id);
          }
          return [];
        })();
        void depth;

        return {
          first: async () => matches[0] ?? null,
          unique: async () => {
            if (matches.length === 0) return null;
            if (matches.length > 1) {
              throw new Error(
                `expected one row for ${table}, found ${matches.length}`,
              );
            }
            return matches[0];
          },
          collect: async () => matches,
        };
      }),
    };
  };

  const ctx: any = {
    db: {
      query: jest.fn((table: string) => buildQuery(table)),
      insert: jest.fn(async (table: string, doc: any) => {
        const id = mintId();
        const row = { _id: id, ...doc };
        if (table === "team_extra_usage") team.push(row);
        else if (table === "team_member_usage") members.push(row);
        else if (table === "processed_webhooks") webhooks.push(row);
        else throw new Error(`unexpected table: ${table}`);
        return id;
      }),
      patch: jest.fn(async (id: string, patch: any) => {
        const all: any[] = [...team, ...members, ...webhooks];
        const row = all.find((r) => r._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
      get: jest.fn(async (id: string) => {
        const all: any[] = [...team, ...members, ...webhooks];
        return all.find((r) => r._id === id) ?? null;
      }),
    },
  };

  return { ctx, team, members, webhooks };
}

async function callDeduct(
  ctx: any,
  args: { organizationId: string; userId: string; amountPoints: number },
) {
  const { deductTeamPoints } = await import("../teamExtraUsage");
  return (deductTeamPoints as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

async function callRefund(
  ctx: any,
  args: { organizationId: string; userId: string; amountPoints: number },
) {
  const { refundTeamPoints } = await import("../teamExtraUsage");
  return (refundTeamPoints as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

async function callAddCredits(
  ctx: any,
  args: {
    organizationId: string;
    amountDollars: number;
    idempotencyKey?: string;
    legacyIdempotencyKey?: string;
  },
) {
  const { addTeamCredits } = await import("../teamExtraUsage");
  return (addTeamCredits as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

async function callGetState(
  ctx: any,
  args: { organizationId: string; userId: string },
) {
  const { getTeamExtraUsageStateForBackend } =
    await import("../teamExtraUsage");
  return (getTeamExtraUsageStateForBackend as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

const enabledTeamRow = (overrides: Partial<TeamRow> = {}): TeamRow => ({
  _id: "team-1",
  organization_id: ORG_ID,
  enabled: true,
  balance_points: 100_000, // $10
  updated_at: 0,
  ...overrides,
});

describe("deductTeamPoints", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it("returns poolDisabled when no team row exists", async () => {
    const { ctx } = makeMockCtx();
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 1000,
    });
    expect(result).toMatchObject({
      success: false,
      poolDisabled: true,
      insufficientFunds: true,
    });
  });

  it("returns poolDisabled when team row exists but enabled=false", async () => {
    const { ctx } = makeMockCtx({
      team: [enabledTeamRow({ enabled: false })],
    });
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 1000,
    });
    expect(result.poolDisabled).toBe(true);
  });

  it("returns memberDisabled when member is admin-blocked", async () => {
    const { ctx } = makeMockCtx({
      team: [enabledTeamRow()],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          disabled: true,
          updated_at: 0,
        },
      ],
    });
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 1000,
    });
    expect(result).toMatchObject({
      success: false,
      memberDisabled: true,
      poolDisabled: false,
    });
  });

  it("returns insufficientFunds when balance < amount", async () => {
    const { ctx } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 500 })],
    });
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 1000,
    });
    expect(result).toMatchObject({
      success: false,
      insufficientFunds: true,
      monthlyCapExceeded: false,
      memberCapExceeded: false,
      memberDisabled: false,
      poolDisabled: false,
    });
  });

  it("returns monthlyCapExceeded when team cap would be breached", async () => {
    const { ctx } = makeMockCtx({
      team: [
        enabledTeamRow({
          balance_points: 1_000_000,
          monthly_cap_points: 500, // $0.05 cap
          monthly_spent_points: 400,
          monthly_reset_date: new Date().toISOString().slice(0, 7), // current month
        }),
      ],
    });
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 200, // 400 + 200 = 600 > 500
    });
    expect(result).toMatchObject({
      success: false,
      monthlyCapExceeded: true,
    });
  });

  it("returns memberCapExceeded when per-member cap would be breached", async () => {
    const { ctx } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 1_000_000 })],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          monthly_limit_points: 1000,
          monthly_spent_points: 900,
          monthly_reset_date: new Date().toISOString().slice(0, 7),
          updated_at: 0,
        },
      ],
    });
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 200, // 900 + 200 = 1100 > 1000
    });
    expect(result).toMatchObject({
      success: false,
      memberCapExceeded: true,
      monthlyCapExceeded: false,
    });
  });

  it("happy path: debits team balance, increments team + member spent, sets reset date", async () => {
    const { ctx, team, members } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 100_000 })],
    });

    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 25_000,
    });

    const currentMonth = `${new Date().getUTCFullYear()}-${String(
      new Date().getUTCMonth() + 1,
    ).padStart(2, "0")}`;

    expect(result).toMatchObject({
      success: true,
      newBalancePoints: 75_000,
      insufficientFunds: false,
      memberCapExceeded: false,
      memberDisabled: false,
      poolDisabled: false,
      monthlyCapExceeded: false,
    });

    expect(team[0].balance_points).toBe(75_000);
    expect(team[0].monthly_spent_points).toBe(25_000);
    expect(team[0].monthly_reset_date).toBe(currentMonth);

    // Member row was created with the correct spent + reset date
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      organization_id: ORG_ID,
      user_id: USER_ID,
      monthly_spent_points: 25_000,
      monthly_reset_date: currentMonth,
    });
  });

  it("rolls over monthly counters when month changes", async () => {
    const { ctx, team, members } = makeMockCtx({
      team: [
        enabledTeamRow({
          balance_points: 100_000,
          monthly_spent_points: 80_000,
          monthly_reset_date: "1999-01", // stale month
        }),
      ],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          monthly_spent_points: 50_000,
          monthly_reset_date: "1999-01",
          updated_at: 0,
        },
      ],
    });

    await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 10_000,
    });

    // Old spent counters are reset before increment — final values are
    // just the new deduction, not "stale + new".
    expect(team[0].monthly_spent_points).toBe(10_000);
    expect(members[0].monthly_spent_points).toBe(10_000);
  });

  it("each member's cap is independent (doesn't bleed across members)", async () => {
    const { ctx, members } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 1_000_000 })],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          monthly_limit_points: 1000,
          monthly_spent_points: 900, // near cap
          monthly_reset_date: new Date().toISOString().slice(0, 7),
          updated_at: 0,
        },
      ],
    });

    // Different member with no cap — should succeed
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: OTHER_USER_ID,
      amountPoints: 5000,
    });

    expect(result.success).toBe(true);
    // First member's spent should be untouched
    expect(members[0].monthly_spent_points).toBe(900);
  });
});

describe("refundTeamPoints", () => {
  beforeEach(() => jest.clearAllMocks());

  it("no-op when amountPoints <= 0", async () => {
    const { ctx, team } = makeMockCtx();
    const result = await callRefund(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 0,
    });
    expect(result).toMatchObject({ success: true, noOp: true });
    expect(team).toHaveLength(0); // no row created
  });

  it("refunds team balance and decrements member's monthly spent", async () => {
    const { ctx, team, members } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 20_000 })],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          monthly_spent_points: 30_000,
          monthly_reset_date: new Date().toISOString().slice(0, 7),
          updated_at: 0,
        },
      ],
    });

    const result = await callRefund(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 10_000,
    });

    expect(result.success).toBe(true);
    expect(team[0].balance_points).toBe(30_000);
    expect(members[0].monthly_spent_points).toBe(20_000);
  });

  it("refund won't take member's spent below zero", async () => {
    const { ctx, members } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 0 })],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          monthly_spent_points: 5,
          updated_at: 0,
        },
      ],
    });

    await callRefund(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 1_000_000, // way more than member spent
    });

    expect(members[0].monthly_spent_points).toBe(0);
  });

  it("creates a team row if none exists and credits the refund", async () => {
    const { ctx, team } = makeMockCtx();
    const result = await callRefund(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 1500,
    });
    expect(result.success).toBe(true);
    expect(team).toHaveLength(1);
    expect(team[0].balance_points).toBe(1500);
  });
});

describe("addTeamCredits idempotency", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects non-positive amounts", async () => {
    const { ctx } = makeMockCtx();
    await expect(
      callAddCredits(ctx, { organizationId: ORG_ID, amountDollars: 0 }),
    ).rejects.toThrow();
    await expect(
      callAddCredits(ctx, { organizationId: ORG_ID, amountDollars: -5 }),
    ).rejects.toThrow();
  });

  it("credits the team balance and tracks cumulative spend", async () => {
    const { ctx, team } = makeMockCtx();
    const result = await callAddCredits(ctx, {
      organizationId: ORG_ID,
      amountDollars: 25,
    });
    expect(result.alreadyProcessed).toBe(false);
    expect(result.newBalance).toBe(25);
    expect(team).toHaveLength(1);
    expect(team[0].balance_points).toBe(25 * POINTS_PER_DOLLAR);
    expect(team[0].cumulative_spend_dollars).toBe(25);
    expect(team[0].first_successful_charge_at).toBeGreaterThan(0);
  });

  it("returns alreadyProcessed when the idempotency key was already seen", async () => {
    const { ctx, team } = makeMockCtx({
      webhooks: [{ _id: "wh-1", event_id: "cs_test_dupe", processed_at: 100 }],
    });

    const result = await callAddCredits(ctx, {
      organizationId: ORG_ID,
      amountDollars: 25,
      idempotencyKey: "cs_test_dupe",
    });

    expect(result.alreadyProcessed).toBe(true);
    expect(team).toHaveLength(0); // nothing inserted
  });

  it("also dedupes via legacyIdempotencyKey", async () => {
    const { ctx, team } = makeMockCtx({
      webhooks: [{ _id: "wh-1", event_id: "evt_legacy", processed_at: 100 }],
    });

    const result = await callAddCredits(ctx, {
      organizationId: ORG_ID,
      amountDollars: 25,
      idempotencyKey: "cs_new",
      legacyIdempotencyKey: "evt_legacy",
    });

    expect(result.alreadyProcessed).toBe(true);
    expect(team).toHaveLength(0);
  });
});

describe("getTeamExtraUsageStateForBackend", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns enabled=false and zero balance when no team row exists", async () => {
    const { ctx } = makeMockCtx();
    const result = await callGetState(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(result).toMatchObject({
      enabled: false,
      balanceDollars: 0,
      memberDisabled: false,
    });
  });

  it("surfaces the member's disabled flag", async () => {
    const { ctx } = makeMockCtx({
      team: [enabledTeamRow()],
      members: [
        {
          _id: "m-1",
          organization_id: ORG_ID,
          user_id: USER_ID,
          disabled: true,
          updated_at: 0,
        },
      ],
    });

    const result = await callGetState(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(result.enabled).toBe(true);
    expect(result.memberDisabled).toBe(true);
  });
});
