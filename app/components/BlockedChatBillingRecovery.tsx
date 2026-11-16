"use client";

import { type ReactNode } from "react";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useChatBillingRecoveryStatus } from "@/app/hooks/useBillingRecoveryStatus";
import { Button } from "@/components/ui/button";
import { BillingRequestError } from "@/lib/billing/client";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { BillingRecoveryPanel } from "./BillingRecoveryPanel";

/** Only mount on blocked chat: no Stripe requests on normal chat traffic. */
export function BlockedChatBillingRecovery({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  const { subscription } = useGlobalState();
  // All visible stops share a request, scoped to the current identity.
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
    authLoading,
    user,
    scopeKey,
  } = useChatBillingRecoveryStatus(true);

  if (authLoading || isLoading || (isValidating && !data && !error)) {
    return (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        Checking billing…
      </p>
    );
  }
  if (!user) return <>{children}</>;

  if (error || !data) {
    const forbidden =
      error instanceof BillingRequestError && error.status === 403;
    return (
      <div role="status" className="rounded-lg border p-3 text-sm space-y-2">
        <p>
          {forbidden
            ? "Ask your billing administrator to check payment and usage for this account."
            : "We couldn't check whether this is a payment issue or a usage limit."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openSettingsDialog("Account")}
          >
            Account settings
          </Button>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          )}
          {!forbidden && (
            <Button
              size="sm"
              variant="outline"
              disabled={isValidating}
              onClick={() => void mutate()}
            >
              Check again
            </Button>
          )}
        </div>
      </div>
    );
  }

  const needsBillingRecovery =
    data.checkoutRequiresReview ||
    data.subscriptionStatus === "past_due" ||
    data.subscriptionStatus === "unpaid";

  // Keep the panel mounted across its status check so a paid result can show
  // the explicit entitlement-refresh action before ordinary usage UI returns.
  return (
    <>
      <BillingRecoveryPanel
        // A new account or organization starts with no in-flight action. A
        // status refresh within one scope keeps the panel and its feedback.
        key={scopeKey ?? "signed-out"}
        status={data}
        subscription={subscription}
        surface="blocked_chat"
        scopeKey={scopeKey}
        onCheck={() => mutate()}
      />
      {!needsBillingRecovery && children}
    </>
  );
}
