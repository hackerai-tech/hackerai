export type InitialAttribution = {
  initial_source: string;
  initial_medium: string;
  initial_campaign?: string;
  initial_content?: string;
  initial_term?: string;
  initial_referrer?: string;
  initial_referring_domain?: string;
  initial_landing_page: string;
  initial_landing_path: string;
  initial_landing_query?: string;
  initial_gclid?: string;
  initial_fbclid?: string;
  initial_msclkid?: string;
  initial_captured_at: string;
};

const ATTRIBUTION_STORAGE_KEY = "hackerai.initial_attribution.v1";
const ATTRIBUTION_COOKIE_NAME = "hackerai_initial_attribution";
const ATTRIBUTION_SYNC_PREFIX = "hackerai.attribution_synced.";

const TRACKING_QUERY_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "msclkid",
] as const;

const ATTRIBUTION_KEYS = [
  "initial_source",
  "initial_medium",
  "initial_campaign",
  "initial_content",
  "initial_term",
  "initial_referrer",
  "initial_referring_domain",
  "initial_landing_page",
  "initial_landing_path",
  "initial_landing_query",
  "initial_gclid",
  "initial_fbclid",
  "initial_msclkid",
  "initial_captured_at",
] as const;

const STRIPE_ATTRIBUTION_KEYS = [
  "initial_source",
  "initial_medium",
  "initial_campaign",
  "initial_referring_domain",
  "initial_landing_path",
  "initial_gclid",
  "initial_fbclid",
  "initial_msclkid",
] as const;

function clean(value: string | null | undefined, maxLength = 500) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function cleanLower(value: string | null | undefined, maxLength = 120) {
  return clean(value, maxLength)?.toLowerCase();
}

function normalizeDomain(hostname: string | null | undefined) {
  return cleanLower(hostname?.replace(/^www\./, ""), 180);
}

function externalReferrerFor(referrer: string | null | undefined, url: URL) {
  const rawReferrer = clean(referrer, 500);
  if (!rawReferrer) return null;

  try {
    const referrerUrl = new URL(rawReferrer);
    if (referrerUrl.origin === url.origin) return null;
    return {
      href: referrerUrl.href.slice(0, 500),
      domain: normalizeDomain(referrerUrl.hostname),
    };
  } catch {
    return null;
  }
}

function trackingQuery(searchParams: URLSearchParams) {
  const params = new URLSearchParams();
  for (const key of TRACKING_QUERY_KEYS) {
    const value = clean(searchParams.get(key), 180);
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query || undefined;
}

export function buildInitialAttribution({
  href,
  referrer,
  capturedAt = new Date().toISOString(),
}: {
  href: string;
  referrer?: string | null;
  capturedAt?: string;
}): InitialAttribution | null {
  try {
    const url = new URL(href);
    const externalReferrer = externalReferrerFor(referrer, url);
    const utmSource = cleanLower(url.searchParams.get("utm_source"));
    const utmMedium = cleanLower(url.searchParams.get("utm_medium"));
    const source = utmSource ?? externalReferrer?.domain ?? "direct";
    const medium = utmMedium ?? (externalReferrer ? "referral" : "direct");
    const landingQuery = trackingQuery(url.searchParams);

    return {
      initial_source: source,
      initial_medium: medium,
      ...(cleanLower(url.searchParams.get("utm_campaign"), 180) && {
        initial_campaign: cleanLower(url.searchParams.get("utm_campaign"), 180),
      }),
      ...(clean(url.searchParams.get("utm_content"), 180) && {
        initial_content: clean(url.searchParams.get("utm_content"), 180),
      }),
      ...(clean(url.searchParams.get("utm_term"), 180) && {
        initial_term: clean(url.searchParams.get("utm_term"), 180),
      }),
      ...(externalReferrer?.href && {
        initial_referrer: externalReferrer.href,
      }),
      ...(externalReferrer?.domain && {
        initial_referring_domain: externalReferrer.domain,
      }),
      initial_landing_page: `${url.origin}${url.pathname}`,
      initial_landing_path: url.pathname,
      ...(landingQuery && { initial_landing_query: landingQuery }),
      ...(clean(url.searchParams.get("gclid"), 180) && {
        initial_gclid: clean(url.searchParams.get("gclid"), 180),
      }),
      ...(clean(url.searchParams.get("fbclid"), 180) && {
        initial_fbclid: clean(url.searchParams.get("fbclid"), 180),
      }),
      ...(clean(url.searchParams.get("msclkid"), 180) && {
        initial_msclkid: clean(url.searchParams.get("msclkid"), 180),
      }),
      initial_captured_at: capturedAt,
    };
  } catch {
    return null;
  }
}

export function sanitizeAttribution(input: unknown): InitialAttribution | null {
  if (!input || typeof input !== "object") return null;

  const source = input as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const cleanedValue = clean(value);
    if (cleanedValue) sanitized[key] = cleanedValue;
  }

  if (
    !sanitized.initial_source ||
    !sanitized.initial_medium ||
    !sanitized.initial_landing_page ||
    !sanitized.initial_landing_path ||
    !sanitized.initial_captured_at
  ) {
    return null;
  }

  return sanitized as InitialAttribution;
}

export function attributionProperties(
  attribution: InitialAttribution | null | undefined,
) {
  if (!attribution) return {};
  return ATTRIBUTION_KEYS.reduce<Record<string, string>>((props, key) => {
    const value = attribution[key];
    if (value) props[key] = value;
    return props;
  }, {});
}

export function stripeAttributionMetadata(
  attribution: InitialAttribution | null | undefined,
) {
  if (!attribution) return {};
  return STRIPE_ATTRIBUTION_KEYS.reduce<Record<string, string>>(
    (metadata, key) => {
      const value = attribution[key];
      if (value) metadata[key] = value.slice(0, 500);
      return metadata;
    },
    {},
  );
}

export function attributionFromStripeMetadata(
  metadata: StripeAttributionMetadata | null | undefined,
) {
  if (!metadata) return {};
  return STRIPE_ATTRIBUTION_KEYS.reduce<Record<string, string>>(
    (props, key) => {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) {
        props[key] = value.trim().slice(0, 500);
      }
      return props;
    },
    {},
  );
}

type StripeAttributionMetadata = Partial<
  Record<(typeof STRIPE_ATTRIBUTION_KEYS)[number], string>
>;

export function encodeAttributionCookie(
  attribution: InitialAttribution | null | undefined,
) {
  if (!attribution) return null;
  return JSON.stringify(attribution);
}

export function decodeAttributionCookie(
  value: string | null | undefined,
): InitialAttribution | null {
  if (!value) return null;
  try {
    return sanitizeAttribution(JSON.parse(value));
  } catch {
    try {
      return sanitizeAttribution(JSON.parse(decodeURIComponent(value)));
    } catch {
      return null;
    }
  }
}

function readCookie(name: string) {
  if (typeof document === "undefined") return null;
  const encodedName = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(encodedName));
  return match ? match.slice(encodedName.length) : null;
}

function writeAttributionCookie(attribution: InitialAttribution) {
  if (typeof document === "undefined") return;
  const encoded = encodeAttributionCookie(attribution);
  if (!encoded) return;
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "; secure"
      : "";
  document.cookie = `${ATTRIBUTION_COOKIE_NAME}=${encodeURIComponent(encoded)}; max-age=${60 * 60 * 24 * 90}; path=/; samesite=lax${secure}`;
}

export function getInitialAttribution(): InitialAttribution | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    const attribution = sanitizeAttribution(stored ? JSON.parse(stored) : null);
    if (attribution) return attribution;
  } catch {
    // Ignore unavailable storage.
  }

  const cookieAttribution = decodeAttributionCookie(
    readCookie(ATTRIBUTION_COOKIE_NAME),
  );
  if (cookieAttribution) return cookieAttribution;

  return null;
}

export function captureInitialAttribution(): InitialAttribution | null {
  if (typeof window === "undefined") return null;

  const existing = getInitialAttribution();
  if (existing) {
    writeAttributionCookie(existing);
    return existing;
  }

  const attribution = buildInitialAttribution({
    href: window.location.href,
    referrer: document.referrer,
  });
  if (!attribution) return null;

  try {
    window.localStorage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify(attribution),
    );
  } catch {
    // Ignore unavailable storage.
  }
  writeAttributionCookie(attribution);
  return attribution;
}

export function hasSyncedAttributionForUser(userId: string) {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(`${ATTRIBUTION_SYNC_PREFIX}${userId}`) ===
      "true"
    );
  } catch {
    return false;
  }
}

export function markAttributionSyncedForUser(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${ATTRIBUTION_SYNC_PREFIX}${userId}`, "true");
  } catch {
    // Ignore unavailable storage.
  }
}

export { ATTRIBUTION_COOKIE_NAME };
