import { NextRequest, NextResponse } from "next/server";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { evaluateProMonthlyPricingExperiment } from "@/lib/experiments/pro-monthly-pricing.server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId, subscription } = await getUserIDAndPro(req);
  const assignment = await evaluateProMonthlyPricingExperiment({
    userId,
    subscription,
    requestedPlan: "pro-monthly-plan",
  });

  return NextResponse.json(
    assignment ?? {
      key: null,
      variant: null,
      priceLookupKey: "pro-monthly-plan",
      displayedAmountDollars: 25,
      currency: "usd",
      billingInterval: "month",
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
      },
    },
  );
}
