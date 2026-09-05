import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";

import pauseSubscription from "@/lib/actions/pause-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import { phLogger } from "@/lib/posthog/server";

export const dynamic = "force-dynamic";

type PauseSubscriptionRouteInput = Parameters<typeof pauseSubscription>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePauseSubscriptionInput(
  body: unknown,
): PauseSubscriptionRouteInput | Error {
  if (!isRecord(body)) {
    return new Error(BILLING_ERRORS.invalidPauseDuration);
  }
  if (!isRecord(body.cancellationReason)) {
    return new Error("Please select the main cancellation reason");
  }

  return {
    months: body.months,
    cancellationReason: {
      reasonCategory: body.cancellationReason.reasonCategory,
      reasonSubcategory: body.cancellationReason.reasonSubcategory,
      reasonDetails: body.cancellationReason.reasonDetails,
    },
  };
}

/** Accept the retention "pause" offer instead of cancelling outright. */
export async function POST(request: NextRequest) {
  after(() => phLogger.flush());
  try {
    const body = await request.json().catch(() => null);
    const input = parsePauseSubscriptionInput(body);

    if (input instanceof Error) {
      return billingRouteErrorResponse(input);
    }

    return NextResponse.json(await pauseSubscription(input));
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
