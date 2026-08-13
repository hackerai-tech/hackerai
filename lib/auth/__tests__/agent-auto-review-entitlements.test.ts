import { resolveCurrentAgentEntitlementContext } from "@/lib/auth/agent-auto-review-entitlements";

type Clients = NonNullable<
  Parameters<typeof resolveCurrentAgentEntitlementContext>[1]
>;

const createClients = ({
  memberships = [{}],
  stripeCustomerId = "cus_1",
  subscriptions = [],
}: {
  memberships?: unknown[];
  stripeCustomerId?: string | null;
  subscriptions?: Array<{
    id?: string;
    status: string;
    items: { data: Array<{ price?: { lookup_key?: string | null } }> };
  }>;
} = {}) =>
  ({
    workos: {
      userManagement: {
        listOrganizationMemberships: jest.fn(async () => ({
          data: memberships,
        })),
      },
      organizations: {
        getOrganization: jest.fn(async () => ({ stripeCustomerId })),
      },
    },
    stripe: {
      subscriptions: {
        list: jest.fn(async () => ({
          data: subscriptions.map((subscription, index) => ({
            id: subscription.id ?? `sub_${index}`,
            ...subscription,
          })),
          has_more: false,
        })),
      },
    },
  }) satisfies Clients;

describe("getCurrentAgentEntitlementContext", () => {
  it("keeps an unscoped run on the free entitlement", async () => {
    const clients = createClients();

    await expect(
      resolveCurrentAgentEntitlementContext({ userId: "user_1" }, clients),
    ).resolves.toEqual({ subscription: "free" });
    expect(
      clients.workos.userManagement.listOrganizationMemberships,
    ).not.toHaveBeenCalled();
  });

  it("fails the comparison context when organization membership was removed", async () => {
    const clients = createClients({ memberships: [] });

    await expect(
      resolveCurrentAgentEntitlementContext(
        { userId: "user_1", organizationId: "org_1" },
        clients,
      ),
    ).resolves.toEqual({ subscription: "free" });
  });

  it("resolves the highest current eligible Stripe-backed tier", async () => {
    const clients = createClients({
      subscriptions: [
        {
          status: "active",
          items: {
            data: [{ price: { lookup_key: "pro-monthly-plan" } }],
          },
        },
        {
          status: "trialing",
          items: {
            data: [{ price: { lookup_key: "ultra-yearly-plan" } }],
          },
        },
        {
          status: "canceled",
          items: {
            data: [{ price: { lookup_key: "team-yearly-plan" } }],
          },
        },
      ],
    });

    await expect(
      resolveCurrentAgentEntitlementContext(
        { userId: "user_1", organizationId: "org_1" },
        clients,
      ),
    ).resolves.toEqual({
      subscription: "ultra",
      organizationId: "org_1",
    });
  });

  it("propagates provider failures so automatic approval fails closed", async () => {
    const clients = createClients();
    clients.workos.userManagement.listOrganizationMemberships = jest.fn(
      async () => {
        throw new Error("WorkOS unavailable");
      },
    );

    await expect(
      resolveCurrentAgentEntitlementContext(
        { userId: "user_1", organizationId: "org_1" },
        clients,
      ),
    ).rejects.toThrow("WorkOS unavailable");
  });

  it("checks later Stripe pages before resolving the current tier", async () => {
    const clients = createClients();
    clients.stripe.subscriptions.list = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "sub_page_1",
            status: "canceled",
            items: { data: [] },
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "sub_page_2",
            status: "active",
            items: {
              data: [{ price: { lookup_key: "pro-plus-monthly-plan" } }],
            },
          },
        ],
        has_more: false,
      });

    await expect(
      resolveCurrentAgentEntitlementContext(
        { userId: "user_1", organizationId: "org_1" },
        clients,
      ),
    ).resolves.toEqual({
      subscription: "pro-plus",
      organizationId: "org_1",
    });
    expect(clients.stripe.subscriptions.list).toHaveBeenNthCalledWith(2, {
      customer: "cus_1",
      status: "all",
      limit: 100,
      starting_after: "sub_page_1",
    });
  });
});
