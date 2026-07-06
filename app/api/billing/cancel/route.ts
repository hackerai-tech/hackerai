import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import cancelSubscription from "@/lib/actions/cancel-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import type { CancelSubscriptionInput } from "@/lib/billing/api-types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const input = (await request
      .json()
      .catch(() => ({}))) as Partial<CancelSubscriptionInput>;
    return NextResponse.json(
      await cancelSubscription({
        cancellationReason: {
          reasonCategory: input.cancellationReason?.reasonCategory,
          reasonDetails: input.cancellationReason?.reasonDetails,
        },
      } as CancelSubscriptionInput),
    );
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
