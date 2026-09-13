import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type Stripe from "stripe";

import { stripe } from "@/app/api/stripe";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  PRO_MONTHLY_CONTROL_LOOKUP_KEY,
  type ProMonthlyPricingExperimentAssignment,
  type ProMonthlyPricingExperimentPresentation,
} from "@/lib/experiments/pro-monthly-pricing";
import { evaluateProMonthlyPricingExperiment } from "@/lib/experiments/pro-monthly-pricing.server";

export const dynamic = "force-dynamic";

function stripeProductId(
  product: Stripe.Price["product"] | undefined,
): string | undefined {
  return typeof product === "string" ? product : product?.id;
}

function isExpectedPrice(
  price: Stripe.Price | undefined,
  assignment: ProMonthlyPricingExperimentAssignment,
): price is Stripe.Price {
  return Boolean(
    price &&
    price.active &&
    price.lookup_key === assignment.priceLookupKey &&
    price.currency === assignment.currency &&
    price.unit_amount === assignment.displayedAmountDollars * 100 &&
    price.type === "recurring" &&
    price.recurring?.interval === assignment.billingInterval &&
    price.recurring.interval_count === 1,
  );
}

export async function GET(req: NextRequest) {
  const { userId, subscription } = await getUserIDAndPro(req);
  const assignment = await evaluateProMonthlyPricingExperiment({
    userId,
    subscription,
    requestedPlan: "pro-monthly-plan",
  });

  if (assignment) {
    try {
      const lookupKeys =
        assignment.variant === "test"
          ? [assignment.priceLookupKey, PRO_MONTHLY_CONTROL_LOOKUP_KEY]
          : [assignment.priceLookupKey];
      const prices = await stripe.prices.list({
        active: true,
        lookup_keys: lookupKeys,
      });
      const selectedPrice = prices.data.find(
        (price) => price.lookup_key === assignment.priceLookupKey,
      );
      const controlPrice = prices.data.find(
        (price) => price.lookup_key === PRO_MONTHLY_CONTROL_LOOKUP_KEY,
      );
      const selectedProductId = stripeProductId(selectedPrice?.product);
      const controlProductId = stripeProductId(controlPrice?.product);
      const hasMatchingProduct =
        assignment.variant !== "test" ||
        Boolean(
          selectedProductId &&
          controlProductId &&
          selectedProductId === controlProductId,
        );

      if (!isExpectedPrice(selectedPrice, assignment) || !hasMatchingProduct) {
        return NextResponse.json(
          { error: "Experimental subscription price is unavailable" },
          {
            status: 503,
            headers: { "Cache-Control": "private, no-store, max-age=0" },
          },
        );
      }

      const presentation: ProMonthlyPricingExperimentPresentation = {
        ...assignment,
        stripePriceId: selectedPrice.id,
      };
      return NextResponse.json(presentation, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    } catch {
      return NextResponse.json(
        { error: "Experimental subscription price is unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "private, no-store, max-age=0" },
        },
      );
    }
  }

  return NextResponse.json(
    {
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
