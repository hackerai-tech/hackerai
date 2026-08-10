import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
  },
}));

const mockValidateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => mockValidateServiceKey(...args),
}));

function createContext(initialRows: Record<string, any>[] = []) {
  const rows = [...initialRows];
  const insert = jest.fn(async (_table: string, value: Record<string, any>) => {
    rows.push({ _id: `row-${rows.length + 1}`, ...value });
    return `row-${rows.length}`;
  });
  const query = jest.fn(() => {
    let matches = [...rows];
    const chain: any = {
      withIndex: jest.fn((_index: string, build: (q: any) => void) => {
        const filters: Record<string, unknown> = {};
        const q = {
          eq: (field: string, value: unknown) => {
            filters[field] = value;
            return q;
          },
        };
        build(q);
        matches = matches.filter((row) =>
          Object.entries(filters).every(
            ([field, value]) => row[field] === value,
          ),
        );
        return chain;
      }),
      unique: jest.fn(async () => matches[0] ?? null),
      order: jest.fn(() => {
        matches.sort((a, b) => b.occurred_at - a.occurred_at);
        return chain;
      }),
      take: jest.fn(async (limit: number) => matches.slice(0, limit)),
    };
    return chain;
  });

  return { rows, ctx: { db: { insert, query } } };
}

const baseArgs = {
  serviceKey: "service-key",
  stripeEventId: "evt-failed-1",
  stripeEventType: "invoice.payment_failed" as const,
  userId: "user-1",
  stripeCustomerId: "cus-1",
  stripeSubscriptionId: "sub-1",
  stripeInvoiceId: "in-1",
  attemptCount: 1,
  billingFailureGroup: "stripe_risk_block",
  outcomeType: "blocked",
  occurredAt: 100,
};

describe("involuntary churn lifecycle records", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("preserves every Stripe event while keeping invoice attempts stable", async () => {
    const { rows, ctx } = createContext();
    const { recordEvent } = await import("../involuntaryChurn");

    await (recordEvent as any).handler(ctx, baseArgs);
    await (recordEvent as any).handler(ctx, {
      ...baseArgs,
      stripeEventId: "evt-failed-2",
      attemptCount: 2,
      occurredAt: 200,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        idempotency_key: "evt-failed-1:user-1",
        stripe_invoice_id: "in-1",
        attempt_count: 1,
        billing_failure_group: "stripe_risk_block",
        recovery_result: "pending",
      }),
      expect.objectContaining({
        idempotency_key: "evt-failed-2:user-1",
        stripe_invoice_id: "in-1",
        attempt_count: 2,
        recovery_result: "pending",
      }),
    ]);
  });

  it("records a recovered invoice only after a known failure", async () => {
    const { rows, ctx } = createContext([
      {
        _id: "failed-row",
        idempotency_key: "evt-failed-1:user-1",
        stripe_event_id: "evt-failed-1",
        stripe_event_type: "invoice.payment_failed",
        user_id: "user-1",
        stripe_invoice_id: "in-1",
        recovery_result: "pending",
        occurred_at: 100,
      },
    ]);
    const { recordEvent } = await import("../involuntaryChurn");

    const result = await (recordEvent as any).handler(ctx, {
      ...baseArgs,
      stripeEventId: "evt-paid-1",
      stripeEventType: "invoice.paid",
      invoicePaidEligible: true,
      occurredAt: 200,
    });

    expect(result).toEqual({
      inserted: true,
      priorFailureSeen: true,
      recoveryResult: "recovered",
    });
    expect(rows.at(-1)).toMatchObject({
      stripe_event_id: "evt-paid-1",
      stripe_event_type: "invoice.paid",
      stripe_invoice_id: "in-1",
      recovery_result: "recovered",
    });
  });

  it("does not turn a normal successful renewal into recovery", async () => {
    const { rows, ctx } = createContext();
    const { recordEvent } = await import("../involuntaryChurn");

    const result = await (recordEvent as any).handler(ctx, {
      ...baseArgs,
      stripeEventId: "evt-paid-normal",
      stripeEventType: "invoice.paid",
      invoicePaidEligible: true,
    });

    expect(result).toEqual({ inserted: false, priorFailureSeen: false });
    expect(rows).toHaveLength(0);
  });

  it("accepts a recovery proved by the durable credit-hold transition", async () => {
    const { rows, ctx } = createContext();
    const { recordEvent } = await import("../involuntaryChurn");

    const result = await (recordEvent as any).handler(ctx, {
      ...baseArgs,
      stripeEventId: "evt-paid-transition",
      stripeEventType: "invoice.paid",
      invoicePaidEligible: true,
      priorFailureKnown: true,
    });

    expect(result).toMatchObject({
      inserted: true,
      priorFailureSeen: true,
      recoveryResult: "recovered",
    });
    expect(rows.at(-1)).toMatchObject({
      stripe_event_id: "evt-paid-transition",
      recovery_result: "recovered",
    });
  });

  it.each([
    ["customer.subscription.deleted", "churned", false],
    ["payment_method.attached", "payment_method_updated", true],
    ["invoice.paid", "ineligible_payment", true],
  ] as const)(
    "records %s as %s",
    async (stripeEventType, recoveryResult, needsPriorFailure) => {
      const initialRows = needsPriorFailure
        ? [
            {
              _id: "failed-row",
              idempotency_key: "evt-failed-1:user-1",
              stripe_event_id: "evt-failed-1",
              stripe_event_type: "invoice.payment_failed",
              user_id: "user-1",
              stripe_invoice_id: "in-1",
              recovery_result: "pending",
              occurred_at: 100,
            },
          ]
        : [];
      const { rows, ctx } = createContext(initialRows);
      const { recordEvent } = await import("../involuntaryChurn");

      const result = await (recordEvent as any).handler(ctx, {
        ...baseArgs,
        stripeEventId: `evt-${recoveryResult}`,
        stripeEventType,
        invoicePaidEligible:
          stripeEventType === "invoice.paid" ? false : undefined,
        occurredAt: 200,
      });

      expect(result).toMatchObject({ inserted: true, recoveryResult });
      expect(rows.at(-1)).toMatchObject({
        stripe_event_type: stripeEventType,
        recovery_result: recoveryResult,
      });
    },
  );

  it("returns the stored outcome without inserting on Stripe replay", async () => {
    const existing = {
      _id: "failed-row",
      idempotency_key: "evt-failed-1:user-1",
      stripe_event_id: "evt-failed-1",
      stripe_event_type: "invoice.payment_failed",
      user_id: "user-1",
      stripe_invoice_id: "in-1",
      recovery_result: "pending",
      occurred_at: 100,
    };
    const { rows, ctx } = createContext([existing]);
    const { recordEvent } = await import("../involuntaryChurn");

    const result = await (recordEvent as any).handler(ctx, baseArgs);

    expect(result).toEqual({
      inserted: false,
      priorFailureSeen: true,
      recoveryResult: "pending",
    });
    expect(rows).toEqual([existing]);
  });
});
