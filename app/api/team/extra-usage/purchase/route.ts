import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { requireAdminOrg } from "../../team-auth";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * POST /api/team/extra-usage/purchase
 * Body: { amountDollars: number }
 * Admin-only. Creates a Stripe Checkout session billed to the org's
 * existing Stripe customer (the same one used for the team subscription).
 */
export const POST = async (req: NextRequest) => {
  try {
    const guard = await requireAdminOrg(req);
    if (!guard.ok) return guard.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const amountDollars = (body as { amountDollars?: unknown })?.amountDollars;

    if (
      typeof amountDollars !== "number" ||
      !Number.isFinite(amountDollars) ||
      amountDollars <= 0
    ) {
      return NextResponse.json(
        { error: "amountDollars must be a positive number" },
        { status: 400 },
      );
    }

    const baseUrl = req.nextUrl.origin;

    const result = await convex.action(
      api.teamExtraUsageActions.createTeamPurchaseSession,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        organizationId: guard.organizationId,
        amountDollars,
        baseUrl,
      },
    );

    if (result.error || !result.url) {
      return NextResponse.json(
        { error: result.error ?? "Failed to create checkout session" },
        { status: 400 },
      );
    }

    return NextResponse.json({ url: result.url });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to create team purchase session:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
