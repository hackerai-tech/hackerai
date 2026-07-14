import { NextResponse } from "next/server";

import redirectToBillingPortal from "@/lib/actions/billing-portal";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const url = await redirectToBillingPortal();
    return NextResponse.json({ url });
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
