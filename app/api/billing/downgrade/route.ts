import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";

import downgradeSubscription from "@/lib/actions/downgrade-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import { phLogger } from "@/lib/posthog/server";

export const dynamic = "force-dynamic";

type DowngradeSubscriptionRouteInput = Parameters<
  typeof downgradeSubscription
>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDowngradeSubscriptionInput(
  body: unknown,
): DowngradeSubscriptionRouteInput | Error {
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

/** Accept the retention "switch to a cheaper plan" offer instead of cancelling. */
export async function POST(request: NextRequest) {
  after(() => phLogger.flush());
  try {
    const body = await request.json().catch(() => null);
    const input = parseDowngradeSubscriptionInput(body);

    if (input instanceof Error) {
      return billingRouteErrorResponse(input);
    }

    return NextResponse.json(await downgradeSubscription(input));
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
