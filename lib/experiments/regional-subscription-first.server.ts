import type { NextRequest } from "next/server";
import type { PostHog } from "posthog-node";
import PostHogClient from "@/app/posthog";
import { ChatSDKError } from "@/lib/errors";
import {
  ANALYTICS_CONSENT_COOKIE_NAME,
  getAnalyticsConsentDecision,
} from "@/lib/privacy/analytics-consent";
import {
  REGIONAL_SUBSCRIPTION_FIRST_KEY,
  REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE,
  isSubscriptionFirstCountry,
  regionalSubscriptionProperties,
  type RegionalSubscriptionAssignment,
} from "./regional-subscription-first";

/** Only Vercel ingress and the trusted worker payload can supply eligibility. */
export function subscriptionFirstCountryFromRequest(req: NextRequest) {
  if (process.env.VERCEL !== "1") return;
  const country = req.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!isSubscriptionFirstCountry(country)) return;
  const { analyticsAllowed } = getAnalyticsConsentDecision({
    cookieValue: req.cookies.get(ANALYTICS_CONSENT_COOKIE_NAME)?.value,
    countryCode: country,
    failClosed: true,
  });
  return analyticsAllowed ? country : undefined;
}

export async function evaluateRegionalSubscriptionFirst({
  userId,
  subscription,
  country,
  posthog = PostHogClient(),
}: {
  userId: string;
  subscription: string;
  country?: string;
  posthog?: Pick<PostHog, "getFeatureFlag"> | null;
}): Promise<RegionalSubscriptionAssignment | undefined> {
  if (
    !userId ||
    subscription !== "free" ||
    !isSubscriptionFirstCountry(country)
  )
    return;
  try {
    const variant = await posthog?.getFeatureFlag(
      REGIONAL_SUBSCRIPTION_FIRST_KEY,
      userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          subscription: "free",
          regional_subscription_country: country,
        },
      },
    );
    if (variant === "control" || variant === "test")
      return { variant, country };
  } catch {
    // An unavailable experiment must not change an account's entitlement.
  }
}

export async function enforceRegionalSubscriptionFirst(args: {
  userId: string;
  subscription: string;
  country?: string;
  surface: "ask" | "agent" | "agent_worker";
}) {
  const assignment = await evaluateRegionalSubscriptionFirst(args);
  if (!assignment) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const posthog = PostHogClient();
    posthog?.capture({
      distinctId: args.userId,
      event: REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE,
      properties: {
        ...regionalSubscriptionProperties(assignment),
        exposure_surface: args.surface,
        subscription_tier: "free",
        $geoip_disable: true,
        $process_person_profile: false,
      },
    });
    // Blocked tasks have no later completion event to flush this exposure.
    await Promise.race([
      posthog?.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 750);
      }),
    ]);
  } catch {
    // Telemetry failure must neither grant access nor reject a control account.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (assignment.variant === "test") {
    throw new ChatSDKError(
      "forbidden:chat",
      "Choose a subscription to start an Ask or Agent task.",
      {
        subscription_required: true,
        pricing_source: "regional_subscription_first",
      },
    );
  }
  return assignment;
}
