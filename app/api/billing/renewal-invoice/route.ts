import { NextResponse } from "next/server";
import openRenewalInvoice from "@/lib/actions/renewal-invoice";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import { rejectUnsafeRequest } from "@/lib/security/same-origin-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejection = rejectUnsafeRequest(request);
  if (rejection) return rejection;
  try {
    return NextResponse.json({ url: await openRenewalInvoice() });
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
