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
import {
  extraUsageDollarsToPoints,
  extraUsagePointsToDollars,
} from "../lib/extraUsagePricing";

jest.mock("../_generated/server", () => ({
  action: jest.fn((config: any) => config),
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));
const mockGetOrganization = jest.fn();
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({
    organizations: {
      getOrganization: mockGetOrganization,
    },
  })),
}));
const mockCustomerRetrieve = jest.fn();
const mockSubscriptionsList = jest.fn();
const mockInvoicesCreate = jest.fn();
const mockInvoicesRetrieve = jest.fn();
const mockInvoiceItemsCreate = jest.fn();
const mockInvoicesFinalize = jest.fn();
const mockInvoicesPay = jest.fn();
const mockInvoicesVoid = jest.fn();
const mockInvoicesDelete = jest.fn();
jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    customers: {
      retrieve: mockCustomerRetrieve,
    },
    subscriptions: {
      list: mockSubscriptionsList,
    },
    invoices: {
      create: mockInvoicesCreate,
      retrieve: mockInvoicesRetrieve,
      finalizeInvoice: mockInvoicesFinalize,
      pay: mockInvoicesPay,
      voidInvoice: mockInvoicesVoid,
      del: mockInvoicesDelete,
    },
    invoiceItems: {
      create: mockInvoiceItemsCreate,
    },
  }));
  (Stripe as any).errors = {
    StripeError: class StripeError extends Error {},
  };
  return { __esModule: true, default: Stripe };
});
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
const ORIGINAL_WORKOS_API_KEY = process.env.WORKOS_API_KEY;
const ORIGINAL_STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
beforeAll(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.WORKOS_API_KEY = "test-workos-key";
  process.env.STRIPE_SECRET_KEY = "sk_test";
});
afterAll(() => {
  if (ORIGINAL_SERVICE_KEY === undefined) {
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
  } else {
    process.env.CONVEX_SERVICE_ROLE_KEY = ORIGINAL_SERVICE_KEY;
  }
  if (ORIGINAL_WORKOS_API_KEY === undefined) {
    delete process.env.WORKOS_API_KEY;
  } else {
    process.env.WORKOS_API_KEY = ORIGINAL_WORKOS_API_KEY;
  }
  if (ORIGINAL_STRIPE_SECRET_KEY === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_SECRET_KEY;
  }
});

const ORG_ID = "org_123";
const USER_ID = "user_abc";
const OTHER_USER_ID = "user_xyz";

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
  auto_reload_consecutive_failures?: number;
  auto_reload_disabled_reason?: string;
  auto_reload_operation_id?: string;
  auto_reload_operation_executor_id?: string;
  auto_reload_operation_started_at?: number;
  auto_reload_operation_lease_expires_at?: number;
  auto_reload_operation_amount_dollars?: number;
  auto_reload_operation_stripe_invoice_id?: string;
  auto_reload_retry_after?: number;
  auto_reload_last_failure_reason?: string;
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

type RevenueRow = {
  _id: string;
  idempotency_key: string;
  entity_type: "user" | "organization";
  entity_id: string;
  source_event_id: string;
};

type UnitEconomicsDailyRow = {
  _id: string;
  entity_type: "user" | "organization";
  entity_id: string;
  day: string;
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
  revenue?: RevenueRow[];
  rollups?: UnitEconomicsDailyRow[];
}) {
  const team: TeamRow[] = [...(opts?.team ?? [])];
  const members: MemberRow[] = [...(opts?.members ?? [])];
  const webhooks: WebhookRow[] = [...(opts?.webhooks ?? [])];
  const revenue: RevenueRow[] = [...(opts?.revenue ?? [])];
  const rollups: UnitEconomicsDailyRow[] = [...(opts?.rollups ?? [])];

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
          if (table === "revenue_events") {
            return revenue.filter(
              (r) => r.idempotency_key === captured.idempotency_key,
            );
          }
          if (table === "unit_economics_daily") {
            return rollups.filter(
              (r) =>
                r.entity_type === captured.entity_type &&
                r.entity_id === captured.entity_id &&
                r.day === captured.day,
            );
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
        else if (table === "revenue_events") revenue.push(row);
        else if (table === "unit_economics_daily") rollups.push(row);
        else throw new Error(`unexpected table: ${table}`);
        return id;
      }),
      patch: jest.fn(async (id: string, patch: any) => {
        const all: any[] = [...team, ...members, ...webhooks, ...rollups];
        const row = all.find((r) => r._id === id);
        if (!row) throw new Error(`row ${id} not found`);
        Object.assign(row, patch);
      }),
      get: jest.fn(async (id: string) => {
        const all: any[] = [...team, ...members, ...webhooks, ...rollups];
        return all.find((r) => r._id === id) ?? null;
      }),
    },
  };

  return { ctx, team, members, webhooks, revenue, rollups };
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

async function callDeductWithAutoReloadForTeam(
  ctx: any,
  args: { organizationId: string; userId: string; amountPoints: number },
) {
  const { deductWithAutoReloadForTeam } =
    await import("../teamExtraUsageActions");
  return (deductWithAutoReloadForTeam as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

async function callClaimTeamAutoReload(
  ctx: any,
  args: {
    organizationId: string;
    candidateOperationId: string;
    candidateExecutorId: string;
    requestedAmountPoints: number;
  },
) {
  const { claimTeamAutoReloadOperation } = await import("../teamExtraUsage");
  return (claimTeamAutoReloadOperation as any).handler(ctx, args);
}

const claimedTeamAutoReload = (amountDollars: number) => ({
  status: "operation",
  operationId: "team_reload_op",
  executorId: "team_reload_executor",
  amountDollars,
  startedAt: Date.now(),
  claimed: true,
  paymentAllowed: true,
});

function makeTeamAutoReloadMutationMock({
  amountDollars,
  initialDeduct,
  finalDeduct = initialDeduct,
  creditBalance = amountDollars,
}: {
  amountDollars: number;
  initialDeduct: Record<string, unknown>;
  finalDeduct?: Record<string, unknown>;
  creditBalance?: number;
}) {
  let deductCalls = 0;
  return jest.fn(async (_mutation: unknown, mutationArgs: any) => {
    if ("candidateOperationId" in mutationArgs) {
      return claimedTeamAutoReload(amountDollars);
    }
    if ("stripeInvoiceId" in mutationArgs && "operationId" in mutationArgs) {
      return true;
    }
    if ("outcome" in mutationArgs) return true;
    if ("amountDollars" in mutationArgs) {
      return { newBalance: creditBalance, alreadyProcessed: false };
    }
    if ("success" in mutationArgs && !("amountPoints" in mutationArgs)) {
      return null;
    }
    deductCalls++;
    return deductCalls === 1 ? initialDeduct : finalDeduct;
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

  it("returns monthlyCapExceeded even when balance is insufficient", async () => {
    const { ctx } = makeMockCtx({
      team: [
        enabledTeamRow({
          balance_points: 100,
          monthly_cap_points: 500,
          monthly_spent_points: 400,
          monthly_reset_date: new Date().toISOString().slice(0, 7),
        }),
      ],
    });
    const result = await callDeduct(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 200,
    });
    expect(result).toMatchObject({
      success: false,
      insufficientFunds: true,
      monthlyCapExceeded: true,
      memberCapExceeded: false,
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

  it("returns memberCapExceeded even when balance is insufficient", async () => {
    const { ctx } = makeMockCtx({
      team: [enabledTeamRow({ balance_points: 100 })],
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
      amountPoints: 200,
    });
    expect(result).toMatchObject({
      success: false,
      insufficientFunds: true,
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

describe("team auto-reload operation claims", () => {
  beforeEach(() => jest.clearAllMocks());

  it("allows the one-dollar minimum with exactly one dollar of cap headroom", async () => {
    const oneDollarPoints = extraUsageDollarsToPoints(1);
    const { ctx } = makeMockCtx({
      team: [
        enabledTeamRow({
          balance_points: 0,
          auto_reload_enabled: true,
          auto_reload_threshold_points: 0,
          auto_reload_amount_dollars: 15,
          monthly_cap_points: oneDollarPoints,
          monthly_spent_points: 0,
          monthly_reset_date: new Date().toISOString().slice(0, 7),
        }),
      ],
    });

    const result = await callClaimTeamAutoReload(ctx, {
      organizationId: ORG_ID,
      candidateOperationId: "team-op-exact-minimum-cap",
      candidateExecutorId: "team-executor-exact-minimum-cap",
      requestedAmountPoints: oneDollarPoints,
    });

    expect(result).toMatchObject({
      status: "operation",
      amountDollars: 1,
    });
  });

  it("coalesces parallel claims and only allows the executor to complete", async () => {
    const { ctx, team } = makeMockCtx({
      team: [
        enabledTeamRow({
          balance_points: 200_000,
          auto_reload_enabled: true,
          auto_reload_threshold_points: 10_000,
          auto_reload_amount_dollars: 15,
          monthly_cap_points: extraUsageDollarsToPoints(100),
          monthly_spent_points: 0,
          monthly_reset_date: new Date().toISOString().slice(0, 7),
        }),
      ],
    });

    const first = await callClaimTeamAutoReload(ctx, {
      organizationId: ORG_ID,
      candidateOperationId: "team-op-first",
      candidateExecutorId: "team-executor-first",
      requestedAmountPoints: 300_000,
    });
    const second = await callClaimTeamAutoReload(ctx, {
      organizationId: ORG_ID,
      candidateOperationId: "team-op-second",
      candidateExecutorId: "team-executor-second",
      requestedAmountPoints: 300_000,
    });

    expect(first).toMatchObject({
      operationId: "team-op-first",
      amountDollars: 11.5,
      claimed: true,
    });
    expect(second).toMatchObject({
      operationId: "team-op-first",
      claimed: false,
    });

    const { completeTeamAutoReloadOperation } =
      await import("../teamExtraUsage");
    await expect(
      (completeTeamAutoReloadOperation as any).handler(ctx, {
        organizationId: ORG_ID,
        operationId: "team-op-first",
        executorId: "team-executor-second",
        outcome: "released",
      }),
    ).resolves.toBe(false);
    expect(team[0].auto_reload_operation_id).toBe("team-op-first");

    await (completeTeamAutoReloadOperation as any).handler(ctx, {
      organizationId: ORG_ID,
      operationId: "team-op-first",
      executorId: "team-executor-first",
      outcome: "executor_released",
    });
    team[0].balance_points = 300_000;
    const resumedAfterCredit = await callClaimTeamAutoReload(ctx, {
      organizationId: ORG_ID,
      candidateOperationId: "team-op-after-credit",
      candidateExecutorId: "team-executor-after-credit",
      requestedAmountPoints: 300_000,
    });
    expect(resumedAfterCredit).toMatchObject({
      operationId: "team-op-first",
      claimed: true,
      paymentAllowed: false,
      paymentBlockedReason: "not_needed",
    });
  });

  it("does not resume an operation too small for the current request", async () => {
    const { ctx } = makeMockCtx({
      team: [
        enabledTeamRow({
          balance_points: 0,
          auto_reload_enabled: true,
          auto_reload_threshold_points: 10_000,
          auto_reload_amount_dollars: 15,
          monthly_cap_points: extraUsageDollarsToPoints(100),
          monthly_spent_points: 0,
          monthly_reset_date: new Date().toISOString().slice(0, 7),
          auto_reload_operation_id: "team-op-small",
          auto_reload_operation_started_at: Date.now(),
          auto_reload_operation_lease_expires_at: 0,
          auto_reload_operation_amount_dollars: 1,
        }),
      ],
    });

    const resumed = await callClaimTeamAutoReload(ctx, {
      organizationId: ORG_ID,
      candidateOperationId: "team-op-large-request",
      candidateExecutorId: "team-executor-large-request",
      requestedAmountPoints: 300_000,
    });

    expect(resumed).toMatchObject({
      status: "operation",
      operationId: "team-op-small",
      claimed: true,
      paymentAllowed: false,
      paymentBlockedReason: "reload_amount_insufficient",
    });
  });
});

describe("deductWithAutoReloadForTeam", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomerRetrieve.mockResolvedValue({
      deleted: false,
      metadata: {},
      invoice_settings: {},
    } as never);
    mockSubscriptionsList.mockResolvedValue({
      data: [{ default_payment_method: "pm_card" }],
    } as never);
    mockInvoicesCreate.mockResolvedValue({
      id: "in_team_auto",
      status: "draft",
    } as never);
    mockInvoicesRetrieve.mockResolvedValue({
      id: "in_team_auto",
      status: "open",
    } as never);
    mockInvoiceItemsCreate.mockResolvedValue({ id: "ii_team_auto" } as never);
    mockInvoicesFinalize.mockResolvedValue({
      id: "in_team_auto",
      status: "open",
    } as never);
    mockInvoicesPay.mockResolvedValue({
      id: "in_team_auto",
      status: "paid",
      payment_intent: "pi_team_auto",
    } as never);
    mockInvoicesVoid.mockResolvedValue({
      id: "in_team_auto",
      status: "void",
    } as never);
    mockInvoicesDelete.mockResolvedValue({
      id: "in_team_auto",
      deleted: true,
    } as never);
  });

  it("checks auto-reload after a successful deduction crosses the threshold", async () => {
    mockGetOrganization.mockResolvedValue({ stripeCustomerId: null });
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: 10,
        balancePoints: 100_000,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 7.5,
        autoReloadThresholdPoints: 75_000,
        autoReloadAmountDollars: 15,
        memberDisabled: false,
      })),
      runMutation: makeTeamAutoReloadMutationMock({
        amountDollars: 6.95,
        initialDeduct: {
          success: true,
          newBalancePoints: 70_000,
          newBalanceDollars: extraUsagePointsToDollars(70_000),
          insufficientFunds: false,
          monthlyCapExceeded: false,
          memberCapExceeded: false,
          memberDisabled: false,
          poolDisabled: false,
        },
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 30_000,
    });

    expect(mockGetOrganization).toHaveBeenCalledWith(ORG_ID);
    expect(result).toMatchObject({
      success: true,
      newBalanceDollars: extraUsagePointsToDollars(70_000),
      autoReloadTriggered: true,
      autoReloadResult: { success: false, reason: "no_stripe_customer" },
    });
  });

  it("does not auto-reload when cap precheck blocks an underfunded request", async () => {
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: 0.01,
        balancePoints: 100,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 7.5,
        autoReloadThresholdPoints: 75_000,
        autoReloadAmountDollars: 15,
        memberDisabled: false,
      })),
      runMutation: jest.fn(async () => ({
        success: false,
        newBalancePoints: 100,
        newBalanceDollars: 0.01,
        insufficientFunds: true,
        monthlyCapExceeded: false,
        memberCapExceeded: true,
        memberDisabled: false,
        poolDisabled: false,
      })),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 200,
    });

    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      insufficientFunds: true,
      memberCapExceeded: true,
      autoReloadTriggered: false,
    });
  });

  it("checks auto-reload when the request is larger than the current balance", async () => {
    mockGetOrganization.mockResolvedValue({ stripeCustomerId: null });
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: extraUsagePointsToDollars(200_000),
        balancePoints: 200_000,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 1,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        memberDisabled: false,
      })),
      runMutation: makeTeamAutoReloadMutationMock({
        amountDollars: 11.5,
        initialDeduct: {
          success: false,
          newBalancePoints: 200_000,
          newBalanceDollars: extraUsagePointsToDollars(200_000),
          insufficientFunds: true,
          monthlyCapExceeded: false,
          memberCapExceeded: false,
          memberDisabled: false,
          poolDisabled: false,
        },
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 300_000,
    });

    expect(mockGetOrganization).toHaveBeenCalledWith(ORG_ID);
    expect(ctx.runMutation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      success: false,
      insufficientFunds: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: false, reason: "no_stripe_customer" },
    });
  });

  it("charges enough to cover a team deduction when it exceeds the reload target", async () => {
    mockGetOrganization.mockResolvedValue({ stripeCustomerId: "cus_team" });
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: extraUsagePointsToDollars(200_000),
        balancePoints: 200_000,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 1,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        memberDisabled: false,
      })),
      runMutation: makeTeamAutoReloadMutationMock({
        amountDollars: 11.5,
        initialDeduct: {
          success: false,
          newBalancePoints: 200_000,
          newBalanceDollars: extraUsagePointsToDollars(200_000),
          insufficientFunds: true,
          monthlyCapExceeded: false,
          memberCapExceeded: false,
          memberDisabled: false,
          poolDisabled: false,
        },
        finalDeduct: {
          success: true,
          newBalancePoints: 0,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          memberCapExceeded: false,
          memberDisabled: false,
          poolDisabled: false,
        },
        creditBalance: 34.5,
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 300_000,
    });

    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1150 }),
      { idempotencyKey: "team_reload_op:item" },
    );
    expect(mockInvoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ operationId: "team_reload_op" }),
      }),
      { idempotencyKey: "team_reload_op:invoice" },
    );
    expect(mockInvoicesFinalize).toHaveBeenCalledWith(
      "in_team_auto",
      {},
      { idempotencyKey: "team_reload_op:finalize" },
    );
    expect(mockInvoicesPay).toHaveBeenCalledWith(
      "in_team_auto",
      { payment_method: "pm_card" },
      { idempotencyKey: "team_reload_op:pay" },
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: "team_auto_reload:team_reload_op",
        stripeInvoiceId: "in_team_auto",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 11.5 },
    });
  });

  it("credits and clears a persisted paid invoice without a PaymentIntent", async () => {
    mockInvoicesRetrieve.mockResolvedValueOnce({
      id: "in_team_paid_recovery",
      status: "paid",
    } as never);
    const deductResult = {
      success: true,
      newBalancePoints: 200_000,
      newBalanceDollars: extraUsagePointsToDollars(200_000),
      insufficientFunds: false,
      monthlyCapExceeded: false,
      memberCapExceeded: false,
      memberDisabled: false,
      poolDisabled: false,
    };
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: deductResult.newBalanceDollars,
        balancePoints: deductResult.newBalancePoints,
        autoReloadEnabled: false,
        autoReloadThresholdPoints: 10_000,
        autoReloadOperationPending: true,
        memberDisabled: false,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("amountPoints" in mutationArgs) return deductResult;
        if ("candidateOperationId" in mutationArgs) {
          return {
            status: "operation",
            operationId: "team-paid-recovery-op",
            executorId: "team-paid-recovery-executor",
            amountDollars: 15,
            stripeInvoiceId: "in_team_paid_recovery",
            claimed: true,
            paymentAllowed: false,
            paymentBlockedReason: "auto_reload_disabled",
          };
        }
        if ("amountDollars" in mutationArgs) {
          return { newBalance: 38, alreadyProcessed: false };
        }
        if ("outcome" in mutationArgs) return true;
        return null;
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 10_000,
    });

    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountDollars: 15,
        idempotencyKey: "team_auto_reload:team-paid-recovery-op",
        stripeInvoiceId: "in_team_paid_recovery",
      }),
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: "team-paid-recovery-op",
        outcome: "success",
      }),
    );
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockInvoicesPay).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      newBalanceDollars: 38,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 15 },
    });
  });

  it("does not pay a persisted unpaid invoice when reload is no longer needed", async () => {
    mockInvoicesRetrieve.mockResolvedValueOnce({
      id: "in_team_stale_open",
      status: "open",
    } as never);
    const deductResult = {
      success: true,
      newBalancePoints: 200_000,
      newBalanceDollars: extraUsagePointsToDollars(200_000),
      insufficientFunds: false,
      monthlyCapExceeded: false,
      memberCapExceeded: false,
      memberDisabled: false,
      poolDisabled: false,
    };
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: deductResult.newBalanceDollars,
        balancePoints: deductResult.newBalancePoints,
        autoReloadEnabled: true,
        autoReloadThresholdPoints: 10_000,
        autoReloadOperationPending: true,
        memberDisabled: false,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("amountPoints" in mutationArgs) return deductResult;
        if ("candidateOperationId" in mutationArgs) {
          return {
            status: "operation",
            operationId: "team-stale-open-op",
            executorId: "team-stale-open-executor",
            amountDollars: 15,
            stripeInvoiceId: "in_team_stale_open",
            claimed: true,
            paymentAllowed: false,
            paymentBlockedReason: "not_needed",
          };
        }
        if ("outcome" in mutationArgs) return true;
        throw new Error(
          `Unexpected mutation args: ${JSON.stringify(mutationArgs)}`,
        );
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 10_000,
    });

    expect(mockInvoicesPay).not.toHaveBeenCalled();
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockInvoicesVoid).toHaveBeenCalledWith(
      "in_team_stale_open",
      {},
      { idempotencyKey: "team-stale-open-op:void-stale" },
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: "team-stale-open-op",
        outcome: "released",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: false, reason: "not_needed" },
    });
  });

  it("voids an undersized open operation and retries once for the current request", async () => {
    mockGetOrganization.mockResolvedValue({ stripeCustomerId: "cus_team" });
    mockInvoicesRetrieve.mockResolvedValueOnce({
      id: "in_team_undersized",
      status: "open",
    } as never);
    mockInvoicesVoid.mockResolvedValueOnce({
      id: "in_team_undersized",
      status: "void",
    } as never);
    let deductCalls = 0;
    let claimCalls = 0;
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: 0,
        balancePoints: 0,
        autoReloadEnabled: true,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        autoReloadOperationPending: true,
        memberDisabled: false,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("candidateOperationId" in mutationArgs) {
          claimCalls++;
          return claimCalls === 1
            ? {
                status: "operation",
                operationId: "team-undersized-op",
                executorId: "team-undersized-executor",
                amountDollars: 1,
                stripeInvoiceId: "in_team_undersized",
                claimed: true,
                paymentAllowed: false,
                paymentBlockedReason: "reload_amount_insufficient",
              }
            : {
                status: "operation",
                operationId: "team-correctly-sized-op",
                executorId: "team-correctly-sized-executor",
                amountDollars: 34.5,
                claimed: true,
                paymentAllowed: true,
              };
        }
        if (
          "stripeInvoiceId" in mutationArgs &&
          "operationId" in mutationArgs
        ) {
          return true;
        }
        if ("outcome" in mutationArgs) return true;
        if ("amountDollars" in mutationArgs) {
          return { newBalance: 34.5, alreadyProcessed: false };
        }
        if ("success" in mutationArgs) return null;
        if ("amountPoints" in mutationArgs) {
          deductCalls++;
          return deductCalls === 1
            ? {
                success: false,
                newBalancePoints: 0,
                newBalanceDollars: 0,
                insufficientFunds: true,
                monthlyCapExceeded: false,
                memberCapExceeded: false,
                memberDisabled: false,
                poolDisabled: false,
              }
            : {
                success: true,
                newBalancePoints: 0,
                newBalanceDollars: 0,
                insufficientFunds: false,
                monthlyCapExceeded: false,
                memberCapExceeded: false,
                memberDisabled: false,
                poolDisabled: false,
              };
        }
        throw new Error(
          `Unexpected mutation args: ${JSON.stringify(mutationArgs)}`,
        );
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 300_000,
    });

    expect(claimCalls).toBe(2);
    expect(mockInvoicesVoid).toHaveBeenCalledWith(
      "in_team_undersized",
      {},
      { idempotencyKey: "team-undersized-op:void-stale" },
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: "team-undersized-op",
        outcome: "released",
      }),
    );
    expect(mockInvoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          operationId: "team-correctly-sized-op",
        }),
      }),
      { idempotencyKey: "team-correctly-sized-op:invoice" },
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 34.5 },
    });
  });

  it("retries once when a parallel team run consumes a successful reload", async () => {
    mockGetOrganization.mockResolvedValue({ stripeCustomerId: "cus_team" });
    mockInvoicesCreate
      .mockResolvedValueOnce({
        id: "in_team_parallel_1",
        status: "draft",
      } as never)
      .mockResolvedValueOnce({
        id: "in_team_parallel_2",
        status: "draft",
      } as never);
    mockInvoicesFinalize
      .mockResolvedValueOnce({
        id: "in_team_parallel_1",
        status: "open",
      } as never)
      .mockResolvedValueOnce({
        id: "in_team_parallel_2",
        status: "open",
      } as never);
    mockInvoicesPay
      .mockResolvedValueOnce({
        id: "in_team_parallel_1",
        status: "paid",
      } as never)
      .mockResolvedValueOnce({
        id: "in_team_parallel_2",
        status: "paid",
      } as never);
    let deductCalls = 0;
    let claimCalls = 0;
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        enabled: true,
        balanceDollars: 0,
        balancePoints: 0,
        autoReloadEnabled: true,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        autoReloadOperationPending: false,
        memberDisabled: false,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("candidateOperationId" in mutationArgs) {
          claimCalls++;
          return {
            status: "operation",
            operationId: `team-parallel-op-${claimCalls}`,
            executorId: `team-parallel-executor-${claimCalls}`,
            amountDollars: 15,
            claimed: true,
            paymentAllowed: true,
          };
        }
        if (
          "stripeInvoiceId" in mutationArgs &&
          "operationId" in mutationArgs
        ) {
          return true;
        }
        if ("outcome" in mutationArgs) return true;
        if ("amountDollars" in mutationArgs) {
          return { newBalance: 15, alreadyProcessed: false };
        }
        if ("success" in mutationArgs) return null;
        if ("amountPoints" in mutationArgs) {
          deductCalls++;
          return deductCalls < 3
            ? {
                success: false,
                newBalancePoints: 0,
                newBalanceDollars: 0,
                insufficientFunds: true,
                monthlyCapExceeded: false,
                memberCapExceeded: false,
                memberDisabled: false,
                poolDisabled: false,
              }
            : {
                success: true,
                newBalancePoints: 30_434,
                newBalanceDollars: extraUsagePointsToDollars(30_434),
                insufficientFunds: false,
                monthlyCapExceeded: false,
                memberCapExceeded: false,
                memberDisabled: false,
                poolDisabled: false,
              };
        }
        throw new Error(
          `Unexpected mutation args: ${JSON.stringify(mutationArgs)}`,
        );
      }),
    };

    const result = await callDeductWithAutoReloadForTeam(ctx, {
      organizationId: ORG_ID,
      userId: USER_ID,
      amountPoints: 100_000,
    });

    expect(claimCalls).toBe(2);
    expect(deductCalls).toBe(3);
    expect(mockInvoicesPay).toHaveBeenNthCalledWith(
      1,
      "in_team_parallel_1",
      { payment_method: "pm_card" },
      { idempotencyKey: "team-parallel-op-1:pay" },
    );
    expect(mockInvoicesPay).toHaveBeenNthCalledWith(
      2,
      "in_team_parallel_2",
      { payment_method: "pm_card" },
      { idempotencyKey: "team-parallel-op-2:pay" },
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadResult: { success: true, chargedAmountDollars: 15 },
    });
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

  it("credits the team balance", async () => {
    const { ctx, team } = makeMockCtx();
    const result = await callAddCredits(ctx, {
      organizationId: ORG_ID,
      amountDollars: 25,
    });
    expect(result.alreadyProcessed).toBe(false);
    expect(result.newBalance).toBeCloseTo(25, 2);
    expect(team).toHaveLength(1);
    expect(team[0].balance_points).toBe(extraUsageDollarsToPoints(25));
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
