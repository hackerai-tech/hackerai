import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { requireAdminOrg } from "../team-auth";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * GET /api/team/extra-usage
 * Returns the team-pool settings + each member's cap/spend, with WorkOS
 * member details merged in for display.
 */
export const GET = async (req: NextRequest) => {
  try {
    const guard = await requireAdminOrg(req);
    if (!guard.ok) return guard.response;

    const [adminView, memberships] = await Promise.all([
      convex.query(api.teamExtraUsage.getTeamExtraUsageAdminView, {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        organizationId: guard.organizationId,
      }),
      workos.userManagement
        .listOrganizationMemberships({
          organizationId: guard.organizationId,
          statuses: ["active"],
        })
        .then((p) => p.autoPagination()),
    ]);

    const usageByUserId = new Map(adminView.members.map((m) => [m.userId, m]));

    const members = await Promise.all(
      memberships.map(async (m) => {
        const user = await workos.userManagement.getUser(m.userId);
        const usage = usageByUserId.get(m.userId);
        return {
          userId: m.userId,
          email: user.email,
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          role: m.role?.slug || "member",
          monthlyLimitDollars: usage?.monthlyLimitDollars,
          monthlySpentDollars: usage?.monthlySpentDollars ?? 0,
          disabled: usage?.disabled ?? false,
        };
      }),
    );

    return NextResponse.json({
      pool: {
        enabled: adminView.enabled,
        balanceDollars: adminView.balanceDollars,
        autoReloadEnabled: adminView.autoReloadEnabled,
        autoReloadThresholdDollars: adminView.autoReloadThresholdDollars,
        autoReloadAmountDollars: adminView.autoReloadAmountDollars,
        monthlyCapDollars: adminView.monthlyCapDollars,
        monthlySpentDollars: adminView.monthlySpentDollars,
        autoReloadDisabledReason: adminView.autoReloadDisabledReason,
      },
      members,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to fetch team extra-usage state:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};

/**
 * POST /api/team/extra-usage
 * Update team-pool settings (enable, monthly cap, auto-reload config).
 * Body: { enabled?, monthlyCapDollars?: number | null, autoReloadEnabled?,
 *         autoReloadThresholdDollars?, autoReloadAmountDollars? }
 */
export const POST = async (req: NextRequest) => {
  try {
    const guard = await requireAdminOrg(req);
    if (!guard.ok) return guard.response;

    let body: {
      enabled?: boolean;
      autoReloadEnabled?: boolean;
      autoReloadThresholdDollars?: number;
      autoReloadAmountDollars?: number;
      monthlyCapDollars?: number | null;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    await convex.mutation(api.teamExtraUsage.updateTeamExtraUsageSettings, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      organizationId: guard.organizationId,
      enabled: body.enabled,
      autoReloadEnabled: body.autoReloadEnabled,
      autoReloadThresholdDollars: body.autoReloadThresholdDollars,
      autoReloadAmountDollars: body.autoReloadAmountDollars,
      monthlyCapDollars: body.monthlyCapDollars,
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to update team extra-usage settings:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
