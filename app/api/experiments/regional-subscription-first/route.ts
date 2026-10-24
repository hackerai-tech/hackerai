import type { NextRequest } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import {
  evaluateRegionalSubscriptionFirst,
  subscriptionFirstCountryFromRequest,
} from "@/lib/experiments/regional-subscription-first.server";

export async function GET(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    const assignment = await evaluateRegionalSubscriptionFirst({
      userId,
      subscription,
      country: subscriptionFirstCountryFromRequest(req),
    });
    // Lookup is not exposure: the browser records exposure when it renders.
    return Response.json(
      { assignment: assignment ?? null },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    return Response.json(
      { assignment: null },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
