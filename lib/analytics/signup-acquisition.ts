import type { User } from "@workos-inc/node";
import {
  FIRST_TOUCH_ATTRIBUTION_MAX_AGE_SECONDS,
  firstTouchPersonProperties,
  type FirstTouchAttribution,
} from "@/lib/analytics/acquisition";
import { phLogger } from "@/lib/posthog/server";
import { parseSignupAttributionState } from "@/lib/analytics/signup-acquisition-state";

const AUTH_FLOW_MAX_AGE_MS = 15 * 60 * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;

export type AcquisitionSourceBucket =
  | "organic_search"
  | "referral_link"
  | "community"
  | "github"
  | "ai_assistant"
  | "campaign"
  | "direct_or_dark"
  | "unknown";

const COMMUNITY_DOMAINS = new Set([
  "discord.com",
  "facebook.com",
  "linkedin.com",
  "reddit.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
]);

const AI_ASSISTANT_DOMAINS = new Set([
  "chatgpt.com",
  "claude.ai",
  "copilot.microsoft.com",
  "gemini.google.com",
  "grok.com",
  "openai.com",
  "perplexity.ai",
]);

function domainMatches(domain: string, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (domain === candidate || domain.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

export function acquisitionSourceBucket(
  attribution: FirstTouchAttribution,
): AcquisitionSourceBucket {
  const source = attribution.source.toLowerCase();
  const medium = attribution.medium.toLowerCase();
  const domain = attribution.referringDomain.toLowerCase();

  if (source === "user_referral" || attribution.entrySurface === "invite") {
    return "referral_link";
  }
  if (medium === "organic") return "organic_search";
  if (
    source === "github" ||
    source === "github.com" ||
    domain === "github.com" ||
    domain.endsWith(".github.com")
  ) {
    return "github";
  }
  if (
    domainMatches(source, AI_ASSISTANT_DOMAINS) ||
    domainMatches(domain, AI_ASSISTANT_DOMAINS)
  ) {
    return "ai_assistant";
  }
  if (
    domainMatches(source, COMMUNITY_DOMAINS) ||
    domainMatches(domain, COMMUNITY_DOMAINS)
  ) {
    return "community";
  }
  if (source === "$direct" && domain === "$direct") {
    return "direct_or_dark";
  }
  if (
    attribution.campaign ||
    ["campaign", "cpc", "email", "paid", "ppc", "social"].includes(medium)
  ) {
    return "campaign";
  }
  return "unknown";
}

function isNewUserFromSignupFlow({
  userCreatedAt,
  signupStartedAt,
  now,
}: {
  userCreatedAt: string;
  signupStartedAt: string;
  now: Date;
}): boolean {
  const createdAtMs = Date.parse(userCreatedAt);
  const startedAtMs = Date.parse(signupStartedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(startedAtMs)) {
    return false;
  }

  return (
    startedAtMs >= nowMs - AUTH_FLOW_MAX_AGE_MS - CLOCK_SKEW_MS &&
    startedAtMs <= nowMs + CLOCK_SKEW_MS &&
    createdAtMs >= startedAtMs - CLOCK_SKEW_MS &&
    createdAtMs <= nowMs + CLOCK_SKEW_MS
  );
}

export function captureSignupAcquisitionAttribution({
  user,
  state,
  now = new Date(),
}: {
  user: User;
  state?: string;
  now?: Date;
}): boolean {
  const parsed = parseSignupAttributionState(state);
  if (
    !parsed ||
    !isNewUserFromSignupFlow({
      userCreatedAt: user.createdAt,
      signupStartedAt: parsed.signupStartedAt,
      now,
    })
  ) {
    return false;
  }

  const capturedAtMs = Date.parse(parsed.firstTouch.capturedAt);
  if (
    capturedAtMs <
      now.getTime() - FIRST_TOUCH_ATTRIBUTION_MAX_AGE_SECONDS * 1_000 ||
    capturedAtMs > now.getTime() + CLOCK_SKEW_MS
  ) {
    return false;
  }

  const firstTouch = firstTouchPersonProperties(parsed.firstTouch);
  const sourceBucket = acquisitionSourceBucket(parsed.firstTouch);
  const sourceContext = {
    referral_link_present: sourceBucket === "referral_link",
    ...(sourceBucket === "organic_search"
      ? { search_engine: parsed.firstTouch.source }
      : {}),
  };
  phLogger.event("signup_acquisition_attributed_v1", {
    userId: user.id,
    acquisition_attribution_version: parsed.firstTouch.version,
    acquisition_source_bucket: sourceBucket,
    attribution_source: "workos_authkit_callback",
    signup_started_at: parsed.signupStartedAt,
    user_created_at: user.createdAt,
    ...sourceContext,
    ...firstTouch,
    $insert_id: `signup_acquisition_attributed_v1:${user.id}`,
    $set_once: {
      ...firstTouch,
      acquisition_source_bucket: sourceBucket,
      ...sourceContext,
    },
  });
  return true;
}
