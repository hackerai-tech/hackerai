import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { stripe } from "../../stripe";
import { requireAdminOrg } from "../team-auth";
import {
  acquireTeamSeatOperationLock,
  TeamSeatOperationLockUnavailableError,
  type TeamSeatOperationLock,
} from "@/lib/billing/team-seat-operation-lock";

export const POST = async (req: NextRequest) => {
  let seatOperationLock: TeamSeatOperationLock | null = null;
  try {
    const guard = await requireAdminOrg(req);
    if (!guard.ok) return guard.response;
    const { userId, organizationId } = guard;

    const body = await req.json();
    const { email } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    seatOperationLock = await acquireTeamSeatOperationLock(organizationId);
    if (!seatOperationLock) {
      return NextResponse.json(
        {
          error: "Another team seat operation is being processed",
          message: "Please retry after the current operation finishes.",
        },
        { status: 409 },
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

        // Count current members and pending invitations
        const [currentMembershipPage, pendingInvitationPage] =
          await Promise.all([
            workos.userManagement.listOrganizationMemberships({
              organizationId,
              statuses: ["active"],
            }),
            workos.userManagement.listInvitations({
              organizationId,
            }),
          ]);
        const [currentMembers, pendingInvitations] = await Promise.all([
          currentMembershipPage.autoPagination(),
          pendingInvitationPage.autoPagination(),
        ]);

        const pendingInvitationsCount = pendingInvitations.filter(
          (invitation) => invitation.state === "pending",
        ).length;

        const totalSeatsInUse = currentMembers.length + pendingInvitationsCount;

        if (totalSeatsInUse >= quantity) {
          return NextResponse.json(
            {
              error: "Seat limit reached",
              details: `You have ${currentMembers.length} members and ${pendingInvitationsCount} pending invitations (${totalSeatsInUse} total) with ${quantity} seats. Please upgrade to add more members.`,
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
    await seatOperationLock.assertOwned();
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
    if (error instanceof TeamSeatOperationLockUnavailableError) {
      return NextResponse.json(
        { error: "Team seat service temporarily unavailable" },
        { status: 503 },
      );
    }
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to invite team member:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  } finally {
    if (seatOperationLock) {
      try {
        await seatOperationLock.release();
      } catch (error) {
        console.error("Failed to release team seat operation lock:", error);
      }
    }
  }
};

export const DELETE = async (req: NextRequest) => {
  try {
    const guard = await requireAdminOrg(req);
    if (!guard.ok) return guard.response;
    const { organizationId } = guard;

    const { searchParams } = new URL(req.url);
    const invitationId = searchParams.get("id");

    if (!invitationId) {
      return NextResponse.json(
        { error: "Invitation ID is required" },
        { status: 400 },
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
