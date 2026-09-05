/**
 * One-shot guard for the "resume after purchase" automatic retry.
 *
 * The extra-usage confirm route sends the user back to the chat with
 * `?extra-usage-resume=true` (or `?extra-usage-payment-retry=true`), and the
 * limit error state retries the stopped task once on mount. In production a
 * single open tab retried every ~5 minutes for 14 hours because the flag kept
 * reappearing on the URL after each failed retry (Next.js restores the
 * canonical URL on re-render), so every remount of the error state fired the
 * retry again. This module decides whether a flag on the current URL should
 * trigger a retry, remembering what it already consumed for this chat in
 * memory (this page load) and in session storage (reloads).
 */

export const EXTRA_USAGE_RESUME_PARAMS = [
  "extra-usage-resume",
  "extra-usage-payment-retry",
] as const;

export type ExtraUsageResumeSource = (typeof EXTRA_USAGE_RESUME_PARAMS)[number];

/** A second flag on the same chat within this window is not retried again. */
export const EXTRA_USAGE_RESUME_RETRY_GUARD_TTL_MS = 30 * 60 * 1000;

const STORAGE_KEY_PREFIX = "hackerai:extra-usage-resume-retry:";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type ExtraUsageResumeDecision =
  | { flagged: false }
  | {
      flagged: true;
      retry: true;
      source: ExtraUsageResumeSource;
      /** URL with the flags removed, safe to pass to history.replaceState. */
      nextUrl: string;
    }
  | {
      flagged: true;
      retry: false;
      source: ExtraUsageResumeSource;
      nextUrl: string;
      reason: "already_retried";
    };

const consumedThisPageLoad = new Set<string>();

export function resetExtraUsageResumeRetryGuardForTests() {
  consumedThisPageLoad.clear();
}

function readTimestamp(storage: StorageLike | null | undefined, key: string) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeTimestamp(
  storage: StorageLike | null | undefined,
  key: string,
  value: number,
) {
  if (!storage) return;
  try {
    storage.setItem(key, String(value));
  } catch {
    // Storage can be full or blocked; the in-memory guard still applies.
  }
}

export function decideExtraUsageResumeRetry({
  href,
  storage,
  now = Date.now(),
}: {
  href: string;
  storage?: StorageLike | null;
  now?: number;
}): ExtraUsageResumeDecision {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { flagged: false };
  }

  const source = EXTRA_USAGE_RESUME_PARAMS.find(
    (param) => url.searchParams.get(param) === "true",
  );
  if (!source) return { flagged: false };

  for (const param of EXTRA_USAGE_RESUME_PARAMS) {
    url.searchParams.delete(param);
  }
  const nextUrl = url.pathname + url.search + url.hash;
  const key = `${STORAGE_KEY_PREFIX}${url.pathname}`;

  const lastRetryAt = readTimestamp(storage, key);
  const alreadyRetried =
    consumedThisPageLoad.has(key) ||
    (lastRetryAt !== null &&
      now - lastRetryAt < EXTRA_USAGE_RESUME_RETRY_GUARD_TTL_MS);

  if (alreadyRetried) {
    return {
      flagged: true,
      retry: false,
      source,
      nextUrl,
      reason: "already_retried",
    };
  }

  consumedThisPageLoad.add(key);
  writeTimestamp(storage, key, now);
  return { flagged: true, retry: true, source, nextUrl };
}
