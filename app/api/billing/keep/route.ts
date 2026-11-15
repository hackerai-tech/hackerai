import { NextResponse } from "next/server";

import keepSubscription from "@/lib/actions/keep-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import { rejectUnsafeRequest } from "@/lib/security/same-origin-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejection = rejectUnsafeRequest(request);
  if (rejection) return rejection;
  try {
    return NextResponse.json(await keepSubscription());
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
