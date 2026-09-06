import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";

import getRetentionOffers from "@/lib/actions/retention-offers";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import { phLogger } from "@/lib/posthog/server";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preview which retention offers apply to the selected cancellation reason. */
export async function POST(request: NextRequest) {
  // Flush queued PostHog events and logs after the response is sent; the
  // evaluation event and flag telemetry are otherwise lost on freeze.
  after(() => phLogger.flush());
  try {
    const body = await request.json().catch(() => null);
    const reasonCategory = isRecord(body) ? body.reasonCategory : undefined;

    return NextResponse.json(await getRetentionOffers({ reasonCategory }));
  } catch (error) {
    return billingRouteErrorResponse(error);
  }
}
