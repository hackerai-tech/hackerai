import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { workos } from "../../../../workos";
import { requireAdminOrg } from "../../../team-auth";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * PATCH /api/team/extra-usage/members/:userId
 * Body: { monthlyLimitDollars?: number | null, disabled?: boolean }
 * Admin-only. Updates per-member spending limit and/or disabled flag.
 */
export const PATCH = async (
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) => {
  try {
    const guard = await requireAdminOrg(req);
    if (!guard.ok) return guard.response;

    const { userId: targetUserId } = await params;
    if (!targetUserId) {
      return NextResponse.json(
        { error: "Target userId is required" },
        { status: 400 },
      );
    }

    // Confirm the target user is actually a member of the admin's org —
    // prevents an admin from one org touching another org's row via path manipulation.
    const targetMemberships =
      await workos.userManagement.listOrganizationMemberships({
        userId: targetUserId,
        organizationId: guard.organizationId,
        statuses: ["active"],
      });

    if (!targetMemberships.data || targetMemberships.data.length === 0) {
      return NextResponse.json(
        { error: "User is not a member of your organization" },
        { status: 404 },
      );
    }

    const body = await req.json();

    await convex.mutation(api.teamExtraUsage.updateTeamMemberUsage, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      organizationId: guard.organizationId,
      userId: targetUserId,
      monthlyLimitDollars: body.monthlyLimitDollars,
      disabled: body.disabled,
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to update team member usage settings:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
