"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  openRenewalInvoice,
  redirectToBillingPortal,
} from "@/lib/billing/client";
import type {
  BillingRecoverySurface,
  SubscriptionCancellationStatus,
} from "@/lib/billing/api-types";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { reloadWithEntitlementRefresh } from "@/lib/auth/entitlement-refresh-navigation";
import type { SubscriptionTier } from "@/types";

type Props = {
  status: SubscriptionCancellationStatus;
  subscription: SubscriptionTier;
  surface: BillingRecoverySurface;
  onCheck: () => Promise<SubscriptionCancellationStatus | undefined>;
};

export function BillingRecoveryPanel({
  status,
  subscription,
  surface,
  onCheck,
}: Props) {
  const [opening, setOpening] = useState<"invoice" | "card" | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const review = status.checkoutRequiresReview === true;
  const overdue =
    status.subscriptionStatus === "past_due" ||
    status.subscriptionStatus === "unpaid";
  const recovery = !review && status.renewalPaymentRequired === true;

  useEffect(() => {
    if (!overdue && !review) return;
    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.recoveryPromptImpressed,
      paidFunnelProperties({
        surface,
        subscription_tier: subscription,
        subscription_status: status.subscriptionStatus,
        recovery_state: review ? "canceled_review" : "renewal",
        ...(status.latestInvoiceId && {
          stripe_invoice_id: status.latestInvoiceId,
        }),
      }),
    );
  }, [
    overdue,
    review,
    status.latestInvoiceId,
    status.subscriptionStatus,
    subscription,
    surface,
  ]);

  if (!overdue && !review) return null;
  const authentication =
    status.renewalPaymentFailure === "authentication_required";
  const amount =
    recovery &&
    status.renewalInvoiceAmountRemaining !== undefined &&
    status.renewalInvoiceCurrency
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: status.renewalInvoiceCurrency.toUpperCase(),
        }).format(
          // Stripe uses minor units, with zero-decimal currencies represented as whole amounts.
          status.renewalInvoiceAmountRemaining /
            (new Intl.NumberFormat("en", {
              style: "currency",
              currency: status.renewalInvoiceCurrency,
            }).resolvedOptions().maximumFractionDigits === 0
              ? 1
              : 100),
        )
      : null;

  const open = async (action: "invoice" | "card") => {
    if (opening || checking) return;
    setOpening(action);
    setMessage("");
    try {
      if (action === "invoice" || review || recovery)
        captureAuthenticatedEvent(
          action === "card"
            ? PAID_FUNNEL_EVENTS.billingPastDuePaymentUpdateClicked
            : "billing_renewal_invoice_open_clicked",
          paidFunnelProperties({
            surface,
            subscription_tier: subscription,
            ...(status.latestInvoiceId && {
              stripe_invoice_id: status.latestInvoiceId,
            }),
          }),
        );
      const url =
        action === "invoice"
          ? await openRenewalInvoice()
          : await redirectToBillingPortal(
              review || recovery ? "payment_method" : undefined,
              {
                surface,
                returnPath: window.location.pathname,
              },
            );
      if (mounted.current) window.location.href = url;
    } catch (error) {
      if (!mounted.current) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not open billing. Please try again.",
      );
      setOpening(null);
    }
  };

  const check = async () => {
    if (checking || opening) return;
    setChecking(true);
    setMessage("");
    try {
      const next = await onCheck();
      if (!mounted.current) return;
      if (!next)
        throw new Error(
          "We couldn't verify your billing status. Please try again.",
        );
      if (
        next.renewalInvoicePaid &&
        (next.subscriptionStatus === "active" ||
          next.subscriptionStatus === "trialing")
      ) {
        toast.success(
          "Your renewal invoice is paid. Refresh to update your access.",
          {
            action: { label: "Refresh", onClick: reloadWithEntitlementRefresh },
          },
        );
      } else if (next.checkoutRequiresReview) {
        setMessage(
          "Your previous payment still needs review. Contact billing support.",
        );
      } else if (
        next.renewalPaymentRequired ||
        next.subscriptionStatus === "past_due" ||
        next.subscriptionStatus === "unpaid"
      ) {
        setMessage(
          "Payment is not confirmed yet. Review your invoice or update your card.",
        );
      } else {
        toast.success("Your billing status is up to date. You can try again.");
      }
    } catch {
      setMessage("We couldn't verify your billing status. Please try again.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <section
      aria-label="Subscription payment recovery"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm sm:p-5"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0 space-y-2">
          <h3 className="font-semibold text-foreground">
            {review
              ? "Your previous subscription has ended"
              : authentication
                ? "Confirm your renewal payment"
                : recovery
                  ? "Your renewal payment didn’t go through"
                  : "Your subscription needs billing attention"}
          </h3>
          <p className="text-muted-foreground">
            {review
              ? "An unresolved payment from your previous subscription needs review before you can subscribe again. Paying an old invoice won’t restart that subscription."
              : authentication
                ? "Your bank needs you to confirm this payment. Complete verification securely with Stripe."
                : recovery
                  ? status.renewalPaymentFailure === "insufficient_funds"
                    ? "Your bank declined the renewal for insufficient funds. Pay the invoice after adding funds, or update your card."
                    : "Pay your outstanding renewal or update your card to continue your subscription."
                  : "Review your payment status in billing before changing plans."}
          </p>
        </div>
      </div>
      {amount && (
        <div className="mt-4 flex flex-wrap justify-between gap-2 border-y border-amber-500/20 py-3">
          <span>Outstanding renewal</span>
          <span className="font-medium tabular-nums">{amount}</span>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {review ? (
          <Button asChild size="sm">
            <a href="mailto:contact@hackerai.co?subject=Subscription%20billing%20help">
              Get billing help
            </a>
          </Button>
        ) : (
          recovery &&
          status.renewalInvoicePayable && (
            <Button
              size="sm"
              disabled={!!opening || checking}
              onClick={() => void open("invoice")}
            >
              {opening === "invoice" ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                  />
                  Opening…
                </>
              ) : authentication ? (
                "Complete payment"
              ) : (
                "Pay invoice"
              )}
            </Button>
          )
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!!opening || checking}
          onClick={() => void open("card")}
        >
          {opening === "card" ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Opening…
            </>
          ) : review || recovery ? (
            "Update card"
          ) : (
            "Manage billing"
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!!opening || checking}
          onClick={() => void check()}
        >
          {checking ? "Checking…" : "Check payment status"}
        </Button>
      </div>
      {recovery && (
        <p className="mt-3 text-xs text-muted-foreground">
          Access returns after payment succeeds. Updating your card may trigger
          a retry of this renewal.
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-foreground">
          {message}
        </p>
      )}
    </section>
  );
}
