import { NextRequest, NextResponse } from "next/server";
import { workos } from "../../workos";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { requireAdminOrg } from "../team-auth";
import { z } from "zod";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  autoReloadEnabled: z.boolean().optional(),
  autoReloadThresholdDollars: z.number().finite().optional(),
  autoReloadAmountDollars: z.number().finite().optional(),
  monthlyCapDollars: z.number().finite().nullable().optional(),
});

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
      getConvexClient().query(api.teamExtraUsage.getTeamExtraUsageAdminView, {
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
    console.error(
      "Failed to fetch team extra-usage state:",
      stringifyRedactedError(error),
    );
    return NextResponse.json(
      { error: "Unable to load team usage settings" },
      { status: 500 },
    );
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
      const parsed = settingsSchema.safeParse(await req.json());
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid usage settings" },
          { status: 400 },
        );
      }
      body = parsed.data;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    await getConvexClient().mutation(
      api.teamExtraUsage.updateTeamExtraUsageSettings,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        organizationId: guard.organizationId,
        enabled: body.enabled,
        autoReloadEnabled: body.autoReloadEnabled,
        autoReloadThresholdDollars: body.autoReloadThresholdDollars,
        autoReloadAmountDollars: body.autoReloadAmountDollars,
        monthlyCapDollars: body.monthlyCapDollars,
      },
    );

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error(
      "Failed to update team extra-usage settings:",
      stringifyRedactedError(error),
    );
    return NextResponse.json(
      { error: "Unable to update team usage settings" },
      { status: 500 },
    );
  }
};
