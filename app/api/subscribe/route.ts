import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserID } from "@/lib/auth/get-user-id";
import { buildWorkOSOrganizationName } from "@/lib/auth/workos-organization-name";
import { NextRequest, NextResponse, after } from "next/server";
import { getSuspensionMessage } from "@/lib/suspensionMessage";
import { phLogger } from "@/lib/posthog/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import {
  REFERRAL_COOKIE_NAME,
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

function planLookupKeyToTier(
  lookupKey: string,
): "pro" | "pro-plus" | "ultra" | "team" | null {
  if (lookupKey.startsWith("ultra")) return "ultra";
  if (lookupKey.startsWith("pro-plus")) return "pro-plus";
  if (lookupKey.startsWith("team")) return "team";
  if (lookupKey.startsWith("pro")) return "pro";
  return null;
}

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

export const POST = async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => ({}));
    const requestedPlan: string | undefined = body?.plan;
    const requestedQuantity: number | undefined = body?.quantity;
    const posthogDistinctId = req.headers.get("x-posthog-distinct-id");
    const posthogSessionId = req.headers.get("x-posthog-session-id");
    // Get user ID from authenticated session
    const userId = await getUserID(req);

    // Get user details from WorkOS to create a personal organization.
    const user = await workos.userManagement.getUser(userId);
    const orgName = buildWorkOSOrganizationName(user);
    const referralConfig = getReferralRewardConfig();
    const referralCode = req.cookies.get(REFERRAL_COOKIE_NAME)?.value;

    if (
      referralConfig.enabled &&
      referralCode &&
      isValidReferralCode(referralCode)
    ) {
      try {
        const attribution = await convex.mutation(
          api.referrals.attributeReferredSignup,
          {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            referredUserId: userId,
            referralCode,
            starterBonusUnits: 0,
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
            referral_code: referralCode,
            starter_bonus_awarded: attribution.starterBonusAwarded,
            starter_bonus_units: 0,
            source: "subscribe_route",
          });
        }
      } catch (error) {
        phLogger.warn("referral_attribution_failed_before_checkout", {
          userId,
          referral_code: referralCode,
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
        return NextResponse.json(
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
        return NextResponse.json(
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
      return NextResponse.json(
        { error: "Error retrieving price from Stripe" },
        { status: 500 },
      );
    }

    // Check if organization already has a Stripe customer
    let customer;
    let shouldAttachCustomerToOrganization = false;

    if (organization.stripeCustomerId) {
      const existingCustomer = await stripe.customers.retrieve(
        organization.stripeCustomerId,
      );

      if ("deleted" in existingCustomer && existingCustomer.deleted) {
        return NextResponse.json(
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
        return NextResponse.json(
          {
            error: getSuspensionMessage(customer.metadata.blocked_reason),
          },
          { status: 403 },
        );
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
      await workos.organizations.updateOrganization({
        organization: organization.id,
        stripeCustomerId: customer.id,
      });
    }

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      return NextResponse.json(
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

    const session = await stripe.checkout.sessions.create({
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
      },
      subscription_data: {
        metadata: {
          userId,
          workOSOrganizationId: organization.id,
          requestedPlan: subscriptionLevel,
        },
      },
      custom_text: {
        submit: {
          message:
            "Renews monthly until cancelled. Cancel anytime in Settings.",
        },
      },
    });

    if (referralConfig.enabled) {
      try {
        const referralSession = await convex.mutation(
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
    phLogger.event("checkout_started", {
      userId,
      org_id: organization.id,
      from_tier: "free",
      to_tier: planLookupKeyToTier(subscriptionLevel),
      plan: subscriptionLevel,
      billing_interval: selectedPrice.recurring?.interval,
      billing_interval_count: selectedPrice.recurring?.interval_count,
      quantity,
      checkout_amount_dollars:
        selectedPrice.unit_amount != null
          ? (selectedPrice.unit_amount * quantity) / 100
          : undefined,
      currency: selectedPrice.currency,
      stripe_customer_id: customer.id,
      stripe_checkout_session_id: session.id,
      stripe_price_id: selectedPrice.id,
      client_distinct_id: posthogDistinctId ?? undefined,
      $session_id: posthogSessionId ?? undefined,
      $set: {
        last_checkout_started_at: new Date().toISOString(),
      },
    });
    after(() => phLogger.flush());

    return NextResponse.json({ url: session.url });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error(errorMessage, error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
