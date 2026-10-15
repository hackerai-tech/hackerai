import type { NextRequest } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import {
  freeAgentDailyCountryFromRequest,
  getFreeAgentDailyStatus,
} from "@/lib/experiments/free-agent-completed-daily.server";

export async function GET(req: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const { userId, subscription, freeQuotaSubject } =
      await getUserIDAndPro(req);
    const status = await getFreeAgentDailyStatus({
      userId,
      subscription,
      quotaSubject: freeQuotaSubject,
      country: freeAgentDailyCountryFromRequest(req),
    });
    // Assignment lookup does not record exposure.
    return Response.json({ status: status ?? null }, { headers });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    return Response.json({ status: null }, { status: 503, headers });
  }
}
