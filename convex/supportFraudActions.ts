"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import Stripe from "stripe";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import {
  applySupportConfirmedFraudSuspension,
  buildSupportConfirmedFraudSuspensionPlan,
} from "../lib/billing/support-confirmed-fraud";
import type { SupportConfirmedFraudSuspensionPlan } from "../lib/billing/support-confirmed-fraud";

let stripeInstance: Stripe | null = null;
let workosInstance: WorkOS | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) throw new Error("STRIPE_SECRET_KEY not configured");
    stripeInstance = new Stripe(secretKey);
  }
  return stripeInstance;
}

function getWorkOS(): WorkOS {
  if (!workosInstance) {
    const apiKey = process.env.WORKOS_API_KEY;
    const clientId = process.env.WORKOS_CLIENT_ID;
    if (!apiKey || !clientId) {
      throw new Error("WORKOS_API_KEY and WORKOS_CLIENT_ID not configured");
    }
    workosInstance = new WorkOS(apiKey, { clientId });
  }
  return workosInstance;
}

async function resolveCustomerUsers(customerId: string) {
  const stripe = getStripe();
  const workos = getWorkOS();

  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.id !== customerId) {
      return { userIds: [], orgId: null, reason: "customer_id_mismatch" };
    }
    if (customer.deleted) {
      return { userIds: [], orgId: null, reason: "customer_deleted" };
    }

    const orgId = customer.metadata?.workOSOrganizationId ?? null;
    if (!orgId) {
      return {
        userIds: [],
        orgId: null,
        reason: "missing_workos_organization_metadata",
      };
    }

    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        organizationId: orgId,
        statuses: ["active"],
      },
    );
    const allMemberships = await memberships.autoPagination();
    const userIds = allMemberships.map((membership) => membership.userId);

    return userIds.length > 0
      ? { userIds, orgId }
      : { userIds: [], orgId, reason: "no_active_memberships" };
  } catch {
    return { userIds: [], orgId: null, reason: "lookup_failed" };
  }
}

const resultValidator = v.object({
  applied: v.boolean(),
  suspensionId: v.union(v.id("user_suspensions"), v.null()),
  category: v.literal("support_confirmed_fraud"),
  source: v.literal("support"),
  sourceId: v.string(),
  sourceReason: v.literal("confirmed_unauthorized_charge"),
  sourceCreatedAt: v.number(),
  userId: v.string(),
  stripeCustomerId: v.string(),
  stripeChargeId: v.string(),
  workosOrganizationId: v.string(),
  chargeAmount: v.number(),
  chargeCurrency: v.string(),
  chargeDisputed: v.boolean(),
  chargeRefunded: v.boolean(),
});

type SupportFraudActionResult = SupportConfirmedFraudSuspensionPlan & {
  applied: boolean;
  suspensionId: Id<"user_suspensions"> | null;
};

/**
 * Run this internal action from the production Convex dashboard. Pass
 * execute=false first to verify the resolved Stripe and WorkOS identifiers,
 * then rerun the same arguments with execute=true to create the suspension.
 */
export const suspendSupportConfirmedFraud = internalAction({
  args: {
    chargeId: v.string(),
    customerId: v.string(),
    userId: v.string(),
    caseId: v.string(),
    execute: v.boolean(),
  },
  returns: resultValidator,
  handler: async (ctx, args): Promise<SupportFraudActionResult> => {
    const plan = await buildSupportConfirmedFraudSuspensionPlan(args, {
      retrieveCharge: async (chargeId) =>
        await getStripe().charges.retrieve(chargeId),
      resolveCustomerUsers,
    });

    if (!args.execute) {
      return { ...plan, applied: false, suspensionId: null };
    }

    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      throw new Error("CONVEX_SERVICE_ROLE_KEY not configured");
    }

    const suspensionId: Id<"user_suspensions"> =
      await applySupportConfirmedFraudSuspension(plan, {
        upsertActive: async (suspension): Promise<Id<"user_suspensions">> =>
          await ctx.runMutation(api.userSuspensions.upsertActive, {
            serviceKey,
            ...suspension,
          }),
      });

    return { ...plan, applied: true, suspensionId };
  },
});
