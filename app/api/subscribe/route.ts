import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { buildWorkOSOrganizationName } from "@/lib/auth/workos-organization-name";
import { NextRequest, NextResponse, after } from "next/server";
import { getSuspensionMessage } from "@/lib/suspensionMessage";
import { phLogger } from "@/lib/posthog/server";
import { logger } from "@/lib/logger";
import { ChatSDKError } from "@/lib/errors";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import type Stripe from "stripe";
import {
  REFERRAL_COOKIE_CREATED_AT_NAME,
  REFERRAL_COOKIE_NAME,
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";
import {
  PAID_FUNNEL_EVENTS,
  createCheckoutAttemptId,
  normalizePaidFunnelLabel,
  normalizeCheckoutAttemptId,
  paidFunnelTierFromUnknown,
  paidFunnelProperties,
  planLookupKeyToTier,
} from "@/lib/analytics/paid-funnel";

function canManageOrganizationBilling(
  membership: Awaited<
    ReturnType<typeof workos.userManagement.listOrganizationMemberships>
  >["data"][number],
) {
  return membership.role?.slug === "admin" || membership.role?.slug === "owner";
}

function parseCreatedAtMs(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function clearReferralCookies(response: NextResponse) {
  response.cookies.delete(REFERRAL_COOKIE_NAME);
  response.cookies.delete(REFERRAL_COOKIE_CREATED_AT_NAME);
}

function isReusableCheckoutSession(
  session: Stripe.Checkout.Session,
  {
    organizationId,
    requestedPlan,
    quantity,
  }: {
    organizationId: string;
    requestedPlan: string;
    quantity: number;
  },
): boolean {
  if (!session.url) return false;
  if (session.metadata?.workOSOrganizationId !== organizationId) return false;
  if (session.metadata?.requestedPlan !== requestedPlan) return false;

  const checkoutQuantity = session.metadata?.checkoutQuantity;
  return checkoutQuantity
    ? checkoutQuantity === String(quantity)
    : quantity === 1;
}

function getErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getEnvironment(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
}

const CHECKOUT_SESSION_PAGE_SIZE = 100;
const MAX_CHECKOUT_SESSION_PAGES = 5;
const WORKOS_UPDATE_RETRY_DELAY_MS = process.env.NODE_ENV === "test" ? 0 : 250;
const STRIPE_LOCK_TIMEOUT_RETRY_DELAY_MS =
  process.env.NODE_ENV === "test" ? 0 : 500;

function isWorkOSRequestTimeout(error: unknown): boolean {
  return error instanceof Error && /request timeout/i.test(error.message);
}

async function attachStripeCustomerToOrganization({
  organizationId,
  customerId,
  userId,
  requestId,
}: {
  organizationId: string;
  customerId: string;
  userId: string;
  requestId: string;
}): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await workos.organizations.updateOrganization({
        organization: organizationId,
        stripeCustomerId: customerId,
      });
      return;
    } catch (error) {
      if (!isWorkOSRequestTimeout(error) || attempt === 2) throw error;

      logger.warn("Retrying timed-out WorkOS organization update", {
        event: "billing.workos_organization_update_retry_scheduled",
        request_id: requestId,
        service: "hackerai-web",
        environment: getEnvironment(),
        route: "/api/subscribe",
        user_id: userId,
        organization_id: organizationId,
        stripe_customer_id: customerId,
        attempt,
        next_attempt: attempt + 1,
        retry_delay_ms: WORKOS_UPDATE_RETRY_DELAY_MS,
        workos_error_name: error instanceof Error ? error.name : typeof error,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, WORKOS_UPDATE_RETRY_DELAY_MS),
      );
    }
  }
}

async function retrieveStripeCustomer({
  customerId,
  organizationId,
  userId,
  requestId,
}: {
  customerId: string;
  organizationId: string;
  userId: string;
  requestId: string;
}): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await stripe.customers.retrieve(customerId);
    } catch (error) {
      const stripeErrorCode = getErrorString(error, "code");
      if (stripeErrorCode !== "lock_timeout" || attempt === 2) throw error;

      logger.warn("Retrying Stripe customer retrieval after lock timeout", {
        event: "billing.stripe_customer_retrieve_retry_scheduled",
        request_id: requestId,
        service: "hackerai-web",
        environment: getEnvironment(),
        route: "/api/subscribe",
        user_id: userId,
        organization_id: organizationId,
        stripe_customer_id: customerId,
        stripe_error_code: stripeErrorCode,
        stripe_request_id: getErrorString(error, "requestId"),
        attempt,
        next_attempt: attempt + 1,
        retry_delay_ms: STRIPE_LOCK_TIMEOUT_RETRY_DELAY_MS,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, STRIPE_LOCK_TIMEOUT_RETRY_DELAY_MS),
      );
    }
  }

  throw new Error("Stripe customer retrieval exhausted without a result");
}

async function findReusableCheckoutSession({
  customerId,
  organizationId,
  requestedPlan,
  quantity,
}: {
  customerId: string;
  organizationId: string;
  requestedPlan: string;
  quantity: number;
}): Promise<Stripe.Checkout.Session | undefined> {
  let startingAfter: string | undefined;

  for (let page = 0; page < MAX_CHECKOUT_SESSION_PAGES; page += 1) {
    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: CHECKOUT_SESSION_PAGE_SIZE,
      ...(startingAfter && { starting_after: startingAfter }),
    });
    const reusableSession = sessions.data.find((candidate) =>
      isReusableCheckoutSession(candidate, {
        organizationId,
        requestedPlan,
        quantity,
      }),
    );

    if (reusableSession) return reusableSession;
    if (!sessions.has_more) return undefined;

    startingAfter = sessions.data.at(-1)?.id;
    if (!startingAfter) return undefined;
  }

  return undefined;
}

export const POST = async (req: NextRequest) => {
  const requestId = req.headers.get("x-vercel-id") ?? "unknown";
  let shouldClearReferralCookies = false;
  const json = (body: unknown, init?: ResponseInit) => {
    const response = NextResponse.json(body, init);
    if (shouldClearReferralCookies) {
      clearReferralCookies(response);
    }
    return response;
  };

  try {
    const body = await req.json().catch(() => ({}));
    const requestedPlan: string | undefined = body?.plan;
    const requestedQuantity: number | undefined = body?.quantity;
    const checkoutAttemptId =
      normalizeCheckoutAttemptId(body?.checkoutAttemptId) ??
      createCheckoutAttemptId();
    const checkoutSource = normalizePaidFunnelLabel(body?.source);
    const checkoutSurface = normalizePaidFunnelLabel(body?.surface);
    const checkoutReason = normalizePaidFunnelLabel(body?.reason);
    const checkoutLimitType = normalizePaidFunnelLabel(
      body?.limitType ?? body?.limit_type,
    );
    const fromTier = paidFunnelTierFromUnknown(body?.fromTier);
    const posthogSessionId = req.headers.get("x-posthog-session-id");
    // Get user ID and subscription state from authenticated session
    const { userId, subscription, freeQuotaSubject } =
      await getUserIDAndPro(req);

    // Get user details from WorkOS to create a personal organization.
    const user = await workos.userManagement.getUser(userId);
    const orgName = buildWorkOSOrganizationName(user);
    const referralConfig = getReferralRewardConfig();
    const referralCode = req.cookies.get(REFERRAL_COOKIE_NAME)?.value;
    const validReferralCode = isValidReferralCode(referralCode)
      ? referralCode
      : undefined;
    const canRecordReferralCheckoutSession = subscription === "free";

    if (validReferralCode && subscription !== "free") {
      shouldClearReferralCookies = true;
    }

    if (
      referralConfig.enabled &&
      validReferralCode &&
      canRecordReferralCheckoutSession
    ) {
      try {
        const attribution = await getConvexClient().mutation(
          api.referrals.attributeReferredSignup,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            referredUserId: userId,
            referralCode: validReferralCode,
            starterBonusUnits: 0,
            referredIdentityHash: freeQuotaSubject,
            userCreatedAtMs: parseCreatedAtMs(user.createdAt),
            maxUserAgeDays: referralConfig.attributionMaxUserAgeDays,
            source: "subscribe_route_referral_cookie",
          },
        );

        if (attribution.status === "attributed") {
          const referrerSubscriptionTier = (
            attribution as { referrerSubscriptionTier?: string }
          ).referrerSubscriptionTier;

          phLogger.event("referred_signup_attributed", {
            userId,
            referrer_user_id: attribution.referrerUserId,
            referrer_subscription_tier: referrerSubscriptionTier,
            referral_code: validReferralCode,
            starter_bonus_awarded: attribution.starterBonusAwarded,
            starter_bonus_units: 0,
            source: "subscribe_route",
          });
        }
      } catch (error) {
        phLogger.warn("referral_attribution_failed_before_checkout", {
          userId,
          referral_code: validReferralCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const allowedPlans = new Set([
      "pro-monthly-plan",
      "pro-plus-monthly-plan",
      "ultra-monthly-plan",
      "pro-yearly-plan",
      "pro-plus-yearly-plan",
      "ultra-yearly-plan",
      "team-monthly-plan",
      "team-yearly-plan",
    ]);
    const subscriptionLevel =
      typeof requestedPlan === "string" && allowedPlans.has(requestedPlan)
        ? (requestedPlan as
            | "pro-monthly-plan"
            | "pro-plus-monthly-plan"
            | "ultra-monthly-plan"
            | "pro-yearly-plan"
            | "pro-plus-yearly-plan"
            | "ultra-yearly-plan"
            | "team-monthly-plan"
            | "team-yearly-plan")
        : "pro-monthly-plan";

    // Quantity is only used for team plans, defaults to 1 for individual plans
    const quantity =
      requestedQuantity && requestedQuantity >= 1 ? requestedQuantity : 1;

    // Check if user already has an organization
    const existingMemberships =
      await workos.userManagement.listOrganizationMemberships({
        userId,
        statuses: ["active"],
      });

    let organization;

    if (existingMemberships.data && existingMemberships.data.length > 0) {
      // User already has an organization, use the first one
      const membership = existingMemberships.data[0];
      if (!canManageOrganizationBilling(membership)) {
        return json(
          { error: "Only organization admins or owners can manage billing" },
          { status: 403 },
        );
      }

      organization = await workos.organizations.getOrganization(
        membership.organizationId,
      );
    } else {
      // Create new organization for the user
      organization = await workos.organizations.createOrganization({
        name: orgName,
      });

      await workos.userManagement.createOrganizationMembership({
        organizationId: organization.id,
        userId,
        roleSlug: "admin",
      });
    }

    // Retrieve price ID from Stripe
    // The Stripe look up key for the price *must* be the same as the subscription level string
    let price;

    try {
      price = await stripe.prices.list({
        lookup_keys: [subscriptionLevel],
      });

      // Check if price data exists and has at least one item
      if (!price.data || price.data.length === 0) {
        console.error(
          `No price found for lookup key: ${subscriptionLevel}. This is likely because the products and prices have not been created yet. Run the setup script \`pnpm run setup\` to automatically create them.`,
        );
        return json(
          {
            error: "Subscription plan not found",
            details: `No price found for plan: ${subscriptionLevel}`,
          },
          { status: 404 },
        );
      }
    } catch (error) {
      console.error(
        `Error retrieving price from Stripe for lookup key: ${subscriptionLevel}. This is likely because the products and prices have not been created yet. Run the setup script \`pnpm run setup\` to automatically create them.`,
        error,
      );
      return json(
        { error: "Error retrieving price from Stripe" },
        { status: 500 },
      );
    }

    // Check if organization already has a Stripe customer
    let customer;
    let shouldAttachCustomerToOrganization = false;

    if (organization.stripeCustomerId) {
      const existingCustomer = await retrieveStripeCustomer({
        customerId: organization.stripeCustomerId,
        organizationId: organization.id,
        userId,
        requestId,
      });

      if ("deleted" in existingCustomer && existingCustomer.deleted) {
        return json(
          { error: "Billing account is no longer available" },
          { status: 409 },
        );
      }

      customer = existingCustomer;
    } else {
      // Try to find existing customer by email and organization metadata
      const existingCustomers = await stripe.customers.list({
        email: user.email,
        limit: 10, // Get more to check metadata
      });

      // Look for a customer with matching organization ID in metadata
      const matchingCustomer = existingCustomers.data.find(
        (c) => c.metadata.workOSOrganizationId === organization.id,
      );

      if (matchingCustomer) {
        customer = matchingCustomer;
        shouldAttachCustomerToOrganization = true;
      }
    }

    if (customer) {
      // Reject blocked customers (flagged by fraud webhook)
      if (customer.metadata.blocked === "true") {
        return json(
          {
            error: getSuspensionMessage(customer.metadata.blocked_reason),
          },
          { status: 403 },
        );
      }

      if (!customer.metadata.workOSOrganizationId) {
        customer = await stripe.customers.update(customer.id, {
          metadata: {
            ...customer.metadata,
            workOSOrganizationId: organization.id,
          },
        });
      }
    }

    if (!customer) {
      // Create new Stripe customer
      customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          workOSOrganizationId: organization.id,
        },
      });

      shouldAttachCustomerToOrganization = true;
    }

    if (shouldAttachCustomerToOrganization) {
      // Update WorkOS organization with Stripe customer ID
      // This will allow WorkOS to automatically add entitlements to the access token
      await attachStripeCustomerToOrganization({
        organizationId: organization.id,
        customerId: customer.id,
        userId,
        requestId,
      });
    }

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      return json(
        { error: "NEXT_PUBLIC_BASE_URL is not configured" },
        { status: 500 },
      );
    }

    // Build success and cancel URLs with a refresh hint so the client can refresh
    // entitlements exactly when returning from checkout/billing portal
    const successUrl = new URL(baseUrl);
    successUrl.searchParams.set("refresh", "entitlements");

    // Add team welcome param for team plans
    if (
      subscriptionLevel === "team-monthly-plan" ||
      subscriptionLevel === "team-yearly-plan"
    ) {
      successUrl.searchParams.set("team-welcome", "true");
    }

    const cancelUrl = new URL(baseUrl);

    let session = await findReusableCheckoutSession({
      customerId: customer.id,
      organizationId: organization.id,
      requestedPlan: subscriptionLevel,
      quantity,
    });
    const reusedCheckoutSession = Boolean(session);

    if (!session) {
      session = await stripe.checkout.sessions.create({
        customer: customer.id,
        billing_address_collection: "auto",
        line_items: [
          {
            price: price.data[0].id,
            quantity: quantity,
          },
        ],
        mode: "subscription",
        success_url: successUrl.toString(),
        cancel_url: cancelUrl.toString(),
        metadata: {
          userId,
          workOSOrganizationId: organization.id,
          requestedPlan: subscriptionLevel,
          checkoutQuantity: String(quantity),
          checkoutAttemptId,
          ...(checkoutSource && { checkoutSource }),
          ...(checkoutSurface && { checkoutSurface }),
          ...(checkoutReason && { checkoutReason }),
          ...(checkoutLimitType && { checkoutLimitType }),
          checkoutType: "new_subscription",
        },
        subscription_data: {
          metadata: {
            userId,
            workOSOrganizationId: organization.id,
            requestedPlan: subscriptionLevel,
            checkoutQuantity: String(quantity),
            checkoutAttemptId,
            ...(checkoutSource && { checkoutSource }),
            ...(checkoutSurface && { checkoutSurface }),
            ...(checkoutReason && { checkoutReason }),
            ...(checkoutLimitType && { checkoutLimitType }),
            checkoutType: "new_subscription",
          },
        },
        custom_text: {
          submit: {
            message:
              "Renews monthly until cancelled. Cancel anytime in Settings.",
          },
        },
      });
    } else {
      const previousCheckoutAttemptId = session.metadata?.checkoutAttemptId;
      session = await stripe.checkout.sessions.update(session.id, {
        metadata: {
          ...session.metadata,
          userId,
          workOSOrganizationId: organization.id,
          requestedPlan: subscriptionLevel,
          checkoutQuantity: String(quantity),
          checkoutAttemptId,
          ...(checkoutSource && { checkoutSource }),
          ...(checkoutSurface && { checkoutSurface }),
          ...(checkoutReason && { checkoutReason }),
          ...(checkoutLimitType && { checkoutLimitType }),
          checkoutType: "new_subscription",
        },
      });
      logger.warn("Reused an open Stripe Checkout Session", {
        event: "billing.checkout_session_reused",
        request_id: requestId,
        service: "hackerai-web",
        environment: getEnvironment(),
        route: "/api/subscribe",
        user_id: userId,
        organization_id: organization.id,
        checkout_attempt_id: checkoutAttemptId,
        stripe_customer_id: customer.id,
        stripe_checkout_session_id: session.id,
        previous_checkout_attempt_id: previousCheckoutAttemptId,
        requested_plan: subscriptionLevel,
        quantity,
        checkout_source: checkoutSource,
        checkout_surface: checkoutSurface,
        checkout_reason: checkoutReason,
        checkout_limit_type: checkoutLimitType,
      });
    }

    if (
      !reusedCheckoutSession &&
      referralConfig.enabled &&
      canRecordReferralCheckoutSession
    ) {
      try {
        const referralSession = await getConvexClient().mutation(
          api.referrals.recordReferralCheckoutSession,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            referredUserId: userId,
            stripeCustomerId: customer.id,
            stripeCheckoutSessionId: session.id,
            requestedPlan: subscriptionLevel,
          },
        );

        if (referralSession?.recorded) {
          const referrerSubscriptionTier = (
            referralSession as { referrerSubscriptionTier?: string }
          ).referrerSubscriptionTier;

          phLogger.event("referral_stripe_checkout_session_created", {
            userId,
            referrer_user_id: referralSession.referrerUserId,
            referrer_subscription_tier: referrerSubscriptionTier,
            referral_code: referralSession.referralCode,
            checkout_attempt_id: checkoutAttemptId,
            stripe_customer_id: customer.id,
            stripe_checkout_session_id: session.id,
            requested_plan: subscriptionLevel,
          });
        }
      } catch (error) {
        phLogger.warn("referral_checkout_session_record_failed", {
          userId,
          stripe_customer_id: customer.id,
          stripe_checkout_session_id: session.id,
          requested_plan: subscriptionLevel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const selectedPrice = price.data[0];
    phLogger.event(
      PAID_FUNNEL_EVENTS.checkoutStarted,
      paidFunnelProperties({
        userId,
        org_id: organization.id,
        checkout_attempt_id: checkoutAttemptId,
        checkout_type: "new_subscription",
        from_tier: fromTier,
        to_tier: planLookupKeyToTier(subscriptionLevel),
        plan: subscriptionLevel,
        billing_interval: selectedPrice.recurring?.interval,
        billing_interval_count: selectedPrice.recurring?.interval_count,
        quantity,
        surface: checkoutSurface,
        source: checkoutSource,
        reason: checkoutReason,
        limit_type: checkoutLimitType,
        checkout_amount_dollars:
          selectedPrice.unit_amount != null
            ? (selectedPrice.unit_amount * quantity) / 100
            : undefined,
        currency: selectedPrice.currency,
        stripe_customer_id: customer.id,
        stripe_checkout_session_id: session.id,
        stripe_checkout_session_reused: reusedCheckoutSession,
        stripe_price_id: selectedPrice.id,
        $session_id: posthogSessionId ?? undefined,
        $insert_id: `${PAID_FUNNEL_EVENTS.checkoutStarted}:${checkoutAttemptId}`,
        $set: {
          last_checkout_started_at: new Date().toISOString(),
        },
      }),
    );
    after(() => phLogger.flush());

    return json({ url: session.url, checkoutAttemptId });
  } catch (error: unknown) {
    if (error instanceof ChatSDKError) {
      return json(
        {
          error: error.message,
          code: `${error.type}:${error.surface}`,
        },
        { status: error.statusCode },
      );
    }

    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    const stripeErrorCode = getErrorString(error, "code");
    const stripeRequestId = getErrorString(error, "requestId");
    logger.error(
      "Subscription checkout request failed",
      error instanceof Error ? error : undefined,
      {
        event: "billing.subscribe_request_failed",
        request_id: requestId,
        service: "hackerai-web",
        environment: getEnvironment(),
        route: "/api/subscribe",
        stripe_error_code: stripeErrorCode,
        stripe_request_id: stripeRequestId,
      },
    );

    if (stripeErrorCode === "customer_max_subscriptions") {
      return json(
        {
          error:
            "A checkout is already pending. Please resume it or contact support if the problem continues.",
        },
        { status: 409 },
      );
    }

    return json({ error: errorMessage }, { status: 500 });
  }
};
