import type { PostHog } from "posthog-node";
import type { NextRequest } from "next/server";
import PostHogClient from "@/app/posthog";
import { ChatSDKError } from "@/lib/errors";
import { getLimitPressureContext } from "@/lib/limit-pressure";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";
import { isSubscriptionFirstCountry } from "./regional-subscription-first";
import {
  FREE_AGENT_COMPLETED_DAILY_KEY,
  FREE_AGENT_COMPLETED_DAILY_EXPOSURE,
  freeAgentDailyExposureProperties,
  type FreeAgentDailyAssignment,
  type FreeAgentDailyStatus,
} from "./free-agent-completed-daily";

/** This value is derived at ingress, never from a browser request body. */
export function freeAgentDailyCountryFromRequest(req: NextRequest) {
  if (process.env.VERCEL !== "1") return;
  const country = req.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (
    !country ||
    !/^[A-Z]{2}$/.test(country) ||
    country === "XX" ||
    isSubscriptionFirstCountry(country)
  )
    return;
  return getAnalyticsConsentDecision({
    cookieValue: req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: country,
    failClosed: true,
  }).analyticsAllowed
    ? country
    : undefined;
}

function dailyBucket(subject: string, now = Date.now()) {
  const day = Math.floor(now / 86_400_000);
  return {
    key: `free_agent_completed_daily:v1:${subject}:${day}`,
    resetTimestamp: (day + 1) * 86_400_000,
  };
}

export async function getFreeAgentDailyStatus({
  userId,
  subscription,
  country,
  quotaSubject = userId,
  mode = "agent",
}: {
  userId: string;
  subscription: string;
  country?: string;
  quotaSubject?: string;
  mode?: string;
}): Promise<FreeAgentDailyStatus | undefined> {
  if (
    !userId ||
    subscription !== "free" ||
    mode !== "agent" ||
    !country ||
    !/^[A-Z]{2}$/.test(country) ||
    country === "XX" ||
    isSubscriptionFirstCountry(country)
  )
    return;
  const posthog = PostHogClient();
  if (!posthog) return;
  try {
    const variant = await getPostHogFlagWithoutExposure(
      posthog,
      FREE_AGENT_COMPLETED_DAILY_KEY,
      userId,
      {
        subscription: "free",
        free_agent_daily_eligible: "true",
      },
    );
    if (variant !== "control" && variant !== "test") return;
    const redis = createRedisClient();
    if (!redis) return;
    const bucket = dailyBucket(quotaSubject);
    const completed = await redis.get(bucket.key);
    return {
      assignment: { variant },
      completed: completed === 1 || completed === "1",
      resetTimestamp: bucket.resetTimestamp,
    };
  } catch {
    // This additional experiment must not turn an outage into a paywall.
    return;
  }
}

export async function enforceFreeAgentDailyStatus(
  status: FreeAgentDailyStatus | undefined,
  userId: string,
  surface: "agent" | "agent_worker",
  delivery?:
    | { defer: (flush: () => Promise<void>) => void }
    | { client: Pick<PostHog, "capture" | "flush"> | null },
) {
  if (!status) return;
  // Workers pass their existing client, which is shut down in finally.
  // Routes register the flush with Next's after(), including blocked responses.
  const posthog =
    delivery && "client" in delivery ? delivery.client : PostHogClient();
  const flush = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        posthog?.flush(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 750);
        }),
      ]);
    } catch {
      // Telemetry failure must not alter the quota decision.
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    posthog?.capture({
      distinctId: userId,
      event: FREE_AGENT_COMPLETED_DAILY_EXPOSURE,
      properties: freeAgentDailyExposureProperties(status.assignment, surface),
    });
    if (delivery && "defer" in delivery) delivery.defer(flush);
    else if (!delivery) await flush();
  } catch {
    // Telemetry failure must not alter the quota decision.
  }
  if (status.assignment.variant !== "test" || !status.completed) return;
  const capReason = "free_agent_daily_completed";
  throw new ChatSDKError(
    "rate_limit:chat",
    "You've used today's free Agent allowance. Wait until the daily reset or upgrade to continue. Ask remains available within your existing limits.",
    {
      subscription: "free",
      capReason,
      resetTimestamp: status.resetTimestamp,
      resetTime: new Date(status.resetTimestamp).toISOString(),
      ...getLimitPressureContext({ subscription: "free", capReason }),
    },
  );
}

/** Called only after the new assistant reply has been persisted, under the run lock. */
export async function recordFreeAgentDailyCompletion({
  assignment,
  quotaSubject,
  outcome,
  finishReason,
  hasResponseContent,
  truncated,
}: {
  assignment?: FreeAgentDailyAssignment;
  quotaSubject: string;
  outcome: string;
  finishReason?: string;
  hasResponseContent: boolean;
  truncated: boolean;
}) {
  if (
    !assignment ||
    outcome !== "success" ||
    finishReason !== "stop" ||
    !hasResponseContent ||
    truncated
  )
    return;
  try {
    const redis = createRedisClient();
    if (!redis) return;
    const { key, resetTimestamp } = dailyBucket(quotaSubject);
    // Idempotent across completion callbacks and retries; no in-flight reservation
    // survives a crash. The existing free-run lock serializes starts.
    await redis.set(key, "1", { exat: Math.ceil(resetTimestamp / 1000) });
  } catch {
    console.warn(
      JSON.stringify({ event: "free_agent_daily_completion_record_failed" }),
    );
  }
}
