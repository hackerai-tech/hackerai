import { partnerCookie } from "../cookie";
const mockMutation = jest.fn();
const mockMemberships = jest.fn();
const mockOrganization = jest.fn();
const mockCustomers = jest.fn();
const mockSubscriptions = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));
jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: { listOrganizationMemberships: mockMemberships },
    organizations: { getOrganization: mockOrganization },
  },
}));
jest.mock("@/app/api/stripe", () => ({
  stripe: {
    customers: { list: mockCustomers },
    subscriptions: { list: mockSubscriptions },
  },
}));
const { attributeInfluencer } =
  require("../attribution") as typeof import("../attribution");

describe("shared influencer signup/checkout eligibility", () => {
  const now = 1_700_000_000_000;
  const user = {
    userId: "user_new",
    email: "customer@example.test",
    identity: "free_quota:v1:customer",
    subscription: "free",
    createdAt: new Date(now - 1000).toISOString(),
  };
  const request = () =>
    ({
      headers: new Headers({ "x-vercel-ip-country": "US" }),
      cookies: {
        get: (name: string) =>
          name === "hackerai_partner"
            ? { value: partnerCookie("medusa", now - 2000) }
            : undefined,
      },
    }) as any;
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(now);
    process.env.WORKOS_COOKIE_PASSWORD = "test-signing-key";
    mockMutation.mockReset().mockResolvedValue(true);
    mockMemberships
      .mockReset()
      .mockResolvedValue({ data: [], listMetadata: {} });
    mockCustomers.mockReset().mockResolvedValue({ data: [], has_more: false });
    mockOrganization
      .mockReset()
      .mockResolvedValue({ stripeCustomerId: "cus_org" });
    mockSubscriptions.mockReset().mockResolvedValue({ data: [] });
  });
  afterEach(() => jest.restoreAllMocks());
  it("attributes a new account with no billing history", async () => {
    expect(await attributeInfluencer(request(), user)).toBe(true);
    expect(mockMutation).toHaveBeenCalledTimes(1);
  });
  it("rejects a free account whose organization previously subscribed before persisting", async () => {
    mockMemberships.mockResolvedValue({
      data: [{ organizationId: "org_existing" }],
      listMetadata: {},
    });
    mockSubscriptions.mockResolvedValue({ data: [{ status: "canceled" }] });
    expect(await attributeInfluencer(request(), user)).toBe(false);
    expect(mockSubscriptions).toHaveBeenCalledWith({
      customer: "cus_org",
      status: "all",
      limit: 1,
    });
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("checks email-matched customers even before an organization is attached", async () => {
    mockCustomers.mockResolvedValue({
      data: [{ id: "cus_email" }],
      has_more: false,
    });
    mockSubscriptions.mockResolvedValue({
      data: [{ status: "incomplete_expired" }],
    });
    expect(await attributeInfluencer(request(), user)).toBe(false);
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("fails closed on history lookup errors and truncated customer lists", async () => {
    mockCustomers.mockResolvedValue({ data: [], has_more: true });
    expect(await attributeInfluencer(request(), user)).toBe(false);
    mockCustomers.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(attributeInfluencer(request(), user)).rejects.toThrow(
      "Stripe unavailable",
    );
    expect(mockMutation).not.toHaveBeenCalled();
  });
});
