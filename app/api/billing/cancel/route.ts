import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import cancelSubscription from "@/lib/actions/cancel-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

type CancelSubscriptionRouteInput = Parameters<typeof cancelSubscription>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_BODY_KEYS = ["cancellationReason"] as const;
const ALLOWED_CANCELLATION_REASON_KEYS = [
  "reasonCategory",
  "reasonSubcategory",
  "reasonDetails",
] as const;

function hasOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function parseCancelSubscriptionInput(
  body: unknown,
): CancelSubscriptionRouteInput | Error {
  if (
    !isRecord(body) ||
    !hasOnlyAllowedKeys(body, ALLOWED_BODY_KEYS) ||
    !isRecord(body.cancellationReason) ||
    !hasOnlyAllowedKeys(
      body.cancellationReason,
      ALLOWED_CANCELLATION_REASON_KEYS,
    )
  ) {
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const input = parseCancelSubscriptionInput(body);

    if (input instanceof Error) {
      return billingRouteErrorResponse(input);
    }

    return NextResponse.json(await cancelSubscription(input));
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
