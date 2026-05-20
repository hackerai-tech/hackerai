import { ConvexHttpClient } from "convex/browser";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import {
  Activity,
  ArrowLeft,
  BadgeDollarSign,
  Download,
  Gauge,
  Info,
  RefreshCw,
  TrendingUp,
  Users,
} from "lucide-react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { isAdminUserId } from "@/lib/admin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

type SearchParams = Promise<{
  startDay?: string;
  endDay?: string;
}>;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { startDay: dayString(start), endDay: dayString(end) };
}

function cleanDay(value: string | undefined, fallback: string): string {
  return value && dayPattern.test(value) ? value : fallback;
}

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const preciseDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const integer = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

function Metric({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail?: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="rounded-lg gap-4 py-5">
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-5">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-5">
        <div className="text-2xl font-semibold tracking-normal">{value}</div>
        {detail ? (
          <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function csvUrl(startDay: string, endDay: string): string {
  const params = new URLSearchParams({ startDay, endDay, format: "csv" });
  return `/api/admin/economics?${params.toString()}`;
}

export default async function EconomicsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  if (!isAdminUserId(user.id)) {
    redirect("/auth-error?code=403");
  }

  const params = await searchParams;
  const fallback = defaultRange();
  const startDay = cleanDay(params.startDay, fallback.startDay);
  const endDay = cleanDay(params.endDay, fallback.endDay);

  const summary = await convex.query(api.economics.getEconomicsSummary, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    startDay,
    endDay,
  });

  const contributionPerActiveUser =
    summary.users.active > 0
      ? summary.margin.contributionDollars / summary.users.active
      : 0;
  const hasEconomicsData =
    summary.usage.requests > 0 ||
    summary.revenue.grossRevenueDollars !== 0 ||
    summary.revenue.netRevenueDollars !== 0 ||
    summary.usage.totalCostDollars !== 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-5 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="sm" className="-ml-3 mb-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
            <h1 className="text-2xl font-semibold tracking-normal">
              Unit Economics
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Internal cost and revenue summary for free limits, margins, and
              acquisition decisions.
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 lg:w-auto">
            <form
              className="grid w-full gap-3 sm:grid-cols-[1fr_1fr_auto] lg:w-auto"
              method="GET"
            >
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                Start
                <Input name="startDay" type="date" defaultValue={startDay} />
              </label>
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                End
                <Input name="endDay" type="date" defaultValue={endDay} />
              </label>
              <Button type="submit" className="self-end">
                <RefreshCw className="h-4 w-4" />
                Apply
              </Button>
            </form>
            <Button asChild variant="outline" className="w-full lg:self-end">
              <Link href={csvUrl(startDay, endDay)}>
                <Download className="h-4 w-4" />
                Export CSV
              </Link>
            </Button>
          </div>
        </header>

        {!hasEconomicsData ? (
          <section className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No usage or revenue rows were found for this range. Economics data
              starts after this instrumentation is deployed and the first LLM
              usage or Stripe revenue event is recorded.
            </span>
          </section>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            title="Net Revenue"
            value={dollars.format(summary.revenue.netRevenueDollars)}
            detail={`${dollars.format(summary.revenue.grossRevenueDollars)} gross`}
            icon={BadgeDollarSign}
          />
          <Metric
            title="Total Cost"
            value={dollars.format(summary.usage.totalCostDollars)}
            detail={`${integer.format(summary.usage.requests)} requests`}
            icon={Activity}
          />
          <Metric
            title="Contribution"
            value={dollars.format(summary.margin.contributionDollars)}
            detail={`${percent.format(summary.margin.grossMargin)} margin`}
            icon={TrendingUp}
          />
          <Metric
            title="30d Conversion"
            value={percent.format(summary.conversion.freeToPaid30d)}
            detail={`${integer.format(summary.users.signupCohort)} signup cohort`}
            icon={Gauge}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="text-base">Users</CardTitle>
            </CardHeader>
            <CardContent>
              <Row
                label="Active users"
                value={integer.format(summary.users.active)}
              />
              <Row
                label="Active free users"
                value={integer.format(summary.users.activeFree)}
              />
              <Row
                label="Active paid users"
                value={integer.format(summary.users.activePaid)}
              />
              <Row
                label="Signup cohort"
                value={integer.format(summary.users.signupCohort)}
              />
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="text-base">Cost</CardTitle>
            </CardHeader>
            <CardContent>
              <Row
                label="Free cost"
                value={dollars.format(summary.usage.freeCostDollars)}
              />
              <Row
                label="Paid cost"
                value={dollars.format(summary.usage.paidCostDollars)}
              />
              <Row
                label="Free cost/user"
                value={preciseDollars.format(
                  summary.usage.freeCostPerActiveFreeUser,
                )}
              />
              <Row
                label="Paid cost/user"
                value={preciseDollars.format(
                  summary.usage.paidCostPerActivePaidUser,
                )}
              />
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="text-base">Revenue</CardTitle>
            </CardHeader>
            <CardContent>
              <Row label="ARPU" value={dollars.format(summary.revenue.arpu)} />
              <Row
                label="ARPPU"
                value={dollars.format(summary.revenue.arppu)}
              />
              <Row
                label="Refunds"
                value={dollars.format(summary.revenue.refundDollars)}
              />
              <Row
                label="Contribution/user"
                value={dollars.format(contributionPerActiveUser)}
              />
            </CardContent>
          </Card>
        </section>

        <section className="flex items-center gap-2 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          <Users className="h-4 w-4 shrink-0" />
          <span>
            Data comes from Convex daily aggregates and Stripe webhooks. PostHog
            is not needed to view this dashboard.
          </span>
        </section>
      </div>
    </main>
  );
}
