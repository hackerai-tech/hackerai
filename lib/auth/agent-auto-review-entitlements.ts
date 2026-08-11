import { planLookupKeyToTier } from "@/lib/analytics/paid-funnel";
import type { SubscriptionTier } from "@/types";

const ELIGIBLE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 1,
  "pro-plus": 2,
  team: 3,
  ultra: 4,
};

export type AgentEntitlementClients = {
  workos: {
    userManagement: {
      listOrganizationMemberships(input: {
        userId: string;
        organizationId: string;
        statuses: ["active"];
      }): Promise<{ data: unknown[] }>;
    };
    organizations: {
      getOrganization(organizationId: string): Promise<{
        stripeCustomerId?: string | null;
      }>;
    };
  };
  stripe: {
    subscriptions: {
      list(input: {
        customer: string;
        status: "all";
        limit: number;
        starting_after?: string;
      }): Promise<{
        has_more: boolean;
        data: Array<{
          id: string;
          status: string;
          items: {
            data: Array<{
              price?: { lookup_key?: string | null } | null;
            }>;
          };
        }>;
      }>;
    };
  };
};

export type CurrentAgentEntitlementContext = {
  subscription: SubscriptionTier;
  organizationId?: string;
};

/**
 * Reloads the billing-backed entitlement context used immediately before an
 * Auto review approval. Any lookup failure propagates so the caller fails
 * closed to the human approval path.
 */
export async function resolveCurrentAgentEntitlementContext(
  { userId, organizationId }: { userId: string; organizationId?: string },
  clients: AgentEntitlementClients,
): Promise<CurrentAgentEntitlementContext> {
  if (!organizationId) return { subscription: "free" };

  const memberships =
    await clients.workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId,
      statuses: ["active"],
    });
  if (memberships.data.length === 0) {
    return { subscription: "free" };
  }

  const organization =
    await clients.workos.organizations.getOrganization(organizationId);
  if (!organization.stripeCustomerId) {
    return { subscription: "free", organizationId };
  }

  let subscription: SubscriptionTier = "free";
  let startingAfter: string | undefined;
  do {
    const page = await clients.stripe.subscriptions.list({
      customer: organization.stripeCustomerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const candidate of page.data) {
      if (!ELIGIBLE_SUBSCRIPTION_STATUSES.has(candidate.status)) continue;
      for (const item of candidate.items.data) {
        const tier = planLookupKeyToTier(item.price?.lookup_key ?? undefined);
        if (tier && TIER_RANK[tier] > TIER_RANK[subscription]) {
          subscription = tier;
        }
      }
    }
    if (!page.has_more) break;
    const lastSubscriptionId = page.data.at(-1)?.id;
    if (!lastSubscriptionId || lastSubscriptionId === startingAfter) {
      throw new Error("Stripe subscription pagination did not advance");
    }
    startingAfter = lastSubscriptionId;
  } while (true);

  return { subscription, organizationId };
}
