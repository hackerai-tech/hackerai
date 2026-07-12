import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  extraUsageDollarsToPoints,
  extraUsagePointsToDollars,
} from "../lib/extraUsagePricing";

jest.mock("../_generated/server", () => ({
  internalMutation: jest.fn((config: any) => config),
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    null: jest.fn(() => "null"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
  },
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("../lib/logger", () => ({
  convexLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../unitEconomicsLib", () => ({
  recordRevenueEventInternal: jest.fn(),
}));

type ExtraUsageRow = {
  _id: string;
  user_id: string;
  balance_points: number;
  auto_reload_enabled?: boolean;
  auto_reload_threshold_points?: number;
  auto_reload_amount_dollars?: number;
  monthly_cap_points?: number;
  monthly_spent_points?: number;
  monthly_reset_date?: string;
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

const USER_ID = "user_123";

function makeCtx(row: ExtraUsageRow) {
  return {
    db: {
      query: jest.fn(() => ({
        withIndex: jest.fn((_index: string, predicate: any) => {
          const proxy = {
            eq: (_field: string, _value: string) => proxy,
          };
          predicate(proxy);
          return { first: async () => row };
        }),
      })),
      patch: jest.fn(async (_id: string, patch: Partial<ExtraUsageRow>) => {
        Object.assign(row, patch);
      }),
    },
  } as any;
}

const baseRow = (overrides: Partial<ExtraUsageRow> = {}): ExtraUsageRow => ({
  _id: "extra-1",
  user_id: USER_ID,
  balance_points: 200_000,
  auto_reload_enabled: true,
  auto_reload_threshold_points: 10_000,
  auto_reload_amount_dollars: 15,
  monthly_cap_points: extraUsageDollarsToPoints(100),
  monthly_spent_points: 0,
  monthly_reset_date: new Date().toISOString().slice(0, 7),
  updated_at: 0,
  ...overrides,
});

async function claim(
  ctx: any,
  args: {
    candidateOperationId: string;
    candidateExecutorId: string;
    requestedAmountPoints: number;
  },
) {
  const { claimAutoReloadOperation } = await import("../extraUsage");
  return (claimAutoReloadOperation as any).handler(ctx, {
    userId: USER_ID,
    ...args,
  });
}

describe("personal auto-reload operation claims", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses surcharge-aware dollars for an oversized deduction", async () => {
    const row = baseRow();
    const result = await claim(makeCtx(row), {
      candidateOperationId: "op-1",
      candidateExecutorId: "executor-1",
      requestedAmountPoints: 300_000,
    });

    expect(result).toMatchObject({
      status: "operation",
      amountDollars: 11.5,
      operationId: "op-1",
      claimed: true,
    });
    expect(row.auto_reload_operation_amount_dollars).toBe(11.5);
  });

  it("keeps the one-dollar minimum for a sub-dollar shortfall", async () => {
    const row = baseRow({ balance_points: 295_000 });
    const result = await claim(makeCtx(row), {
      candidateOperationId: "op-minimum",
      candidateExecutorId: "executor-minimum",
      requestedAmountPoints: 300_000,
    });

    expect(result).toMatchObject({
      status: "operation",
      amountDollars: 1,
    });
    expect(
      row.balance_points +
        extraUsageDollarsToPoints(result.amountDollars as number),
    ).toBeGreaterThanOrEqual(300_000);
  });

  it("clamps a reload to the remaining monthly headroom", async () => {
    const remainingPoints = 10_000;
    const row = baseRow({
      balance_points: 0,
      monthly_cap_points: remainingPoints,
    });
    const result = await claim(makeCtx(row), {
      candidateOperationId: "op-cap",
      candidateExecutorId: "executor-cap",
      requestedAmountPoints: remainingPoints,
    });

    expect(result.status).toBe("operation");
    expect(result.amountDollars).toBe(
      Number(extraUsagePointsToDollars(remainingPoints).toFixed(2)),
    );
    expect(
      extraUsageDollarsToPoints(result.amountDollars as number),
    ).toBeGreaterThanOrEqual(remainingPoints);
  });

  it("allows the one-dollar minimum with exactly one dollar of cap headroom", async () => {
    const oneDollarPoints = extraUsageDollarsToPoints(1);
    const row = baseRow({
      balance_points: 0,
      monthly_cap_points: oneDollarPoints,
    });
    const result = await claim(makeCtx(row), {
      candidateOperationId: "op-exact-minimum-cap",
      candidateExecutorId: "executor-exact-minimum-cap",
      requestedAmountPoints: oneDollarPoints,
    });

    expect(result).toMatchObject({
      status: "operation",
      amountDollars: 1,
    });
    expect(extraUsageDollarsToPoints(result.amountDollars as number)).toBe(
      oneDollarPoints,
    );
  });

  it("gives one executor the operation and rejects stale executor writes", async () => {
    const row = baseRow();
    const ctx = makeCtx(row);
    const first = await claim(ctx, {
      candidateOperationId: "op-first",
      candidateExecutorId: "executor-first",
      requestedAmountPoints: 300_000,
    });
    const second = await claim(ctx, {
      candidateOperationId: "op-second",
      candidateExecutorId: "executor-second",
      requestedAmountPoints: 300_000,
    });

    expect(first).toMatchObject({ operationId: "op-first", claimed: true });
    expect(second).toMatchObject({ operationId: "op-first", claimed: false });

    const { recordAutoReloadInvoice, completeAutoReloadOperation } =
      await import("../extraUsage");
    await expect(
      (recordAutoReloadInvoice as any).handler(ctx, {
        userId: USER_ID,
        operationId: "op-first",
        executorId: "executor-second",
        stripeInvoiceId: "in_wrong",
      }),
    ).resolves.toBe(false);
    await expect(
      (completeAutoReloadOperation as any).handler(ctx, {
        userId: USER_ID,
        operationId: "op-first",
        executorId: "executor-second",
        outcome: "released",
      }),
    ).resolves.toBe(false);

    await (completeAutoReloadOperation as any).handler(ctx, {
      userId: USER_ID,
      operationId: "op-first",
      executorId: "executor-first",
      outcome: "executor_released",
    });
    const takeover = await claim(ctx, {
      candidateOperationId: "op-third",
      candidateExecutorId: "executor-third",
      requestedAmountPoints: 300_000,
    });
    expect(takeover).toMatchObject({
      operationId: "op-first",
      executorId: "executor-third",
      claimed: true,
      paymentAllowed: true,
    });
  });

  it("revalidates an unpaid operation after a manual credit", async () => {
    const row = baseRow();
    const ctx = makeCtx(row);
    await claim(ctx, {
      candidateOperationId: "op-before-credit",
      candidateExecutorId: "executor-before-credit",
      requestedAmountPoints: 300_000,
    });

    const { completeAutoReloadOperation } = await import("../extraUsage");
    await (completeAutoReloadOperation as any).handler(ctx, {
      userId: USER_ID,
      operationId: "op-before-credit",
      executorId: "executor-before-credit",
      outcome: "executor_released",
    });
    row.balance_points = 300_000;

    const resumed = await claim(ctx, {
      candidateOperationId: "op-after-credit",
      candidateExecutorId: "executor-after-credit",
      requestedAmountPoints: 300_000,
    });

    expect(resumed).toMatchObject({
      status: "operation",
      operationId: "op-before-credit",
      claimed: true,
      paymentAllowed: false,
      paymentBlockedReason: "not_needed",
    });
  });

  it("does not resume an operation too small for the current request", async () => {
    const row = baseRow({
      balance_points: 0,
      auto_reload_operation_id: "op-small",
      auto_reload_operation_executor_id: undefined,
      auto_reload_operation_started_at: Date.now(),
      auto_reload_operation_lease_expires_at: 0,
      auto_reload_operation_amount_dollars: 1,
    });

    const resumed = await claim(makeCtx(row), {
      candidateOperationId: "op-large-request",
      candidateExecutorId: "executor-large-request",
      requestedAmountPoints: 300_000,
    });

    expect(resumed).toMatchObject({
      status: "operation",
      operationId: "op-small",
      claimed: true,
      paymentAllowed: false,
      paymentBlockedReason: "reload_amount_insufficient",
    });
  });
});
