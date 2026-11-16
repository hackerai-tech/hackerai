"use client";

import { useState } from "react";
import useSWR from "swr";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useChatBillingRecoveryStatus } from "@/app/hooks/useBillingRecoveryStatus";
import { getEarlyRenewalNotice } from "@/lib/billing/early-renewal-notice";
import { BillingRecoveryPanel } from "./BillingRecoveryPanel";

/** Checks billing at most once per five minutes, on entry or focus only. */
const STATUS_MIN_INTERVAL_MS = 5 * 60_000;
const HIDDEN_KEY_PREFIX = "hackerai:early-renewal-notice:hidden:";

async function getEarlyRenewalNoticeEnabled() {
  try {
    const response = await fetch("/api/experiments/early-renewal-notice", {
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { enabled?: unknown };
    return body.enabled === true;
  } catch {
    return false;
  }
}

function isHidden(key: string) {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Compact, non-blocking notice above the composer for a personal subscriber
 * whose automatic renewal failed but who can still chat. It reuses the shared
 * recovery panel; it never disables send and never resends anything.
 */
export function EarlyRenewalPaymentNotice({
  actionDisabled,
  suppressed,
}: {
  /** Chat work is in flight: opening billing would navigate away from it. */
  actionDisabled: boolean;
  /** A blocking recovery surface already owns the same action. */
  suppressed: boolean;
}) {
  const { user, loading } = useAuth();
  const { subscription } = useGlobalState();
  const { data: enabled } = useSWR(
    user && !loading && subscription !== "team"
      ? ["early-renewal-notice-flag", user.id]
      : null,
    getEarlyRenewalNoticeEnabled,
    {
      dedupingInterval: STATUS_MIN_INTERVAL_MS,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );
  // No billing status request at all unless the server enabled the flag.
  const { data, mutate, scopeKey } = useChatBillingRecoveryStatus(
    enabled === true && subscription !== "team",
    { minIntervalMs: STATUS_MIN_INTERVAL_MS },
  );
  // Hidden in memory even when session storage is unavailable or throws.
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const notice =
    enabled === true && subscription !== "team"
      ? getEarlyRenewalNotice(data)
      : null;
  if (!notice || !data || !scopeKey || suppressed) return null;
  const hiddenKey = `${HIDDEN_KEY_PREFIX}${scopeKey}:${notice.invoiceId}`;
  if (hiddenKeys.has(hiddenKey) || isHidden(hiddenKey)) return null;

  return (
    <BillingRecoveryPanel
      // A new account, organization or invoice starts with no in-flight action.
      key={`${scopeKey}:${notice.invoiceId}`}
      variant="compact"
      status={data}
      subscription={subscription}
      surface="chat_notice"
      planName={notice.planName}
      actionDisabled={actionDisabled}
      scopeKey={scopeKey}
      onCheck={() => mutate()}
      onDismiss={() => {
        // Hidden for this tab session only; the next app entry shows it again.
        try {
          window.sessionStorage.setItem(hiddenKey, "1");
        } catch {}
        setHiddenKeys((keys) => new Set(keys).add(hiddenKey));
      }}
    />
  );
}
