import { getPaidFirstStepEnrollment } from "../paid-first-step-enrollment";
import { getConvexClient } from "@/lib/db/convex-client";
import { workos } from "@/app/api/workos";
import { stripe } from "@/app/api/stripe";

jest.mock("@/convex/_generated/api", () => ({
  api: { paidModelEnrollments: { get: "get", enroll: "enroll" } },
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: { listOrganizationMemberships: jest.fn() },
    organizations: { getOrganization: jest.fn() },
  },
}));
jest.mock("@/app/api/stripe", () => ({
  stripe: { subscriptions: { list: jest.fn() } },
}));

const args = {
  userId: "u",
  organizationId: "org",
  variant: "test" as const,
  subscription: "pro" as const,
};
const convex = { query: jest.fn(), mutation: jest.fn() };
const subscription = {
  id: "sub",
  status: "active",
  start_date: 10,
  cancel_at_period_end: true,
  items: {
    data: [
      {
        id: "item",
        quantity: 1,
        current_period_end: 2_000_000_000,
        price: {
          id: "price",
          lookup_key: "pro-monthly",
          recurring: { interval: "month", interval_count: 1 },
          unit_amount: 2000,
          currency: "usd",
        },
      },
    ],
  },
};
describe("paid enrollment billing snapshot", () => {
  const original = process.env.CONVEX_SERVICE_ROLE_KEY;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "test";
    jest.mocked(getConvexClient).mockReturnValue(convex as never);
    convex.query.mockResolvedValue(null);
    convex.mutation.mockImplementation(async (_name, data) => ({
      _id: "enrollment",
      ...data,
    }));
    jest
      .mocked(workos.userManagement.listOrganizationMemberships)
      .mockResolvedValue({ data: [{}] } as never);
    jest
      .mocked(workos.organizations.getOrganization)
      .mockResolvedValue({ stripeCustomerId: "cus" } as never);
    jest
      .mocked(stripe.subscriptions.list)
      .mockResolvedValue({ data: [subscription], has_more: false } as never);
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    if (original === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = original;
  });
  it("freezes item-level renewal dates and retains pending cancellations", async () => {
    expect(await getPaidFirstStepEnrollment(args)).toMatchObject({
      baseline_renewal_at: 2_000_000_000_000,
      stripe_subscription_id: "sub",
      cancel_at_period_end: true,
      variant: "test",
    });
  });
  it("reuses original billing snapshot without Stripe calls", async () => {
    convex.query.mockResolvedValue({
      organization_id: "org",
      variant: "control",
      baseline_renewal_at: 123,
    });
    expect(await getPaidFirstStepEnrollment(args)).toMatchObject({
      variant: "control",
      baseline_renewal_at: 123,
    });
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  });
  it.each([
    { data: [subscription, subscription], has_more: false },
    { data: [subscription], has_more: true },
    { data: [{ ...subscription, status: "trialing" }], has_more: false },
    {
      data: [{ ...subscription, pause_collection: { behavior: "void" } }],
      has_more: false,
    },
  ])("rejects ambiguous or ineligible billing", async (page) => {
    jest.mocked(stripe.subscriptions.list).mockResolvedValue(page as never);
    expect(await getPaidFirstStepEnrollment(args)).toBeNull();
    expect(convex.mutation).not.toHaveBeenCalled();
  });
  it("fails closed when authenticated organization membership is absent", async () => {
    jest
      .mocked(workos.userManagement.listOrganizationMemberships)
      .mockResolvedValue({ data: [] } as never);
    expect(await getPaidFirstStepEnrollment(args)).toBeNull();
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  });
  it("rejects a stored assignment from another organization", async () => {
    convex.query.mockResolvedValue({ organization_id: "other" });
    expect(await getPaidFirstStepEnrollment(args)).toBeNull();
  });
  it("bounds slow lookup and prevents late billing enrollment", async () => {
    jest.useFakeTimers();
    let release!: (value: null) => void;
    convex.query.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = getPaidFirstStepEnrollment(args);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await pending).toBeNull();
    release(null);
    await jest.advanceTimersByTimeAsync(1);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
  });
});
