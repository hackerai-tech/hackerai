import type { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { workos } from "@/app/api/workos";
import { stripe } from "@/app/api/stripe";
import { readPartnerCookie } from "./cookie";
import { INFLUENCER_COOKIE } from "./policy";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  countryCodeFromHeaders,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";

export function partnerTrackingAllowed(req: NextRequest) {
  return getAnalyticsConsentDecision({
    cookieValue: req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: countryCodeFromHeaders(req.headers),
    failClosed: process.env.NODE_ENV === "production",
  }).analyticsAllowed;
}

export async function attributeInfluencer(
  req: NextRequest,
  user: {
    userId: string;
    email: string;
    identity?: string;
    createdAt: string;
    subscription: string;
  },
) {
  if (
    !user.identity ||
    user.subscription !== "free" ||
    !partnerTrackingAllowed(req)
  )
    return false;
  const click = readPartnerCookie(req.cookies.get(INFLUENCER_COOKIE)?.value);
  if (!click) return false;
  const createdAt = Date.parse(user.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt < click.clickedAt ||
    createdAt > Date.now() ||
    Date.now() - createdAt > 7 * 86400_000
  )
    return false;

  // Free entitlement is not proof of a new billing customer. Check both the
  // user's organizations and email-matched customers before persisting a record
  // that would exclude them from the usage-credit referral program.
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: user.userId,
    statuses: ["active"],
    limit: 100,
  });
  const customers = await stripe.customers.list({
    email: user.email,
    limit: 100,
  });
  if (memberships.listMetadata.after || customers.has_more) return false;
  const customerIds = new Set(customers.data.map((customer) => customer.id));
  for (const membership of memberships.data) {
    const organization = await workos.organizations.getOrganization(
      membership.organizationId,
    );
    if (organization.stripeCustomerId)
      customerIds.add(organization.stripeCustomerId);
  }
  for (const customerId of customerIds) {
    const history = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 1,
    });
    if (history.data.length > 0) return false;
  }
  return await getConvexClient().mutation(api.influencers.attribute, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    identity: user.identity,
    userId: user.userId,
    userCreatedAt: createdAt,
    code: click.code,
    clickedAt: click.clickedAt,
    ...(click.visitorId ? { analyticsVisitorId: click.visitorId } : {}),
  });
}
