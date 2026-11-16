"use client";

import { useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useChatBillingRecoveryStatus } from "@/app/hooks/useBillingRecoveryStatus";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "@/lib/auth/entitlements";
import { getEarlyRenewalNotice } from "@/lib/billing/early-renewal-notice";
import { BillingRecoveryPanel } from "./BillingRecoveryPanel";

/** Checks billing at most once per five minutes, on entry or focus only. */
const STATUS_MIN_INTERVAL_MS = 5 * 60_000;
const HIDDEN_KEY_PREFIX = "hackerai:early-renewal-notice:hidden:";

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
  const { subscription, chatModeAccessResolved } = useGlobalState();
  const { entitlements } = useAuth();
  // Team billing has its own administrators. The plan starts as "free" until
  // entitlements resolve, so wait for them before any billing lookup. Free is
  // not excluded: a past-due subscriber's entitlement can already be free.
  // The current token is checked too: global state copies a team entitlement
  // into `subscription` one render after it reports access as resolved.
  // The shared hook adds the signed-in user and organization scope.
  const personal =
    chatModeAccessResolved &&
    subscription !== "team" &&
    resolveSubscriptionTier(parseEntitlements(entitlements)) !== "team";
  const { data, mutate, scopeKey } = useChatBillingRecoveryStatus(personal, {
    minIntervalMs: STATUS_MIN_INTERVAL_MS,
  });
  // Hidden in memory even when session storage is unavailable or throws.
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const notice = personal ? getEarlyRenewalNotice(data) : null;
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
