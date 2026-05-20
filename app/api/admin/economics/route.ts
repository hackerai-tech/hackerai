import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserID } from "@/lib/auth/get-user-id";
import { isAdminUserId } from "@/lib/admin";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

async function assertAdmin(req: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isAdminUserId(userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

const dayString = (date: Date): string => date.toISOString().slice(0, 10);

function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { startDay: dayString(start), endDay: dayString(end) };
}

export async function GET(req: NextRequest) {
  const forbidden = await assertAdmin(req);
  if (forbidden) return forbidden;

  const fallback = defaultRange();
  const startDay =
    req.nextUrl.searchParams.get("startDay") ?? fallback.startDay;
  const endDay = req.nextUrl.searchParams.get("endDay") ?? fallback.endDay;

  const summary = await convex.query(api.economics.getEconomicsSummary, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    startDay,
    endDay,
  });

  return NextResponse.json(summary);
}
