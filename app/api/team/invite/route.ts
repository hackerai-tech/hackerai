import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { stripe } from "../../stripe";

export const POST = async (req: NextRequest) => {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    // Only allow team subscription users to access this endpoint
    if (subscription !== "team") {
      return NextResponse.json(
        { error: "Team subscription required" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const { email } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
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

    const userMembership = memberships.data[0];
    const organizationId = userMembership.organizationId;

    // Check if user is an admin
    if (userMembership.role?.slug !== "admin") {
      return NextResponse.json(
        { error: "Only admins can invite members" },
        { status: 403 },
      );
    }

    // Get organization to access Stripe customer ID
    const organization =
      await workos.organizations.getOrganization(organizationId);

    // Check seat limit from Stripe subscription
    if (organization.stripeCustomerId) {
      const subscriptions = await stripe.subscriptions.list({
        customer: organization.stripeCustomerId,
        status: "active",
        limit: 1,
      });

      if (subscriptions.data.length > 0) {
        const subscription = subscriptions.data[0];
        const quantity = subscription.items.data[0]?.quantity || 1;

        // Count current active members
        const currentMembers =
          await workos.userManagement.listOrganizationMemberships({
            organizationId,
            statuses: ["active"],
          });

        if (currentMembers.data.length >= quantity) {
          return NextResponse.json(
            {
              error: "Seat limit reached",
              details: `You have ${currentMembers.data.length} members and ${quantity} seats. Please upgrade to add more members.`,
            },
            { status: 400 },
          );
        }
      }
    }

    // Check if user is already a member
    try {
      const users = await workos.userManagement.listUsers({
        email,
        limit: 1,
      });

      if (users.data.length > 0) {
        const invitedUser = users.data[0];

        // Check if already a member
        const existingMembership =
          await workos.userManagement.listOrganizationMemberships({
            userId: invitedUser.id,
            organizationId,
          });

        if (existingMembership.data.length > 0) {
          return NextResponse.json(
            { error: "User is already a member of this organization" },
            { status: 400 },
          );
        }
      }
    } catch (error) {
      console.log("User lookup failed, will send invitation anyway");
    }

    // Always send an invitation for explicit consent
    // This works for both existing and new users
    await workos.userManagement.sendInvitation({
      email,
      organizationId,
      inviterUserId: userId,
      roleSlug: "member",
    });

    return NextResponse.json({
      success: true,
      message: "Invitation sent successfully",
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to invite team member:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};

export const DELETE = async (req: NextRequest) => {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    // Only allow team subscription users to access this endpoint
    if (subscription !== "team") {
      return NextResponse.json(
        { error: "Team subscription required" },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const invitationId = searchParams.get("id");

    if (!invitationId) {
      return NextResponse.json(
        { error: "Invitation ID is required" },
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

    const userMembership = memberships.data[0];
    const organizationId = userMembership.organizationId;

    // Check if user is an admin
    if (userMembership.role?.slug !== "admin") {
      return NextResponse.json(
        { error: "Only admins can revoke invitations" },
        { status: 403 },
      );
    }

    // Get the invitation to verify it belongs to the organization
    const invitation = await workos.userManagement.getInvitation(invitationId);

    if (invitation.organizationId !== organizationId) {
      return NextResponse.json(
        { error: "Invitation not found in your organization" },
        { status: 404 },
      );
    }

    // Revoke the invitation
    await workos.userManagement.revokeInvitation(invitationId);

    return NextResponse.json({
      success: true,
      message: "Invitation revoked successfully",
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to revoke invitation:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
