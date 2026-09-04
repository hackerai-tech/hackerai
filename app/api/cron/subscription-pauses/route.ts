import { randomUUID } from "node:crypto";
import { NextResponse, after } from "next/server";

import { api } from "@/convex/_generated/api";
import { resumePausedSubscription } from "@/lib/billing/pause-resume";
import { isAuthorizedCronRequest } from "@/lib/billing/platform-cost-sync";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_RESUMES_PER_RUN = 50;

/**
 * Hourly: re-create subscriptions whose retention pause has ended. Each pause
 * is claimed atomically in Convex, so overlapping runs cannot double-bill.
 */
export async function GET(request: Request) {
  const requestId = request.headers.get("x-vercel-id") ?? randomUUID();
  if (!isAuthorizedCronRequest(request)) {
    phLogger.warn("subscription_pause_cron_unauthorized", {
      request_id: requestId,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    phLogger.error("subscription_pause_cron_misconfigured", {
      request_id: requestId,
      error: new Error("CONVEX_SERVICE_ROLE_KEY is not set"),
    });
    return NextResponse.json(
      { error: "CONVEX_SERVICE_ROLE_KEY is not set" },
      { status: 500 },
    );
  }

  const startedAt = Date.now();
  const counts = {
    due: 0,
    resumed: 0,
    superseded: 0,
    failed: 0,
    retryScheduled: 0,
    skipped: 0,
  };

  try {
    const due = await getConvexClient().query(
      api.subscriptionPauses.listDueResumes,
      { serviceKey, now: startedAt, limit: MAX_RESUMES_PER_RUN },
    );
    counts.due = due.length;

    for (const pause of due) {
      const result = await resumePausedSubscription(pause, {
        trigger: "cron",
        now: Date.now(),
      });
      switch (result.outcome) {
        case "resumed":
          counts.resumed += 1;
          break;
        case "superseded":
          counts.superseded += 1;
          break;
        case "failed":
          counts.failed += 1;
          if (result.retryScheduled) counts.retryScheduled += 1;
          break;
        case "not_claimable":
          counts.skipped += 1;
          break;
      }
    }

    phLogger.info("subscription_pause_cron_completed", {
      event: "subscription_pause_cron_completed",
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      ...counts,
    });
    after(() => phLogger.flush());
    return NextResponse.json({ ok: true, ...counts });
  } catch (error) {
    phLogger.error("subscription_pause_cron_failed", {
      event: "subscription_pause_cron_failed",
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      ...counts,
      error,
    });
    after(() => phLogger.flush());
    return NextResponse.json(
      { ok: false, error: "Subscription pause resume run failed", ...counts },
      { status: 500 },
    );
  }
}
