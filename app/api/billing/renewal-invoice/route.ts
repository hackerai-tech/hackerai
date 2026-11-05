import { NextResponse } from "next/server";
import openRenewalInvoice from "@/lib/actions/renewal-invoice";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json({ url: await openRenewalInvoice() });
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
