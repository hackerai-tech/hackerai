import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
  action: jest.fn((config: unknown) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    literal: jest.fn(() => "literal"),
    object: jest.fn(() => "object"),
    optional: jest.fn(() => "optional"),
    string: jest.fn(() => "string"),
    union: jest.fn(() => "union"),
  },
}));

const listOrganizationMemberships = jest.fn();
const getOrganization = jest.fn();
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({
    userManagement: { listOrganizationMemberships },
    organizations: { getOrganization },
  })),
}));

const listSubscriptions = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    subscriptions: { list: listSubscriptions },
  })),
}));

const ORIGINAL_SERVICE_KEY = process.env.CONVEX_SERVICE_ROLE_KEY;
const ORIGINAL_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const ORIGINAL_WORKOS_KEY = process.env.WORKOS_API_KEY;
const SERVICE_KEY = "service_test";

beforeAll(() => {
  process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.STRIPE_SECRET_KEY = "stripe_test";
  process.env.WORKOS_API_KEY = "workos_test";
});

afterAll(() => {
  for (const [name, value] of Object.entries({
    CONVEX_SERVICE_ROLE_KEY: ORIGINAL_SERVICE_KEY,
    STRIPE_SECRET_KEY: ORIGINAL_STRIPE_KEY,
    WORKOS_API_KEY: ORIGINAL_WORKOS_KEY,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const callAction = async ({
  serviceKey = SERVICE_KEY,
  organizationId = "org_1",
}: {
  serviceKey?: string;
  organizationId?: string;
} = {}) => {
  const { getCurrentEntitlementContext } =
    await import("../agentAutoReviewActions");
  return await (getCurrentEntitlementContext as any).handler(null, {
    serviceKey,
    userId: "user_1",
    organizationId,
  });
};

describe("agentAutoReviewActions.getCurrentEntitlementContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listOrganizationMemberships.mockResolvedValue({ data: [{}] } as never);
    getOrganization.mockResolvedValue({
      stripeCustomerId: "cus_1",
    } as never);
    listSubscriptions.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: "sub_1",
          status: "active",
          items: {
            data: [{ price: { lookup_key: "pro-monthly-plan" } }],
          },
        },
      ],
    } as never);
  });

  it("rejects callers without the deployment service key", async () => {
    await expect(callAction({ serviceKey: "wrong" })).rejects.toThrow(
      "Invalid service key",
    );
    expect(listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("resolves billing state through the owning Convex deployment", async () => {
    await expect(callAction()).resolves.toEqual({
      subscription: "pro",
      organizationId: "org_1",
    });
    expect(listOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_1",
      organizationId: "org_1",
      statuses: ["active"],
    });
    expect(listSubscriptions).toHaveBeenCalledWith({
      customer: "cus_1",
      status: "all",
      limit: 100,
    });
  });

  it("propagates provider failures so automatic execution stays closed", async () => {
    listOrganizationMemberships.mockRejectedValueOnce(
      new Error("WorkOS unavailable") as never,
    );

    await expect(callAction()).rejects.toThrow("WorkOS unavailable");
    expect(listSubscriptions).not.toHaveBeenCalled();
  });
});
