import { NextRequest, NextResponse } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  getBudgetLimits,
  getMonthlyBucketKey,
} from "@/lib/rate-limit/token-bucket";
import { limitPaidBucket } from "@/lib/rate-limit/paid-bucket";
import {
  getPaidDailyFreeAllowanceStatus,
  paidDailyFreeAllowanceStatusToMetadata,
} from "@/lib/rate-limit/paid-daily-free-allowance";

/** Advisory only: continuation still runs normal admission and reserves usage. */
export async function GET(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    if (subscription === "free" || subscription === "team") {
      return NextResponse.json(
        { available: false },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const redis = createRedisClient();
    if (!redis) throw new Error("Usage status unavailable");
    const monthly = await limitPaidBucket(
      redis,
      getMonthlyBucketKey(userId, subscription),
      getBudgetLimits(subscription).monthly,
      0,
    );
    const status = await getPaidDailyFreeAllowanceStatus({
      userId,
      subscription,
      mode: "agent",
      selectedModel: "auto",
      capReason: monthly.remaining <= 0 ? "monthly_exhausted" : undefined,
    });
    return NextResponse.json(paidDailyFreeAllowanceStatusToMetadata(status), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    return NextResponse.json(
      { error: "Could not check daily allowance" },
      { status: 503 },
    );
  }
}
