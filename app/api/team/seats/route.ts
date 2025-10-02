import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { stripe } from "../../stripe";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

export const PATCH = async (req: NextRequest) => {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    // Only allow team subscription users
    if (subscription !== "team") {
      return NextResponse.json(
        { error: "Team subscription required" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const { quantity } = body;

    // Validate quantity
    if (!quantity || typeof quantity !== "number" || quantity < 2) {
      return NextResponse.json(
        { error: "Quantity must be at least 2" },
        { status: 400 },
      );
    }

    // Get user's organization
    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        userId,
        statuses: ["active"],
      },
    );

    if (!memberships.data || memberships.data.length === 0) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      );
    }

    const organizationId = memberships.data[0].organizationId;

    // Check if user is admin
    const userMembership = memberships.data.find((m) => m.userId === userId);

    if (userMembership?.role?.slug !== "admin") {
      return NextResponse.json(
        { error: "Only admins can update seats" },
        { status: 403 },
      );
    }

    const organization =
      await workos.organizations.getOrganization(organizationId);

    if (!organization.stripeCustomerId) {
      return NextResponse.json(
        { error: "No Stripe customer found" },
        { status: 404 },
      );
    }

    // Get active subscription
    const subscriptions = await stripe.subscriptions.list({
      customer: organization.stripeCustomerId,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return NextResponse.json(
        { error: "No active subscription found" },
        { status: 404 },
      );
    }

    const activeSubscription = subscriptions.data[0];
    const subscriptionItem = activeSubscription.items.data[0];

    if (!subscriptionItem) {
      return NextResponse.json(
        { error: "No subscription item found" },
        { status: 404 },
      );
    }

    // Count current members and pending invitations
    const [allMembers, pendingInvitations] = await Promise.all([
      workos.userManagement.listOrganizationMemberships({
        organizationId,
        statuses: ["active"],
      }),
      workos.userManagement.listInvitations({
        organizationId,
      }),
    ]);

    const currentMembers = allMembers.data.length;
    const pendingInvites = pendingInvitations.data.filter(
      (inv) => inv.state === "pending",
    ).length;
    const totalUsed = currentMembers + pendingInvites;

    // Can't reduce if all seats are in use
    if (totalUsed === subscriptionItem.quantity!) {
      return NextResponse.json(
        {
          error: "Cannot remove seats while all seats are in use",
          details: "Please remove a member or revoke an invitation first.",
        },
        { status: 400 },
      );
    }

    // Can't reduce below current usage
    if (quantity < totalUsed) {
      return NextResponse.json(
        {
          error: "Cannot reduce seats below current usage",
          details: `You have ${currentMembers} members and ${pendingInvites} pending invites (${totalUsed} total). Remove members or revoke invites before reducing seats.`,
        },
        { status: 400 },
      );
    }

    // Only allow decreasing seats
    if (quantity >= subscriptionItem.quantity!) {
      return NextResponse.json(
        {
          error: "Cannot increase seats",
          details: "You can only decrease the number of seats.",
        },
        { status: 400 },
      );
    }

    // Update subscription without proration
    // For seat reductions, we don't issue credits - the change takes effect at the next billing cycle
    await stripe.subscriptionItems.update(subscriptionItem.id, {
      quantity: quantity,
      proration_behavior: "none",
    });

    return NextResponse.json({
      success: true,
      message: `Seats reduced to ${quantity}. The change will take effect at your next billing cycle.`,
      newQuantity: quantity,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to update seats:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
