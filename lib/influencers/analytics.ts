import { createHash } from "node:crypto";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";

/** Stable UUID + timestamp: concurrent flushes and ambiguous HTTP retries deduplicate in PostHog. */
export function influencerEventUuid(key: string) {
  const hex = createHash("sha256")
    .update(`influencer-analytics:v1:${key}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Bounded and best-effort for request paths. Failure leaves the durable queue for the cron. */
export async function flushInfluencerAnalytics(client?: ConvexHttpClient) {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || process.env.INFLUENCER_ANALYTICS_DISABLED === "true")
    return { ok: false, delivered: 0 };
  try {
    const convex = client ?? getConvexClient();
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
    const rows = await convex.query(api.influencerAnalytics.pending, {
      serviceKey,
    });
    if (!rows.length) return { ok: true, delivered: 0 };
    const allowedRows = rows.filter((row) => !row.suppressed);
    if (allowedRows.length) {
      const response = await fetch(
        new URL(
          "/batch/",
          process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            api_key: key,
            batch: allowedRows.map((row) => ({
              uuid: influencerEventUuid(row.key),
              event: row.event,
              timestamp: new Date(row.timestamp).toISOString(),
              properties: {
                ...row.properties,
                distinct_id: `influencer-visitor:${row.visitor_id}`,
                $insert_id: influencerEventUuid(row.key),
                $process_person_profile: false,
                $geoip_disable: true,
                influencer_code: row.code,
                referral_program: "influencer",
                analytics_version: 1,
                environment:
                  process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
              },
            })),
          }),
        },
      );
      if (!response.ok) throw new Error("Capture failed");
    }
    await convex.mutation(api.influencerAnalytics.acknowledge, {
      serviceKey,
      ids: rows.map((row) => row._id),
    });
    return { ok: true, delivered: rows.length };
  } catch {
    // Never log payloads, keys, contact details or upstream response bodies.
    console.warn("Influencer analytics delivery pending retry");
    return { ok: false, delivered: 0 };
  }
}
