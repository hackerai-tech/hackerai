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
const mockInvoiceItemsCreate = jest.fn();
const mockInvoicesFinalize = jest.fn();
const mockInvoicesPay = jest.fn();
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
      finalizeInvoice: mockInvoicesFinalize,
      pay: mockInvoicesPay,
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
    mockInvoicesCreate.mockResolvedValue({ id: "in_auto" } as never);
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
      runMutation: jest.fn(async () => ({
        success: false,
        newBalancePoints: 200_000,
        newBalanceDollars: 20,
        insufficientFunds: true,
        monthlyCapExceeded: false,
      })),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_member",
      statuses: ["active"],
    });
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
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
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("amountDollars" in mutationArgs) return null;
        if ("success" in mutationArgs && !("amountPoints" in mutationArgs)) {
          return null;
        }
        return {
          success: true,
          newBalancePoints: 0,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
        };
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1150 }),
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
      runMutation: jest.fn(async (_mutation: unknown, mutationArgs: any) => {
        if ("amountDollars" in mutationArgs) return null;
        if ("success" in mutationArgs && !("amountPoints" in mutationArgs)) {
          return null;
        }
        return {
          success: true,
          newBalancePoints: 5_000,
          newBalanceDollars: 0.5,
          insufficientFunds: false,
          monthlyCapExceeded: false,
        };
      }),
    };

    const result = await callDeductWithAutoReload(ctx, {
      userId: "user_member",
      amountPoints: 300_000,
    });

    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100 }),
    );
    expect(result).toMatchObject({
      success: true,
      autoReloadTriggered: true,
      autoReloadResult: { success: true, chargedAmountDollars: 1 },
    });
  });
});
