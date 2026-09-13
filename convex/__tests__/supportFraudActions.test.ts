import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const upsertActiveRef = Symbol("userSuspensions.upsertActive");

jest.mock("../_generated/server", () => ({
  internalAction: jest.fn((config: any) => config),
}));
jest.mock("../_generated/api", () => ({
  api: {
    userSuspensions: {
      upsertActive: upsertActiveRef,
    },
  },
}));
jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
  },
}));

const retrieveCharge = jest.fn();
const retrieveCustomer = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    charges: { retrieve: retrieveCharge },
    customers: { retrieve: retrieveCustomer },
  })),
}));

const listOrganizationMemberships = jest.fn();
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({
    userManagement: { listOrganizationMemberships },
  })),
}));

const ORIGINAL_ENV = {
  stripe: process.env.STRIPE_SECRET_KEY,
  workos: process.env.WORKOS_API_KEY,
  workosClientId: process.env.WORKOS_CLIENT_ID,
  serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY,
};

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test";
  process.env.WORKOS_API_KEY = "workos_test";
  process.env.WORKOS_CLIENT_ID = "client_test";
  process.env.CONVEX_SERVICE_ROLE_KEY = "service_test";
});

afterAll(() => {
  for (const [name, value] of Object.entries({
    STRIPE_SECRET_KEY: ORIGINAL_ENV.stripe,
    WORKOS_API_KEY: ORIGINAL_ENV.workos,
    WORKOS_CLIENT_ID: ORIGINAL_ENV.workosClientId,
    CONVEX_SERVICE_ROLE_KEY: ORIGINAL_ENV.serviceKey,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const args = {
  chargeId: "ch_123",
  customerId: "cus_123",
  userId: "user_123",
  caseId: "intercom_456",
};

function makeCtx() {
  return {
    runMutation: jest.fn<any>().mockResolvedValue("suspension_123"),
  };
}

async function callAction(ctx: ReturnType<typeof makeCtx>, execute: boolean) {
  const { suspendSupportConfirmedFraud } =
    await import("../supportFraudActions");
  return (suspendSupportConfirmedFraud as any).handler(ctx, {
    ...args,
    execute,
  });
}

describe("support fraud internal action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    retrieveCharge.mockResolvedValue({
      id: "ch_123",
      customer: "cus_123",
      amount: 13_999,
      currency: "usd",
      disputed: false,
      refunded: false,
    } as never);
    retrieveCustomer.mockResolvedValue({
      id: "cus_123",
      deleted: false,
      metadata: { workOSOrganizationId: "org_123" },
    } as never);
    listOrganizationMemberships.mockResolvedValue({
      autoPagination: async () => [{ userId: "user_123" }],
    } as never);
  });

  it("previews the verified production plan without writing", async () => {
    const ctx = makeCtx();

    await expect(callAction(ctx, false)).resolves.toEqual(
      expect.objectContaining({
        applied: false,
        suspensionId: null,
        category: "support_confirmed_fraud",
        source: "support",
        sourceId: "support_case:intercom_456",
        userId: "user_123",
        stripeCustomerId: "cus_123",
        stripeChargeId: "ch_123",
        workosOrganizationId: "org_123",
        chargeAmount: 13_999,
        chargeCurrency: "usd",
      }),
    );
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(listOrganizationMemberships).toHaveBeenCalledWith({
      organizationId: "org_123",
      statuses: ["active"],
    });
  });

  it("applies the verified suspension using the deployment service key", async () => {
    const ctx = makeCtx();

    await expect(callAction(ctx, true)).resolves.toEqual(
      expect.objectContaining({
        applied: true,
        suspensionId: "suspension_123",
      }),
    );
    expect(ctx.runMutation).toHaveBeenCalledWith(upsertActiveRef, {
      serviceKey: "service_test",
      category: "support_confirmed_fraud",
      source: "support",
      sourceId: "support_case:intercom_456",
      sourceReason: "confirmed_unauthorized_charge",
      sourceCreatedAt: expect.any(Number),
      userId: "user_123",
      stripeCustomerId: "cus_123",
      stripeChargeId: "ch_123",
      workosOrganizationId: "org_123",
    });
  });

  it("refuses a mismatched Stripe customer before writing", async () => {
    const ctx = makeCtx();
    retrieveCharge.mockResolvedValueOnce({
      id: "ch_123",
      customer: "cus_other",
      amount: 13_999,
      currency: "usd",
      disputed: false,
      refunded: false,
    } as never);

    await expect(callAction(ctx, true)).rejects.toThrow(
      "does not belong to customer cus_123",
    );
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("refuses a user outside the customer organization before writing", async () => {
    const ctx = makeCtx();
    listOrganizationMemberships.mockResolvedValueOnce({
      autoPagination: async () => [{ userId: "user_other" }],
    } as never);

    await expect(callAction(ctx, true)).rejects.toThrow(
      "is not an active member of customer cus_123",
    );
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("fails closed when the deployment service key is unavailable", async () => {
    const ctx = makeCtx();
    delete process.env.CONVEX_SERVICE_ROLE_KEY;

    try {
      await expect(callAction(ctx, true)).rejects.toThrow(
        "CONVEX_SERVICE_ROLE_KEY not configured",
      );
      expect(ctx.runMutation).not.toHaveBeenCalled();
    } finally {
      process.env.CONVEX_SERVICE_ROLE_KEY = "service_test";
    }
  });
});
