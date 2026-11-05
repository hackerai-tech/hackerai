import useSWR from "swr";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { getSubscriptionCancellationStatus } from "@/lib/billing/client";

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
