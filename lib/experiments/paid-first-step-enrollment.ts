import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { workos } from "@/app/api/workos";
import { stripe } from "@/app/api/stripe";
import {
  toCurrentSubscriptionContext,
  CURRENT_SUBSCRIPTION_STATUSES,
} from "@/lib/billing/current-subscription";

/** Read Stripe only on initial enrollment, freezing the schedule before treatment. */
type EnrollmentArgs = {
  userId: string;
  organizationId: string;
  variant: "control" | "test";
  subscription: "pro" | "pro-plus" | "ultra";
  readOnly?: boolean;
};

/** Bound optional billing work; slow dependencies leave current routing intact. */
export async function getPaidFirstStepEnrollment(args: EnrollmentArgs) {
  const deadline = Date.now() + 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadEnrollment(args, deadline),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadEnrollment(args: EnrollmentArgs, deadline: number) {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  const convex = getConvexClient();
  const existing = await convex.query(api.paidModelEnrollments.get, {
    serviceKey,
    user_id: args.userId,
  });
  if (existing)
    return existing.organization_id === args.organizationId ? existing : null;
  if (args.readOnly) return null;
  if (Date.now() >= deadline) return null;

  const membership = await workos.userManagement.listOrganizationMemberships({
    userId: args.userId,
    organizationId: args.organizationId,
    statuses: ["active"],
  });
  if (membership.data.length === 0) return null;
  if (Date.now() >= deadline) return null;
  const organization = await workos.organizations.getOrganization(
    args.organizationId,
  );
  if (!organization.stripeCustomerId) return null;
  if (Date.now() >= deadline) return null;
  const page = await stripe.subscriptions.list(
    {
      customer: organization.stripeCustomerId,
      status: "all",
      limit: 100,
      expand: ["data.items.data.price"],
    },
    { timeout: Math.max(1, deadline - Date.now()), maxNetworkRetries: 0 },
  );
  // Ambiguous billing cannot provide an honest renewal denominator.
  if (page.has_more) return null;
  const current = page.data.filter((s) =>
    CURRENT_SUBSCRIPTION_STATUSES.has(s.status),
  );
  if (current.length !== 1) return null;
  const snapshot = toCurrentSubscriptionContext(current[0]);
  const enrolledAt = Date.now();
  if (enrolledAt >= deadline) return null;
  if (
    snapshot.status !== "active" ||
    snapshot.quantity !== 1 ||
    snapshot.tier !== args.subscription ||
    current[0].items.data.length !== 1 ||
    current[0].pause_collection ||
    !snapshot.currentPeriodEndMs ||
    snapshot.currentPeriodEndMs <= enrolledAt ||
    !snapshot.billingInterval ||
    !snapshot.billingIntervalCount
  )
    return null;
  const enrolled = await convex.mutation(api.paidModelEnrollments.enroll, {
    serviceKey,
    user_id: args.userId,
    organization_id: args.organizationId,
    variant: args.variant,
    enrolled_at: enrolledAt,
    subscription_tier: args.subscription,
    stripe_subscription_id: snapshot.id,
    stripe_customer_id: organization.stripeCustomerId,
    baseline_renewal_at: snapshot.currentPeriodEndMs,
    billing_interval: snapshot.billingInterval,
    billing_interval_count: snapshot.billingIntervalCount,
    subscription_started_at: current[0].start_date * 1000,
    cancel_at_period_end: snapshot.cancelAtPeriodEnd,
    subscription_status: snapshot.status,
  });
  return enrolled?.organization_id === args.organizationId ? enrolled : null;
}
