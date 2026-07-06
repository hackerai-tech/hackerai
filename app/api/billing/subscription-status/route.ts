import { NextResponse } from "next/server";

import getSubscriptionCancellationStatus from "@/lib/actions/subscription-status";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getSubscriptionCancellationStatus());
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
