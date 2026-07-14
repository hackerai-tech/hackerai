import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import { extraUsagePointsToDollars } from "../lib/extraUsagePricing";

jest.mock("../_generated/server", () => ({
  action: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    null: jest.fn(() => "null"),
    boolean: jest.fn(() => "boolean"),
  },
}));
jest.mock("../lib/logger", () => ({
  convexLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockListOrganizationMemberships = jest.fn();
const mockGetOrganization = jest.fn();
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({
    userManagement: {
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
    organizations: {
      getOrganization: mockGetOrganization,
    },
  })),
}));

const mockCheckoutSessionCreate = jest.fn();
const mockBillingPortalSessionCreate = jest.fn();
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
    checkout: {
      sessions: {
        create: mockCheckoutSessionCreate,
      },
    },
    billingPortal: {
      sessions: {
        create: mockBillingPortalSessionCreate,
      },
    },
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

const ORIGINAL_STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ORIGINAL_WORKOS_API_KEY = process.env.WORKOS_API_KEY;
const ORIGINAL_SERVICE_KEY = process.env.CONVEX_SERVICE_ROLE_KEY;
const SERVICE_KEY = "test-service-key";

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test";
  process.env.WORKOS_API_KEY = "workos_test";
  process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;
});

afterAll(() => {
  if (ORIGINAL_STRIPE_SECRET_KEY === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_SECRET_KEY;
  }
  if (ORIGINAL_WORKOS_API_KEY === undefined) {
    delete process.env.WORKOS_API_KEY;
  } else {
    process.env.WORKOS_API_KEY = ORIGINAL_WORKOS_API_KEY;
  }
  if (ORIGINAL_SERVICE_KEY === undefined) {
    delete process.env.CONVEX_SERVICE_ROLE_KEY;
  } else {
    process.env.CONVEX_SERVICE_ROLE_KEY = ORIGINAL_SERVICE_KEY;
  }
});

function makeCtx(userId = "user_member") {
  return {
    auth: {
      getUserIdentity: jest.fn(async () => ({ subject: userId })),
    },
    runMutation: jest.fn(async () => null),
  };
}

async function callCreatePurchaseSession(ctx: any) {
  const { createPurchaseSession } = await import("../extraUsageActions");
  return (createPurchaseSession as any).handler(ctx, {
    amountDollars: 15,
    baseUrl: "https://hackerai.example/settings",
  });
}

async function callCreateBillingPortalSession(ctx: any) {
  const { createBillingPortalSession } = await import("../extraUsageActions");
  return (createBillingPortalSession as any).handler(ctx, {
    flow: "payment_method",
    baseUrl: "https://hackerai.example/settings",
  });
}

async function callDeductWithAutoReload(
  ctx: any,
  args: { userId: string; amountPoints: number },
) {
  const { deductWithAutoReload } = await import("../extraUsageActions");
  return (deductWithAutoReload as any).handler(ctx, {
    serviceKey: SERVICE_KEY,
    ...args,
  });
}

const claimedAutoReload = (amountDollars: number) => ({
  status: "operation",
  operationId: "reload_op",
  executorId: "reload_executor",
  amountDollars,
  startedAt: Date.now(),
  claimed: true,
  paymentAllowed: true,
});

function makeAutoReloadMutationMock({
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
      return claimedAutoReload(amountDollars);
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

describe("extraUsageActions billing authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckoutSessionCreate.mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.test/session",
    } as never);
    mockBillingPortalSessionCreate.mockResolvedValue({
      url: "https://billing.stripe.test/session",
    } as never);
    mockGetOrganization.mockResolvedValue({
      stripeCustomerId: "cus_team",
    } as never);
  });

  it("rejects a non-admin active org member before creating a Checkout session", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "member" },
        },
      ],
    } as never);

    const result = await callCreatePurchaseSession(makeCtx());

    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_member",
      statuses: ["active"],
    });
    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      url: null,
      error: "No Stripe customer found. Please subscribe first.",
    });
  });

  it("rejects a non-admin active org member before creating a Billing Portal session", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "member" },
        },
      ],
    } as never);

    const result = await callCreateBillingPortalSession(makeCtx());

    expect(mockGetOrganization).not.toHaveBeenCalled();
    expect(mockBillingPortalSessionCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ url: null, error: "No billing account found" });
  });

  it("uses an active admin membership when creating a Checkout session", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);

    const result = await callCreatePurchaseSession(makeCtx("user_admin"));

    expect(mockGetOrganization).toHaveBeenCalledWith("org_team");
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_team",
        metadata: expect.objectContaining({
          userId: "user_admin",
        }),
      }),
    );
    expect(result).toEqual({
      url: "https://checkout.stripe.test/session",
      checkoutSessionId: "cs_test",
    });
  });

  it("records the purchase row after creating a Checkout session", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);

    const ctx = makeCtx("user_admin");
    const result = await callCreatePurchaseSession(ctx);
    const { internal } = await import("../_generated/api");

    expect(ctx.runMutation).toHaveBeenCalledWith(
      internal.extraUsage.recordPurchaseCreated,
      expect.objectContaining({
        userId: "user_admin",
        amountDollars: 15,
        stripeCheckoutSessionId: "cs_test",
      }),
    );
    expect(result).toEqual({
      url: "https://checkout.stripe.test/session",
      checkoutSessionId: "cs_test",
    });
  });

  it("still returns the Checkout session when purchase recording fails", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);

    const ctx = makeCtx("user_admin");
    ctx.runMutation.mockRejectedValueOnce(new Error("Convex unavailable"));

    const result = await callCreatePurchaseSession(ctx);

    expect(result).toEqual({
      url: "https://checkout.stripe.test/session",
      checkoutSessionId: "cs_test",
    });
  });
});

describe("deductWithAutoReload", () => {
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
      id: "in_auto",
      status: "draft",
    } as never);
    mockInvoicesRetrieve.mockResolvedValue({
      id: "in_auto",
      status: "open",
    } as never);
    mockInvoiceItemsCreate.mockResolvedValue({ id: "ii_auto" } as never);
    mockInvoicesFinalize.mockResolvedValue({
      id: "in_auto",
      status: "open",
    } as never);
    mockInvoicesPay.mockResolvedValue({
      id: "in_auto",
      status: "paid",
      payment_intent: "pi_auto",
    } as never);
    mockInvoicesVoid.mockResolvedValue({
      id: "in_auto",
      status: "void",
    } as never);
    mockInvoicesDelete.mockResolvedValue({
      id: "in_auto",
      deleted: true,
    } as never);
  });

  it("attempts auto-reload when the request is larger than the current balance", async () => {
    mockListOrganizationMemberships.mockResolvedValue({ data: [] } as never);
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: extraUsagePointsToDollars(200_000),
        balancePoints: 200_000,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 1,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        monthlyRemainingDollars: 100,
      })),
      runMutation: makeAutoReloadMutationMock({
        amountDollars: 11.5,
        initialDeduct: {
          success: false,
          newBalancePoints: 200_000,
          newBalanceDollars: 23,
          insufficientFunds: true,
          monthlyCapExceeded: false,
        },
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_member",
      statuses: ["active"],
    });
    expect(ctx.runMutation).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      success: false,
      insufficientFunds: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: false, reason: "no_stripe_customer" },
    });
  });

  it("does not auto-reload when the monthly cap cannot cover the request", async () => {
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: 0,
        balancePoints: 0,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 5,
        autoReloadThresholdPoints: 50_000,
        autoReloadAmountDollars: 50,
        monthlyRemainingDollars: 1,
      })),
      runMutation: jest.fn(async () => ({
        success: false,
        newBalancePoints: 0,
        newBalanceDollars: 0,
        insufficientFunds: false,
        monthlyCapExceeded: true,
      })),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 20_000,
    });

    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      monthlyCapExceeded: true,
      autoReloadTriggered: false,
    });
  });

  it("charges enough to cover the requested deduction when it exceeds the reload target", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      stripeCustomerId: "cus_team",
    } as never);
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: extraUsagePointsToDollars(200_000),
        balancePoints: 200_000,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 1,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        monthlyRemainingDollars: 100,
      })),
      runMutation: makeAutoReloadMutationMock({
        amountDollars: 11.5,
        initialDeduct: {
          success: false,
          newBalancePoints: 200_000,
          newBalanceDollars: 23,
          insufficientFunds: true,
          monthlyCapExceeded: false,
        },
        finalDeduct: {
          success: true,
          newBalancePoints: 0,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
        },
        creditBalance: 34.5,
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1150 }),
      { idempotencyKey: "reload_op:item" },
    );
    expect(mockInvoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ operationId: "reload_op" }),
      }),
      { idempotencyKey: "reload_op:invoice" },
    );
    expect(mockInvoicesFinalize).toHaveBeenCalledWith(
      "in_auto",
      {},
      { idempotencyKey: "reload_op:finalize" },
    );
    expect(mockInvoicesPay).toHaveBeenCalledWith(
      "in_auto",
      { payment_method: "pm_card" },
      { idempotencyKey: "reload_op:pay" },
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: "personal_auto_reload:reload_op",
        stripeInvoiceId: "in_auto",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 11.5 },
    });
  });

  it("uses the minimum charge when a request is underfunded by less than one dollar", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      stripeCustomerId: "cus_team",
    } as never);
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: extraUsagePointsToDollars(295_000),
        balancePoints: 295_000,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdDollars: 1,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        monthlyRemainingDollars: 100,
      })),
      runMutation: makeAutoReloadMutationMock({
        amountDollars: 1,
        initialDeduct: {
          success: false,
          newBalancePoints: 295_000,
          newBalanceDollars: extraUsagePointsToDollars(295_000),
          insufficientFunds: true,
          monthlyCapExceeded: false,
        },
        finalDeduct: {
          success: true,
          newBalancePoints: 3_695,
          newBalanceDollars: extraUsagePointsToDollars(3_695),
          insufficientFunds: false,
          monthlyCapExceeded: false,
        },
        creditBalance: extraUsagePointsToDollars(295_000) + 1,
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100 }),
      { idempotencyKey: "reload_op:item" },
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 1 },
    });
  });

  it("credits and clears a persisted paid invoice without a PaymentIntent", async () => {
    mockInvoicesRetrieve.mockResolvedValueOnce({
      id: "in_paid_recovery",
      status: "paid",
    } as never);
    const deductResult = {
      success: true,
      newBalancePoints: 200_000,
      newBalanceDollars: extraUsagePointsToDollars(200_000),
      insufficientFunds: false,
      monthlyCapExceeded: false,
    };
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: deductResult.newBalanceDollars,
        balancePoints: deductResult.newBalancePoints,
        enabled: true,
        autoReloadEnabled: false,
        autoReloadThresholdPoints: 10_000,
        autoReloadOperationPending: true,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("amountPoints" in mutationArgs) return deductResult;
        if ("candidateOperationId" in mutationArgs) {
          return {
            status: "operation",
            operationId: "paid-recovery-op",
            executorId: "paid-recovery-executor",
            amountDollars: 15,
            stripeInvoiceId: "in_paid_recovery",
            claimed: true,
            paymentAllowed: false,
            paymentBlockedReason: "auto_reload_disabled",
          };
        }
        if ("amountDollars" in mutationArgs) {
          return { newBalance: 38, alreadyProcessed: true };
        }
        if ("outcome" in mutationArgs) return true;
        return null;
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 10_000,
    });

    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amountDollars: 15,
        idempotencyKey: "personal_auto_reload:paid-recovery-op",
        stripeInvoiceId: "in_paid_recovery",
      }),
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: "paid-recovery-op",
        outcome: "success",
      }),
    );
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
    expect(mockInvoicesPay).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      newBalanceDollars: deductResult.newBalanceDollars,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 15 },
    });
  });

  it("does not pay a persisted unpaid invoice when reload is no longer needed", async () => {
    mockInvoicesRetrieve.mockResolvedValueOnce({
      id: "in_stale_open",
      status: "open",
    } as never);
    const deductResult = {
      success: true,
      newBalancePoints: 200_000,
      newBalanceDollars: extraUsagePointsToDollars(200_000),
      insufficientFunds: false,
      monthlyCapExceeded: false,
    };
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: deductResult.newBalanceDollars,
        balancePoints: deductResult.newBalancePoints,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdPoints: 10_000,
        autoReloadOperationPending: true,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("amountPoints" in mutationArgs) return deductResult;
        if ("candidateOperationId" in mutationArgs) {
          return {
            status: "operation",
            operationId: "stale-open-op",
            executorId: "stale-open-executor",
            amountDollars: 15,
            stripeInvoiceId: "in_stale_open",
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

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 10_000,
    });

    expect(mockInvoicesPay).not.toHaveBeenCalled();
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
    expect(mockInvoicesVoid).toHaveBeenCalledWith(
      "in_stale_open",
      {},
      { idempotencyKey: "stale-open-op:void-stale" },
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: "stale-open-op",
        outcome: "released",
      }),
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: false, reason: "not_needed" },
    });
  });

  it("retires an undersized id-less operation and retries once for the current request", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({
      stripeCustomerId: "cus_team",
    } as never);
    let deductCalls = 0;
    let claimCalls = 0;
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: 0,
        balancePoints: 0,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        autoReloadOperationPending: true,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("candidateOperationId" in mutationArgs) {
          claimCalls++;
          return claimCalls === 1
            ? {
                status: "operation",
                operationId: "undersized-idless-op",
                executorId: "undersized-idless-executor",
                amountDollars: 1,
                claimed: true,
                paymentAllowed: false,
                paymentBlockedReason: "reload_amount_insufficient",
              }
            : {
                status: "operation",
                operationId: "correctly-sized-op",
                executorId: "correctly-sized-executor",
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
              }
            : {
                success: true,
                newBalancePoints: 0,
                newBalanceDollars: 0,
                insufficientFunds: false,
                monthlyCapExceeded: false,
              };
        }
        throw new Error(
          `Unexpected mutation args: ${JSON.stringify(mutationArgs)}`,
        );
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(claimCalls).toBe(2);
    expect(ctx.runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationId: "undersized-idless-op",
        outcome: "released",
      }),
    );
    expect(mockInvoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          operationId: "correctly-sized-op",
        }),
      }),
      { idempotencyKey: "correctly-sized-op:invoice" },
    );
    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3450 }),
      { idempotencyKey: "correctly-sized-op:item" },
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 34.5 },
    });
  });

  it("retries once when a parallel run consumes a successful reload before deduction", async () => {
    mockListOrganizationMemberships.mockResolvedValue({
      data: [
        {
          organizationId: "org_team",
          status: "active",
          role: { slug: "admin" },
        },
      ],
    } as never);
    mockGetOrganization.mockResolvedValue({ stripeCustomerId: "cus_team" });
    mockInvoicesCreate
      .mockResolvedValueOnce({ id: "in_parallel_1", status: "draft" } as never)
      .mockResolvedValueOnce({ id: "in_parallel_2", status: "draft" } as never);
    mockInvoicesFinalize
      .mockResolvedValueOnce({ id: "in_parallel_1", status: "open" } as never)
      .mockResolvedValueOnce({ id: "in_parallel_2", status: "open" } as never);
    mockInvoicesPay
      .mockResolvedValueOnce({ id: "in_parallel_1", status: "paid" } as never)
      .mockResolvedValueOnce({ id: "in_parallel_2", status: "paid" } as never);
    let deductCalls = 0;
    let claimCalls = 0;
    const ctx: any = {
      runQuery: jest.fn(async () => ({
        balanceDollars: 0,
        balancePoints: 0,
        enabled: true,
        autoReloadEnabled: true,
        autoReloadThresholdPoints: 10_000,
        autoReloadAmountDollars: 15,
        autoReloadOperationPending: false,
      })),
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("candidateOperationId" in mutationArgs) {
          claimCalls++;
          return {
            status: "operation",
            operationId: `parallel-op-${claimCalls}`,
            executorId: `parallel-executor-${claimCalls}`,
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
              }
            : {
                success: true,
                newBalancePoints: 30_434,
                newBalanceDollars: extraUsagePointsToDollars(30_434),
                insufficientFunds: false,
                monthlyCapExceeded: false,
              };
        }
        throw new Error(
          `Unexpected mutation args: ${JSON.stringify(mutationArgs)}`,
        );
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 100_000,
    });

    expect(claimCalls).toBe(2);
    expect(deductCalls).toBe(3);
    expect(mockInvoicesPay).toHaveBeenNthCalledWith(
      1,
      "in_parallel_1",
      { payment_method: "pm_card" },
      { idempotencyKey: "parallel-op-1:pay" },
    );
    expect(mockInvoicesPay).toHaveBeenNthCalledWith(
      2,
      "in_parallel_2",
      { payment_method: "pm_card" },
      { idempotencyKey: "parallel-op-2:pay" },
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadResult: { success: true, chargedAmountDollars: 15 },
    });
  });
});
