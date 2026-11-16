import useSWR from "swr";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  BillingRequestError,
  getSubscriptionCancellationStatus,
} from "@/lib/billing/client";

/** Only checks billing on an open billing surface, scoped to the current account. */
export function useBillingRecoveryStatus(enabled: boolean) {
  const { user, organizationId, loading } = useAuth();
  return useSWR(
    enabled && user && !loading
      ? ["billing-recovery", user.id, organizationId ?? null]
      : null,
    getSubscriptionCancellationStatus,
    {
      dedupingInterval: 30_000,
      focusThrottleInterval: 30_000,
      refreshInterval: 0,
      shouldRetryOnError: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
}

async function getChatRecoveryStatus() {
  try {
    return await getSubscriptionCancellationStatus();
  } catch (error) {
    // Free accounts commonly have no billing account. A failed lookup or a
    // forbidden organization must not be mistaken for exhausted paid usage.
    if (
      error instanceof BillingRequestError &&
      error.status === 404 &&
      error.message === "No billing account found for this organization"
    ) {
      return { hasActiveSubscription: false, cancelAtPeriodEnd: false };
    }
    throw error;
  }
}

/**
 * Chat billing status shared by blocked-chat recovery and the early renewal
 * notice. One key per user and organization: a scope change starts from no
 * data instead of showing the previous account's status. Never polls; each
 * caller bounds its own mount/focus checks.
 */
export function useChatBillingRecoveryStatus(
  enabled: boolean,
  { minIntervalMs = 30_000 }: { minIntervalMs?: number } = {},
) {
  const { user, organizationId, loading } = useAuth();
  const scope = enabled && user && !loading ? user.id : null;
  const swr = useSWR(
    scope ? ["chat-billing-recovery", scope, organizationId ?? null] : null,
    getChatRecoveryStatus,
    {
      dedupingInterval: minIntervalMs,
      focusThrottleInterval: minIntervalMs,
      refreshInterval: 0,
      shouldRetryOnError: false,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    },
  );
  return {
    ...swr,
    authLoading: loading,
    user,
    scopeKey: scope ? `${scope}:${organizationId ?? ""}` : null,
  };
}
