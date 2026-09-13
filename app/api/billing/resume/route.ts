import { NextResponse, after } from "next/server";

import resumeSubscription from "@/lib/actions/resume-subscription";
import { billingRouteErrorResponse } from "@/lib/billing/api-response";
import { phLogger } from "@/lib/posthog/server";

export const dynamic = "force-dynamic";

/** Resume a paused plan immediately instead of waiting for the resume date. */
export async function POST() {
  try {
    const result = await resumeSubscription();
    after(() => phLogger.flush());
    return NextResponse.json(result);
  } catch (error) {
    after(() => phLogger.flush());
    return billingRouteErrorResponse(error);
  }
}
