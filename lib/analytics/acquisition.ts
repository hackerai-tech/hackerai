export const FIRST_TOUCH_ATTRIBUTION_COOKIE_NAME =
  "hackerai_first_touch_attribution";

export const FIRST_TOUCH_ATTRIBUTION_VERSION = 1;
export const FIRST_TOUCH_ATTRIBUTION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const SAFE_CAMPAIGN_LABEL = /^[A-Za-z0-9_$_.:-]{1,80}$/;
const OWNED_HOST_SUFFIXES = ["hackerai.co"] as const;
const GOOGLE_ANDROID_SEARCH_APP = "com.google.android.googlequicksearchbox";

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

export type FirstTouchAttribution = {
  version: typeof FIRST_TOUCH_ATTRIBUTION_VERSION;
  source: string;
  medium: string;
  campaign?: string;
  referringDomain: string;
  entrySurface:
    | "home"
    | "download"
    | "trust"
    | "signup"
    | "login"
    | "shared_chat"
    | "invite"
    | "other_public";
  capturedAt: string;
};

export type AcquisitionSourceBucket =
  | "organic_search"
  | "referral_link"
  | "community"
  | "github"
  | "ai_assistant"
  | "campaign"
  | "direct_or_dark"
  | "unknown";

function normalizeCampaignLabel(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return SAFE_CAMPAIGN_LABEL.test(normalized) ? normalized : undefined;
}

function normalizeHostname(value: string): string | null {
  const normalized = value.toLowerCase().replace(/^www\./, "");
  if (
    !/^[a-z0-9.-]{1,253}$/.test(normalized) ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  ) {
    return null;
  }
  return normalized;
}

function isOwnedHostname(hostname: string): boolean {
  return OWNED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function getExternalReferringDomain(referer: string | null): string | null {
  if (!referer) return null;

  try {
    const hostname = normalizeHostname(new URL(referer).hostname);
    if (!hostname || isOwnedHostname(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

function getEntrySurface(
  pathname: string,
): FirstTouchAttribution["entrySurface"] {
  if (pathname === "/" || pathname === "/index") return "home";
  if (pathname === "/download") return "download";
  if (pathname === "/trust") return "trust";
  if (pathname === "/signup") return "signup";
  if (pathname === "/login") return "login";
  if (pathname.startsWith("/share/")) return "shared_chat";
  if (pathname.startsWith("/invite/")) return "invite";
  return "other_public";
}

function classifyReferrer(referringDomain: string | null): {
  source: string;
  medium: string;
} {
  if (!referringDomain) return { source: "$direct", medium: "none" };

  if (
    referringDomain === "google.com" ||
    referringDomain.endsWith(".google.com") ||
    referringDomain === GOOGLE_ANDROID_SEARCH_APP
  ) {
    return { source: "google", medium: "organic" };
  }
  if (referringDomain === "bing.com") {
    return { source: "bing", medium: "organic" };
  }
  if (
    referringDomain === "duckduckgo.com" ||
    referringDomain === "search.brave.com"
  ) {
    return { source: referringDomain, medium: "organic" };
  }

  return { source: referringDomain, medium: "referral" };
}

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
  if (
    medium === "organic" ||
    (medium === "referral" &&
      (source === GOOGLE_ANDROID_SEARCH_APP ||
        domain === GOOGLE_ANDROID_SEARCH_APP))
  ) {
    return "organic_search";
  }
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

function searchEngine(attribution: FirstTouchAttribution): string | undefined {
  if (acquisitionSourceBucket(attribution) !== "organic_search") {
    return undefined;
  }

  const source = attribution.source.toLowerCase();
  const domain = attribution.referringDomain.toLowerCase();
  if (
    source === "google" ||
    source === GOOGLE_ANDROID_SEARCH_APP ||
    domain === "google.com" ||
    domain.endsWith(".google.com") ||
    domain === GOOGLE_ANDROID_SEARCH_APP
  ) {
    return "google";
  }
  if (source === "bing" || domain === "bing.com") return "bing";
  if (source === "duckduckgo.com" || domain === "duckduckgo.com") {
    return "duckduckgo";
  }
  if (source === "search.brave.com" || domain === "search.brave.com") {
    return "brave";
  }
  return source;
}

export function createFirstTouchAttribution({
  url,
  referer,
  capturedAt = new Date(),
}: {
  url: URL;
  referer: string | null;
  capturedAt?: Date;
}): FirstTouchAttribution {
  const utmSource = normalizeCampaignLabel(url.searchParams.get("utm_source"));
  const utmMedium = normalizeCampaignLabel(url.searchParams.get("utm_medium"));
  const campaign = normalizeCampaignLabel(url.searchParams.get("utm_campaign"));
  const referringDomain = getExternalReferringDomain(referer);

  let classified = classifyReferrer(referringDomain);
  if (utmSource) {
    classified = { source: utmSource, medium: utmMedium ?? "campaign" };
  } else if (
    url.searchParams.has("referral_code") ||
    url.searchParams.has("ref")
  ) {
    classified = { source: "user_referral", medium: "referral" };
  } else if (url.searchParams.has("gclid")) {
    classified = { source: "google", medium: "paid" };
  } else if (url.searchParams.has("msclkid")) {
    classified = { source: "bing", medium: "paid" };
  }

  return {
    version: FIRST_TOUCH_ATTRIBUTION_VERSION,
    ...classified,
    ...(campaign ? { campaign } : {}),
    referringDomain: referringDomain ?? "$direct",
    entrySurface: getEntrySurface(url.pathname),
    capturedAt: capturedAt.toISOString(),
  };
}

export function serializeFirstTouchAttribution(
  attribution: FirstTouchAttribution,
): string {
  return encodeURIComponent(JSON.stringify(attribution));
}

export function parseFirstTouchAttribution(
  value: string | undefined,
): FirstTouchAttribution | null {
  if (!value || value.length > 2_048) return null;

  try {
    const parsed = JSON.parse(
      decodeURIComponent(value),
    ) as Partial<FirstTouchAttribution>;
    if (
      parsed.version !== FIRST_TOUCH_ATTRIBUTION_VERSION ||
      !normalizeCampaignLabel(parsed.source ?? null) ||
      !normalizeCampaignLabel(parsed.medium ?? null) ||
      (parsed.campaign !== undefined &&
        !normalizeCampaignLabel(parsed.campaign)) ||
      !parsed.referringDomain ||
      (!normalizeHostname(parsed.referringDomain) &&
        parsed.referringDomain !== "$direct") ||
      ![
        "home",
        "download",
        "trust",
        "signup",
        "login",
        "shared_chat",
        "invite",
        "other_public",
      ].includes(parsed.entrySurface ?? "") ||
      typeof parsed.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.capturedAt))
    ) {
      return null;
    }

    return parsed as FirstTouchAttribution;
  } catch {
    return null;
  }
}

export function firstTouchPersonProperties(
  attribution: FirstTouchAttribution,
): Record<string, string | number | boolean> {
  const sourceBucket = acquisitionSourceBucket(attribution);
  const organicSearchEngine = searchEngine(attribution);

  return {
    acquisition_attribution_version: attribution.version,
    acquisition_source_bucket: sourceBucket,
    acquisition_attribution_source: "post_auth_identify",
    referral_link_present: sourceBucket === "referral_link",
    ...(organicSearchEngine ? { search_engine: organicSearchEngine } : {}),
    first_touch_attribution_version: attribution.version,
    first_touch_source: attribution.source,
    first_touch_medium: attribution.medium,
    ...(attribution.campaign
      ? { first_touch_campaign: attribution.campaign }
      : {}),
    first_touch_referring_domain: attribution.referringDomain,
    first_touch_entry_surface: attribution.entrySurface,
    first_touch_captured_at: attribution.capturedAt,
  };
}
