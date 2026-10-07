import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { refreshTriggerHealth } from "@/lib/health/trigger-health";

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
  const result = await refreshTriggerHealth();
  return NextResponse.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
