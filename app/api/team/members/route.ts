import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { stripe } from "../../stripe";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

export const GET = async (req: NextRequest) => {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    // Only allow team subscription users to access this endpoint
    if (subscription !== "team") {
      return NextResponse.json(
        { error: "Team subscription required" },
        { status: 403 },
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
    const isAdmin = memberships.data[0].role?.slug === "admin";

    // Get organization details, all members, and pending invitations in parallel
    const [organization, allMembers, pendingInvitations] = await Promise.all([
      workos.organizations.getOrganization(organizationId),
      workos.userManagement.listOrganizationMemberships({
        organizationId,
        statuses: ["active"],
      }),
      workos.userManagement.listInvitations({
        organizationId,
      }),
    ]);

    // Get user details for each member
    const membersWithDetails = await Promise.all(
      allMembers.data.map(async (member) => {
        const user = await workos.userManagement.getUser(member.userId);
        return {
          id: member.id,
          userId: member.userId,
          email: user.email,
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          role: member.role?.slug || "member",
          createdAt: member.createdAt,
          isCurrentUser: member.userId === userId,
        };
      }),
    );

    const currentSeats = allMembers.data.length;
    let totalSeats = currentSeats; // Default to current if no Stripe info
    let billingPeriod: "monthly" | "yearly" | null = null;

    // Get seat limit from Stripe subscription if available
    if (organization.stripeCustomerId) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: organization.stripeCustomerId,
          status: "active",
          limit: 1,
        });

        if (subscriptions.data.length > 0) {
          const stripeSubscription = subscriptions.data[0];
          totalSeats =
            stripeSubscription.items.data[0]?.quantity || currentSeats;

          // Determine billing period from the price
          const priceId = stripeSubscription.items.data[0]?.price.id;
          if (priceId) {
            const price = await stripe.prices.retrieve(priceId);
            if (price.recurring?.interval === "year") {
              billingPeriod = "yearly";
            } else if (price.recurring?.interval === "month") {
              billingPeriod = "monthly";
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch Stripe subscription:", error);
        // Continue with default values
      }
    }

    // Get pending invitations (only those not yet accepted/revoked/expired)
    const invitationsWithDetails = pendingInvitations.data
      .filter((invitation) => invitation.state === "pending")
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: "member",
        status: "pending" as const,
        invitedAt: invitation.createdAt,
        expiresAt: invitation.expiresAt,
      }));

    const pendingInvitationsCount = invitationsWithDetails.length;
    const availableSeats = Math.max(
      0,
      totalSeats - (currentSeats + pendingInvitationsCount),
    );

    return NextResponse.json({
      members: membersWithDetails,
      invitations: invitationsWithDetails,
      teamInfo: {
        teamId: organization.id,
        teamName: organization.name,
        currentSeats,
        totalSeats,
        availableSeats,
        billingPeriod,
      },
      isAdmin,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to fetch team data:", error);
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
    const membershipId = searchParams.get("id");

    if (!membershipId) {
      return NextResponse.json(
        { error: "Membership ID is required" },
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

    // Try to get the membership first (it might be an invitation instead)
    let isInvitation = false;
    try {
      const membershipToDelete =
        await workos.userManagement.getOrganizationMembership(membershipId);

      // Verify it belongs to the same organization
      if (membershipToDelete.organizationId !== organizationId) {
        return NextResponse.json(
          { error: "Member not found in your organization" },
          { status: 404 },
        );
      }

      // Check if this is the last admin
      const allMembers =
        await workos.userManagement.listOrganizationMemberships({
          organizationId,
          statuses: ["active"],
        });

      const adminCount = allMembers.data.filter(
        (m) => m.role?.slug === "admin",
      ).length;

      // Allow non-admins to remove themselves (leave team)
      const isSelfRemoval = membershipToDelete.userId === userId;
      const isRemoverAdmin = userMembership.role?.slug === "admin";

      if (isSelfRemoval) {
        // If you're an admin trying to leave
        if (membershipToDelete.role?.slug === "admin" && adminCount <= 1) {
          return NextResponse.json(
            {
              error: "Cannot leave as the last admin",
              details:
                "You must have at least one admin in the organization. Please promote another member to admin before leaving.",
            },
            { status: 400 },
          );
        }
        // Non-admins can always leave
      } else {
        // Removing another member - only admins can do this
        if (!isRemoverAdmin) {
          return NextResponse.json(
            { error: "Only admins can remove other members" },
            { status: 403 },
          );
        }

        // Admins can't remove other admins if it's the last one
        if (membershipToDelete.role?.slug === "admin" && adminCount <= 1) {
          return NextResponse.json(
            {
              error: "Cannot remove the last admin",
              details:
                "You must have at least one admin in the organization. Please promote another member to admin before removing this user.",
            },
            { status: 400 },
          );
        }
      }

      // Delete the membership
      await workos.userManagement.deleteOrganizationMembership(membershipId);
    } catch (error) {
      // If membership not found, it might be an invitation
      isInvitation = true;
    }

    // If it's an invitation, revoke it instead
    if (isInvitation) {
      try {
        const invitation =
          await workos.userManagement.getInvitation(membershipId);

        // Verify it belongs to the same organization
        if (invitation.organizationId !== organizationId) {
          return NextResponse.json(
            { error: "Invitation not found in your organization" },
            { status: 404 },
          );
        }

        // Revoke the invitation
        await workos.userManagement.revokeInvitation(membershipId);
      } catch (inviteError) {
        return NextResponse.json(
          { error: "Member or invitation not found" },
          { status: 404 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to remove team member:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
