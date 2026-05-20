import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserID } from "@/lib/auth/get-user-id";
import { isAdminUserId } from "@/lib/admin";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

type EconomicsSummary = {
  range: { startDay: string; endDay: string };
  users: {
    active: number;
    activeFree: number;
    activePaid: number;
    signupCohort: number;
  };
  usage: {
    requests: number;
    freeCostDollars: number;
    paidCostDollars: number;
    totalCostDollars: number;
    freeCostPerActiveFreeUser: number;
    paidCostPerActivePaidUser: number;
  };
  revenue: {
    grossRevenueDollars: number;
    refundDollars: number;
    netRevenueDollars: number;
    arpu: number;
    arppu: number;
  };
  conversion: { freeToPaid30d: number };
  margin: {
    contributionDollars: number;
    grossMargin: number;
  };
};

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
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { startDay: dayString(start), endDay: dayString(end) };
}

function parseDay(value: string | null, fallback: string): string | null {
  const day = value ?? fallback;
  if (!dayPattern.test(day)) return null;

  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dayString(parsed) !== day) {
    return null;
  }

  return day;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function economicsSummaryCsv(summary: EconomicsSummary): string {
  const rows: Array<[string, string | number]> = [
    ["start_day", summary.range.startDay],
    ["end_day", summary.range.endDay],
    ["active_users", summary.users.active],
    ["active_free_users", summary.users.activeFree],
    ["active_paid_users", summary.users.activePaid],
    ["signup_cohort", summary.users.signupCohort],
    ["requests", summary.usage.requests],
    ["free_cost_dollars", summary.usage.freeCostDollars],
    ["paid_cost_dollars", summary.usage.paidCostDollars],
    ["total_cost_dollars", summary.usage.totalCostDollars],
    ["free_cost_per_active_free_user", summary.usage.freeCostPerActiveFreeUser],
    ["paid_cost_per_active_paid_user", summary.usage.paidCostPerActivePaidUser],
    ["gross_revenue_dollars", summary.revenue.grossRevenueDollars],
    ["refund_dollars", summary.revenue.refundDollars],
    ["net_revenue_dollars", summary.revenue.netRevenueDollars],
    ["arpu", summary.revenue.arpu],
    ["arppu", summary.revenue.arppu],
    ["free_to_paid_30d", summary.conversion.freeToPaid30d],
    ["contribution_dollars", summary.margin.contributionDollars],
    ["gross_margin", summary.margin.grossMargin],
  ];

  return [
    "metric,value",
    ...rows.map((row) => row.map(csvEscape).join(",")),
    "",
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const forbidden = await assertAdmin(req);
  if (forbidden) return forbidden;

  const fallback = defaultRange();
  const startDay = parseDay(
    req.nextUrl.searchParams.get("startDay"),
    fallback.startDay,
  );
  const endDay = parseDay(
    req.nextUrl.searchParams.get("endDay"),
    fallback.endDay,
  );

  if (!startDay || !endDay || startDay > endDay) {
    return NextResponse.json(
      { error: "Invalid date range. Use YYYY-MM-DD with startDay <= endDay." },
      { status: 400 },
    );
  }

  const summary: EconomicsSummary = await convex.query(
    api.economics.getEconomicsSummary,
    {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      startDay,
      endDay,
    },
  );

  if (req.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(economicsSummaryCsv(summary), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="hackerai-economics-${startDay}-to-${endDay}.csv"`,
      },
    });
  }

  return NextResponse.json(summary);
}
