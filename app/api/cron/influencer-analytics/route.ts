import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { flushInfluencerAnalytics } from "@/lib/influencers/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const supplied = Buffer.from(authorization ?? "");
  if (
    !secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let result = { ok: true, delivered: 0 };
  for (let batch = 0; batch < 5; batch++) {
    const next = await flushInfluencerAnalytics();
    result = { ok: next.ok, delivered: result.delivered + next.delivered };
    if (!next.ok || next.delivered < 100) break;
  }
  return NextResponse.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
