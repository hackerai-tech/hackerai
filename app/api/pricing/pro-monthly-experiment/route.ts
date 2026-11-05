import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { stripe } from "@/app/api/stripe";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  PRO_MONTHLY_PRICE_LOOKUP_KEY,
  isCurrentProMonthlyPrice,
  proMonthlyPricePresentation,
} from "@/lib/pricing/pro-monthly";

export const dynamic = "force-dynamic";

// Keep the established pricing endpoint for the existing UI callers.
export async function GET(req: NextRequest) {
  await getUserIDAndPro(req);

  try {
    const prices = await stripe.prices.list({
      active: true,
      lookup_keys: [PRO_MONTHLY_PRICE_LOOKUP_KEY],
    });
    const price = prices.data.find(
      (candidate) => candidate.lookup_key === PRO_MONTHLY_PRICE_LOOKUP_KEY,
    );

    if (!price || !isCurrentProMonthlyPrice(price)) {
      return NextResponse.json(
        { error: "Pro monthly price is unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        },
      );
    }

    return NextResponse.json(proMonthlyPricePresentation(price), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json(
      { error: "Pro monthly price is unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
}
