import { normalizeCheckoutAttemptId } from "@/lib/analytics/paid-funnel";

export const CHECKOUT_NAVIGATION_GUARD_WINDOW_MS = 30_000;
const CHECKOUT_NAVIGATION_STORAGE_KEY =
  "hackerai:billing:checkout-navigation:v1";

type CheckoutNavigationRecord = {
  attemptId: string;
  plan: string;
  startedAt: number;
};

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parseCheckoutNavigationRecord(
  value: string | null,
): CheckoutNavigationRecord | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<CheckoutNavigationRecord>;
    if (
      !normalizeCheckoutAttemptId(parsed.attemptId) ||
      typeof parsed.plan !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(parsed.plan) ||
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return null;
    }
    return parsed as CheckoutNavigationRecord;
  } catch {
    return null;
  }
}

export function rememberCheckoutNavigation({
  attemptId,
  plan,
  startedAt = Date.now(),
}: CheckoutNavigationRecord): void {
  try {
    getSessionStorage()?.setItem(
      CHECKOUT_NAVIGATION_STORAGE_KEY,
      JSON.stringify({ attemptId, plan, startedAt }),
    );
  } catch {
    // Best-effort reload protection only. The in-memory request lock and
    // server-side checkout-session reuse remain authoritative.
  }
}

export function getRecentCheckoutNavigation({
  plan,
  now = Date.now(),
}: {
  plan: string;
  now?: number;
}): CheckoutNavigationRecord | null {
  const storage = getSessionStorage();
  if (!storage) return null;

  let record: CheckoutNavigationRecord | null = null;
  try {
    record = parseCheckoutNavigationRecord(
      storage.getItem(CHECKOUT_NAVIGATION_STORAGE_KEY),
    );
  } catch {
    return null;
  }

  if (
    !record ||
    record.plan !== plan ||
    record.startedAt > now ||
    now - record.startedAt > CHECKOUT_NAVIGATION_GUARD_WINDOW_MS
  ) {
    try {
      storage.removeItem(CHECKOUT_NAVIGATION_STORAGE_KEY);
    } catch {
      // Best-effort cleanup only.
    }
    return null;
  }

  return record;
}
