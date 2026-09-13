"use node";

import { WorkOS } from "@workos-inc/node";
import Stripe from "stripe";
import { v } from "convex/values";

import type { AgentEntitlementClients } from "../lib/auth/agent-auto-review-entitlements";
import { resolveCurrentAgentEntitlementContext } from "../lib/auth/agent-auto-review-entitlements";
import { action } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";

const subscriptionTierValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("team"),
  v.literal("ultra"),
);

let stripeInstance: Stripe | null = null;
let workosInstance: WorkOS | null = null;

const getStripe = (): Stripe => {
  if (!stripeInstance) {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) throw new Error("STRIPE_SECRET_KEY not configured");
    stripeInstance = new Stripe(apiKey);
  }
  return stripeInstance;
};

const getWorkOS = (): WorkOS => {
  if (!workosInstance) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) throw new Error("WORKOS_API_KEY not configured");
    workosInstance = new WorkOS(apiKey, {
      clientId: process.env.WORKOS_CLIENT_ID,
    });
  }
  return workosInstance;
};

const entitlementClients: AgentEntitlementClients = {
  workos: {
    userManagement: {
      listOrganizationMemberships: async (input) => {
        const memberships =
          await getWorkOS().userManagement.listOrganizationMemberships(input);
        return { data: memberships.data };
      },
    },
    organizations: {
      getOrganization: async (organizationId) => {
        const organization =
          await getWorkOS().organizations.getOrganization(organizationId);
        return { stripeCustomerId: organization.stripeCustomerId };
      },
    },
  },
  stripe: {
    subscriptions: {
      list: async (input) => {
        const subscriptions = await getStripe().subscriptions.list(input);
        return {
          has_more: subscriptions.has_more,
          data: subscriptions.data.map((subscription) => ({
            id: subscription.id,
            status: subscription.status,
            items: {
              data: subscription.items.data.map((item) => ({
                price: { lookup_key: item.price.lookup_key },
              })),
            },
          })),
        };
      },
    },
  },
};

/**
 * Resolves the current billing-backed entitlement in the deployment that owns
 * the Agent run's Convex state. Trigger workers intentionally do not need
 * direct WorkOS or Stripe credentials.
 */
export const getCurrentEntitlementContext = action({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    organizationId: v.optional(v.string()),
  },
  returns: v.object({
    subscription: subscriptionTierValidator,
    organizationId: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await resolveCurrentAgentEntitlementContext(
      {
        userId: args.userId,
        organizationId: args.organizationId,
      },
      entitlementClients,
    );
  },
});
