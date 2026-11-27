"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import {
  openRenewalInvoice,
  redirectToBillingPortal,
} from "@/lib/billing/client";
import type {
  BillingRecoverySurface,
  SubscriptionCancellationStatus,
} from "@/lib/billing/api-types";
import {
  captureQueuedAuthenticatedEvent,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import { beginServerActionDiagnostic } from "@/lib/analytics/server-action-diagnostics";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { reloadWithEntitlementRefresh } from "@/lib/auth/entitlement-refresh-navigation";
import recoverCanceledRenewal from "@/lib/actions/recover-canceled-renewal";
import type { SubscriptionTier } from "@/types";

/**
 * Handoff stages are traced separately: a ready URL proves neither that the
 * browser navigated nor that payment succeeded. Payment is confirmed only by
 * the authoritative status check after return.
 */
export const BILLING_RECOVERY_HANDOFF_EVENT = "billing_recovery_handoff";

type Props = {
  status: SubscriptionCancellationStatus;
  subscription: SubscriptionTier;
  surface: BillingRecoverySurface;
  onCheck: () => Promise<SubscriptionCancellationStatus | undefined>;
  /** One-line notice above the composer. Renders only renewal recovery. */
  variant?: "full" | "compact";
  /** Plan named in the compact notice, from the live subscription price. */
  planName?: string;
  /** Tier behind `planName`, recorded on the impression; not the session tier. */
  planTier?: string;
  /** Blocks navigation away while chat work is in flight; never blocks send. */
  actionDisabled?: boolean;
  onDismiss?: () => void;
  /**
   * Current account and organization. A result that arrives after the scope
   * changed never navigates, reports, or shows feedback to the new owner.
   */
  scopeKey?: string | null;
};

/**
 * Panels can render before the analytics SDK is ready, so events queue for the
 * consented owner and flush once identified. Without consent nothing is sent.
 */
function captureRecoveryEvent(
  event: string,
  properties: Record<string, unknown>,
  dedupeKey: string,
) {
  captureQueuedAuthenticatedEvent({
    event,
    properties: paidFunnelProperties(properties),
    dedupeKey,
  });
}

const noAnalyticsOwner = () => null;

/** Only the HTTP status of a billing request failure; never its message. */
function handoffFailureStatus(error: unknown) {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

export function BillingRecoveryPanel({
  status,
  subscription,
  surface,
  onCheck,
  variant = "full",
  planName,
  planTier,
  actionDisabled = false,
  onDismiss,
  scopeKey,
}: Props) {
  const [opening, setOpening] = useState<"invoice" | "card" | null>(null);
  // The handoff that failed, so "Try again" repeats that action.
  const [failedAction, setFailedAction] = useState<"invoice" | "card" | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const currentScope = useRef(scopeKey);
  // Read at resolution time: chat work can start while a URL is loading.
  const navigationBlocked = useRef(actionDisabled);
  const emittedImpressions = useRef(new Set<string>());
  // Pending handlers must only see committed props, and a keyed replacement
  // must invalidate this instance at commit, before pending promises resume.
  useLayoutEffect(() => {
    currentScope.current = scopeKey;
    navigationBlocked.current = actionDisabled;
  }, [scopeKey, actionDisabled]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Consent and sign-in can resolve after the panel is already visible.
  const analyticsOwner = useSyncExternalStore(
    subscribeAuthenticatedAnalytics,
    getPermittedAnalyticsUserId,
    noAnalyticsOwner,
  );
  const review = status.checkoutRequiresReview === true;
  const overdue =
    status.subscriptionStatus === "past_due" ||
    status.subscriptionStatus === "unpaid";
  const recovery = !review && status.renewalPaymentRequired === true;
  const compact = variant === "compact";
  const visible = compact ? recovery && overdue : overdue || review;

  useEffect(() => {
    if (
      !visible ||
      !analyticsOwner ||
      (scopeKey && !scopeKey.startsWith(`${analyticsOwner}:`))
    )
      return;
    const recoveryState = review ? "canceled_review" : "renewal";
    // One exposure per visible account, organization, invoice and surface.
    const encounter = JSON.stringify([
      analyticsOwner,
      scopeKey ?? null,
      surface,
      recoveryState,
      status.latestInvoiceId ?? null,
    ]);
    if (emittedImpressions.current.has(encounter)) return;
    emittedImpressions.current.add(encounter);
    captureRecoveryEvent(
      PAID_FUNNEL_EVENTS.recoveryPromptImpressed,
      {
        surface,
        subscription_tier: subscription,
        subscription_status: status.subscriptionStatus,
        recovery_state: recoveryState,
        // Safe category only; Stripe codes and messages never leave the server.
        ...(recoveryState === "renewal" &&
          status.renewalPaymentRequired && {
            recovery_reason: status.renewalPaymentFailure ?? "unknown",
          }),
        ...(planTier && { notice_plan_tier: planTier }),
        ...(status.latestInvoiceId && {
          stripe_invoice_id: status.latestInvoiceId,
        }),
      },
      encounter,
    );
  }, [
    analyticsOwner,
    scopeKey,
    visible,
    review,
    planTier,
    status.latestInvoiceId,
    status.renewalPaymentFailure,
    status.renewalPaymentRequired,
    status.subscriptionStatus,
    subscription,
    surface,
  ]);
  /** False once unmounted or the account/organization changed since start. */
  const isCurrent = (startedScope: string | null | undefined) =>
    mounted.current && currentScope.current === startedScope;

  if (!visible) return null;
  const authentication =
    status.renewalPaymentFailure === "authentication_required";
  const insufficientFunds =
    recovery && status.renewalPaymentFailure === "insufficient_funds";
  // Only a retry still ahead is worth waiting for; cached status can be stale.
  const retryDate =
    insufficientFunds &&
    status.renewalNextPaymentAttempt !== undefined &&
    status.renewalNextPaymentAttempt > Date.now()
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(status.renewalNextPaymentAttempt)
      : null;
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
    if (opening || checking || recovering || actionDisabled) return;
    setOpening(action);
    setFailedAction(null);
    setMessage("");
    const startedScope = currentScope.current;
    const attemptId = uuidv4();
    const traced = action === "invoice" || review || recovery;
    const handoffProperties = {
      surface,
      subscription_tier: subscription,
      handoff_action: action,
      handoff_attempt_id: attemptId,
      ...(status.latestInvoiceId && {
        stripe_invoice_id: status.latestInvoiceId,
      }),
    };
    // Unmounted or switched to another account/organization while waiting:
    // never navigate, capture, or report for the new owner.
    const stale = () => {
      if (isCurrent(startedScope)) return false;
      if (mounted.current) setOpening(null);
      return true;
    };
    const capture = (
      event: string,
      properties: Record<string, unknown>,
      dedupeKey: string,
    ) => {
      const owner = getPermittedAnalyticsUserId();
      if (scopeKey && (!owner || !scopeKey.startsWith(`${owner}:`))) return;
      if (traced) captureRecoveryEvent(event, properties, dedupeKey);
    };
    try {
      capture(
        action === "card"
          ? PAID_FUNNEL_EVENTS.billingPastDuePaymentUpdateClicked
          : "billing_renewal_invoice_open_clicked",
        handoffProperties,
        `${attemptId}:requested`,
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
      if (stale()) return;
      if (navigationBlocked.current) {
        // Chat or Agent work started while the link loaded. Leaving now would
        // interrupt it; the user can open billing again once it finishes.
        capture(
          BILLING_RECOVERY_HANDOFF_EVENT,
          {
            ...handoffProperties,
            handoff_stage: "url_discarded",
            discard_reason: "chat_in_flight",
          },
          `${attemptId}:url_discarded`,
        );
        setOpening(null);
        return;
      }
      capture(
        BILLING_RECOVERY_HANDOFF_EVENT,
        { ...handoffProperties, handoff_stage: "url_ready" },
        `${attemptId}:url_ready`,
      );
      window.location.href = url;
    } catch (error) {
      if (stale()) return;
      const failureStatus = handoffFailureStatus(error);
      capture(
        BILLING_RECOVERY_HANDOFF_EVENT,
        {
          ...handoffProperties,
          handoff_stage: "failed",
          ...(failureStatus && { failure_http_status: failureStatus }),
        },
        `${attemptId}:failed`,
      );
      setMessage(
        compact
          ? "Couldn’t open billing."
          : error instanceof Error
            ? error.message
            : "Could not open billing. Please try again.",
      );
      setFailedAction(action);
      setOpening(null);
    }
  };

  const check = async () => {
    if (checking || opening || recovering) return;
    setChecking(true);
    setMessage("");
    const startedScope = currentScope.current;
    try {
      const next = await onCheck();
      if (!isCurrent(startedScope)) return;
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
          next.billingReviewUnavailable
            ? "We couldn't verify your payment history. Try again or contact billing support."
            : "Your previous payment still needs review. Contact billing support.",
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
      if (isCurrent(startedScope))
        setMessage("We couldn't verify your billing status. Please try again.");
    } finally {
      if (mounted.current) setChecking(false);
    }
  };

  const startFresh = async () => {
    if (opening || checking || recovering) return;
    setRecovering(true);
    setMessage("");
    const startedScope = currentScope.current;
    const settleDiagnostic = beginServerActionDiagnostic(
      "billing_renewal_recovery",
    );
    try {
      let ready: boolean;
      try {
        ready = await recoverCanceledRenewal();
      } catch (error) {
        settleDiagnostic(error);
        throw error;
      }
      // Settle before onCheck so a later status-check failure is not attributed to the action.
      settleDiagnostic();
      const next = await onCheck();
      if (!isCurrent(startedScope)) return;
      if (
        !ready ||
        !next ||
        next.checkoutRequiresReview ||
        next.hasActiveSubscription
      ) {
        setMessage(
          "This payment still needs billing review. No new subscription was started. Use Get billing help.",
        );
        return;
      }
      toast.success("You can now choose a plan and subscribe again.");
    } catch {
      if (isCurrent(startedScope))
        setMessage(
          "We couldn't prepare your new subscription. Check payment status or try again.",
        );
    } finally {
      if (mounted.current) setRecovering(false);
    }
  };

  if (compact) {
    // Bank verification is completed on the hosted invoice; a new card cannot
    // satisfy it. Every other failure updates the payment method.
    const action =
      authentication && status.renewalInvoicePayable ? "invoice" : "card";
    // A funded card can pay the same invoice now instead of waiting for retry.
    const alternative =
      action === "card" && insufficientFunds && status.renewalInvoicePayable
        ? "invoice"
        : null;
    const plan = planName ? `${planName} ` : "";
    const keep = planName ?? "your plan";
    // Name a reason only when Stripe reported one; otherwise stay neutral.
    const [title, detail] =
      action === "invoice"
        ? [
            `Your ${plan}renewal needs bank verification.`,
            `Confirm it to keep ${keep}.`,
          ]
        : insufficientFunds
          ? [
              `Your ${plan}renewal was declined for insufficient funds.`,
              retryDate
                ? `We’ll retry on ${retryDate}. Add funds or update your card.`
                : `Add funds or update your card to keep ${keep}.`,
            ]
          : status.renewalPaymentFailure === "declined"
            ? [
                `Your ${plan}renewal payment was declined.`,
                `Update your card to keep ${keep}.`,
              ]
            : [
                `Your ${plan}renewal payment failed.`,
                `Update it to keep ${keep}.`,
              ];
    const label = (target: "invoice" | "card") =>
      opening === target ? (
        <>
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          Opening…
        </>
      ) : message && failedAction === target ? (
        "Try again"
      ) : target === "card" ? (
        "Update payment"
      ) : action === "invoice" ? (
        "Complete payment"
      ) : (
        "Pay invoice"
      );
    const busyTitle = actionDisabled
      ? "Available when the response finishes"
      : undefined;
    return (
      <section
        aria-label="Renewal payment"
        data-testid="renewal-payment-notice"
        className="mb-2 flex items-start gap-2.5 rounded-[22px] border border-black/8 bg-input-chat py-3 pr-1.5 pl-3.5 text-sm sm:items-center sm:py-2 sm:pr-2 dark:border-border"
      >
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 sm:mt-0 dark:text-amber-400"
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-2.5">
          <p className="flex min-w-0 flex-1 flex-wrap gap-x-1 leading-5">
            <span className="text-foreground">{title}</span>
            {message ? (
              <span role="status" className="text-foreground">
                {message}
              </span>
            ) : (
              <span
                // A known retry date matters on every width; the generic
                // prompt repeats the button and stays hidden on phones.
                className={
                  retryDate
                    ? "text-muted-foreground"
                    : "hidden text-muted-foreground sm:inline"
                }
              >
                {detail}
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              className="h-8 shrink-0 px-3.5 text-[13px] sm:h-7 sm:px-3 sm:text-xs"
              disabled={!!opening || actionDisabled}
              title={busyTitle}
              onClick={() => void open(action)}
            >
              {label(action)}
            </Button>
            {alternative && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 shrink-0 px-3 text-[13px] sm:h-7 sm:px-2.5 sm:text-xs"
                disabled={!!opening || actionDisabled}
                title={busyTitle}
                onClick={() => void open(alternative)}
              >
                {label(alternative)}
              </Button>
            )}
          </div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Hide renewal payment notice"
            className="flex h-8 w-8 shrink-0 -translate-y-1.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-7 sm:w-7 sm:translate-y-0"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </section>
    );
  }

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
              ? status.billingReviewUnavailable
                ? "We couldn’t verify your billing status"
                : "Your previous subscription has ended"
              : authentication
                ? "Confirm your renewal payment"
                : recovery
                  ? "Your renewal payment didn’t go through"
                  : "Your subscription needs billing attention"}
          </h3>
          <p className="text-muted-foreground">
            {review
              ? status.billingReviewUnavailable
                ? "Your previous subscription has ended, but we couldn’t check its payment history. Review billing or try again before subscribing."
                : "Start fresh to clear an eligible unpaid renewal, then choose a new plan. This won’t charge the old invoice. Paying an old invoice won’t restart that subscription."
              : authentication
                ? "Your bank needs you to confirm this payment. Complete verification securely with Stripe."
                : recovery
                  ? insufficientFunds
                    ? `Your bank declined the renewal for insufficient funds. Pay the invoice after adding funds, or update your card.${retryDate ? ` We’ll retry automatically on ${retryDate}.` : ""}`
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
        {review && !status.billingReviewUnavailable && (
          <Button
            size="sm"
            disabled={!!opening || checking || recovering}
            onClick={() => void startFresh()}
          >
            {recovering ? "Preparing…" : "Start fresh"}
          </Button>
        )}
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
              disabled={!!opening || checking || recovering}
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
          disabled={!!opening || checking || recovering}
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
          disabled={!!opening || checking || recovering}
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
