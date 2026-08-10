import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import redirectToBillingPortal from "@/lib/actions/billing-portal";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      flow?: unknown;
    } | null;
    const flow = body?.flow;
    if (flow !== undefined && flow !== "payment_method") {
      return NextResponse.json(
        { error: "Invalid billing portal flow" },
        { status: 400 },
      );
    }

    const url = await redirectToBillingPortal(flow);
    return NextResponse.json({ url });
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
