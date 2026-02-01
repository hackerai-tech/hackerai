import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserID } from "@/lib/auth/get-user-id";
import { NextRequest, NextResponse } from "next/server";

export const POST = async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => ({}));
    const requestedPlan: string | undefined = body?.plan;
    const requestedQuantity: number | undefined = body?.quantity;
    // Get user ID from authenticated session
    const userId = await getUserID(req);

    // Get user details from WorkOS to use email as organization name
    const user = await workos.userManagement.getUser(userId);
    const orgName = user.email;
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
      });

    let organization;

    if (existingMemberships.data && existingMemberships.data.length > 0) {
      // User already has an organization, use the first one
      const membership = existingMemberships.data[0];
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
    }

    if (!customer) {
      // Create new Stripe customer
      customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          workOSOrganizationId: organization.id,
        },
      });

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
    });

    return NextResponse.json({ url: session.url });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error(errorMessage, error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
