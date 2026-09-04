import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import acceptRetentionDiscount from "@/lib/actions/accept-retention-discount";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

type AcceptRetentionDiscountRouteInput = Parameters<
  typeof acceptRetentionDiscount
>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAcceptRetentionDiscountInput(
  body: unknown,
): AcceptRetentionDiscountRouteInput | Error {
  if (!isRecord(body) || !isRecord(body.cancellationReason)) {
    return new Error("Please select the main cancellation reason");
  }

  return {
    cancellationReason: {
      reasonCategory: body.cancellationReason.reasonCategory,
      reasonSubcategory: body.cancellationReason.reasonSubcategory,
      reasonDetails: body.cancellationReason.reasonDetails,
    },
  };
}

/** Accept the retention discount instead of cancelling. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const input = parseAcceptRetentionDiscountInput(body);

    if (input instanceof Error) {
      return billingRouteErrorResponse(input);
    }

    return NextResponse.json(await acceptRetentionDiscount(input));
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
