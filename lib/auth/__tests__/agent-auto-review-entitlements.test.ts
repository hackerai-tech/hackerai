import { getCurrentAgentEntitlementContext } from "@/lib/auth/agent-auto-review-entitlements";

type Clients = NonNullable<
  Parameters<typeof getCurrentAgentEntitlementContext>[1]
>;

const createClients = ({
  memberships = [{}],
  stripeCustomerId = "cus_1",
  subscriptions = [],
}: {
  memberships?: unknown[];
  stripeCustomerId?: string | null;
  subscriptions?: Array<{
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
        list: jest.fn(async () => ({ data: subscriptions })),
      },
    },
  }) satisfies Clients;

describe("getCurrentAgentEntitlementContext", () => {
  it("keeps an unscoped run on the free entitlement", async () => {
    const clients = createClients();

    await expect(
      getCurrentAgentEntitlementContext({ userId: "user_1" }, clients),
    ).resolves.toEqual({ subscription: "free" });
    expect(
      clients.workos.userManagement.listOrganizationMemberships,
    ).not.toHaveBeenCalled();
  });

  it("fails the comparison context when organization membership was removed", async () => {
    const clients = createClients({ memberships: [] });

    await expect(
      getCurrentAgentEntitlementContext(
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
      getCurrentAgentEntitlementContext(
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
      getCurrentAgentEntitlementContext(
        { userId: "user_1", organizationId: "org_1" },
        clients,
      ),
    ).rejects.toThrow("WorkOS unavailable");
  });
});
