import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";

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
      retrieve: jest.fn(),
    },
    subscriptions: {
      list: jest.fn(),
    },
  }));
  (Stripe as any).errors = {
    StripeError: class StripeError extends Error {},
  };
  return { __esModule: true, default: Stripe };
});

const ORIGINAL_STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ORIGINAL_WORKOS_API_KEY = process.env.WORKOS_API_KEY;

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test";
  process.env.WORKOS_API_KEY = "workos_test";
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
});

function makeCtx(userId = "user_member") {
  return {
    auth: {
      getUserIdentity: jest.fn(async () => ({ subject: userId })),
    },
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
    expect(result).toEqual({ url: "https://checkout.stripe.test/session" });
  });
});
