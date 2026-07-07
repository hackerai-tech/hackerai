import { NextResponse } from "next/server";

import keepSubscription from "@/lib/actions/keep-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json(await keepSubscription());
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
