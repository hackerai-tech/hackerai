"use node";

import { runWalletSettlement, linkWalletReload } from "./lib/settlementAction";

import { action, type ActionCtx } from "./lib/serviceFunctions";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";
import { convexLogger } from "./lib/logger";
import { extraUsageDollarsToPoints } from "./lib/extraUsagePricing";
import {
  getExtraUsageBundle,
  extraUsageBundlesEnabled,
} from "../lib/billing/extra-usage-bundles";
import { planLookupKeyToTier } from "../lib/analytics/paid-funnel";
import { GRANDFATHERED_PRO_MONTHLY_PRICE_ID } from "../lib/pricing/pro-monthly";
import { GRANDFATHERED_PRO_YEARLY_PRICE_ID } from "../lib/pricing/pro-yearly";
import { includedUsagePointsForStripePrice } from "../lib/billing/included-usage";
import { BILLING_ERRORS } from "../lib/billing/billing-errors";
import { redactSensitiveErrorMessage } from "../lib/utils/error-redaction";

// =============================================================================
// SDK Initialization (lazy, cached)
// =============================================================================

let stripeInstance: Stripe | null = null;
let workosInstance: WorkOS | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

function getWorkOS(): WorkOS {
  if (!workosInstance) {
    const key = process.env.WORKOS_API_KEY;
    if (!key) throw new Error("WORKOS_API_KEY not configured");
    workosInstance = new WorkOS(key, {
      clientId: process.env.WORKOS_CLIENT_ID,
    });
  }
  return workosInstance;
}

// =============================================================================
// Helper Functions
// =============================================================================

type BillingMembership = {
  organizationId: string;
  status?: string;
  role?: { slug?: string } | null;
  roles?: Array<{ slug?: string } | null> | null;
};

function canManageOrganizationBilling(membership: BillingMembership): boolean {
  const status = membership.status;
  const roleSlug = membership.role?.slug;
  const roles = membership.roles;
  const hasBillingRole =
    roleSlug === "admin" ||
    roleSlug === "owner" ||
    roles?.some((role) => role?.slug === "admin" || role?.slug === "owner");

  return (status === undefined || status === "active") && !!hasBillingRole;
}

const DEFAULT_APPLICATION_ORIGINS = new Set(["https://hackerai.co"]);

/** Restrict Stripe return URLs to exact server-configured application origins. */
function isAllowedApplicationOrigin(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";

  if (isLocalhost) {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  if (url.protocol !== "https:") {
    return false;
  }

  const allowedOrigins = new Set(DEFAULT_APPLICATION_ORIGINS);
  for (const configuredOrigin of (
    process.env.EXTRA_USAGE_CHECKOUT_ALLOWED_ORIGINS ?? ""
  ).split(",")) {
    const value = configuredOrigin.trim();
    if (!value) continue;

    try {
      allowedOrigins.add(new URL(value).origin);
    } catch {
      // Ignore malformed server configuration rather than trusting it.
    }
  }

  return allowedOrigins.has(url.origin);
}

async function getStripeCustomerId(
  userId: string,
  organizationId?: string,
): Promise<string | null> {
  const workos = getWorkOS();

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    ...(organizationId && { organizationId }),
    statuses: ["active"],
  });

  if (!memberships.data || memberships.data.length === 0) {
    return null;
  }

  const billingMembership = memberships.data.find(
    (membership) =>
      (!organizationId || membership.organizationId === organizationId) &&
      canManageOrganizationBilling(membership),
  );
  if (!billingMembership) {
    return null;
  }

  const organization = await workos.organizations.getOrganization(
    billingMembership.organizationId,
  );

  return organization.stripeCustomerId || null;
}

async function getStripePaymentMethod(customerId: string): Promise<{
  hasPaymentMethod: boolean;
  last4?: string;
  brand?: string;
}> {
  const stripe = getStripe();

  // Get active subscriptions to find default payment method
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 1,
  });

  let paymentMethodId: string | null = null;

  if (subscriptions.data && subscriptions.data.length > 0) {
    const sub = subscriptions.data[0];
    paymentMethodId =
      typeof sub.default_payment_method === "string"
        ? sub.default_payment_method
        : sub.default_payment_method?.id || null;
  }

  // If no payment method from subscription, check customer's default
  if (!paymentMethodId) {
    const customerResponse = await stripe.customers.retrieve(customerId);
    if (customerResponse.deleted) {
      return { hasPaymentMethod: false };
    }
    // Type narrowing: after the deleted check, we know it's a Customer
    const customer = customerResponse as Stripe.Customer;

    const invoiceSettings = customer.invoice_settings;
    paymentMethodId =
      typeof invoiceSettings?.default_payment_method === "string"
        ? invoiceSettings.default_payment_method
        : invoiceSettings?.default_payment_method?.id || null;
  }

  if (!paymentMethodId) {
    return { hasPaymentMethod: false };
  }

  // Get payment method details
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

  return {
    hasPaymentMethod: true,
    last4: paymentMethod.card?.last4,
    brand: paymentMethod.card?.brand ?? undefined,
  };
}

async function getDefaultPaymentMethodId(
  customerId: string,
): Promise<string | null> {
  const stripe = getStripe();

  // First check active subscriptions
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 1,
  });

  if (subscriptions.data?.[0]?.default_payment_method) {
    const pm = subscriptions.data[0].default_payment_method;
    return typeof pm === "string" ? pm : pm?.id || null;
  }

  // Fall back to customer's default payment method
  const customerResponse = await stripe.customers.retrieve(customerId);
  if (customerResponse.deleted) {
    return null;
  }
  // Type narrowing: after the deleted check, we know it's a Customer
  const customer = customerResponse as Stripe.Customer;

  const invoiceSettings = customer.invoice_settings;
  const pm = invoiceSettings?.default_payment_method;
  return typeof pm === "string" ? pm : pm?.id || null;
}

const serializeErrorForLog = (error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();

  return {
    name,
    message: redactSensitiveErrorMessage(message).slice(0, 1_000),
  };
};

async function createAutoReloadPayment(
  customerId: string,
  paymentMethodId: string,
  amountCents: number,
  userId: string,
  operationId: string,
  existingInvoiceId: string | undefined,
  recordInvoice: (invoiceId: string) => Promise<void>,
): Promise<{
  success: boolean;
  invoiceId?: string;
  paymentIntentId?: string;
  error?: string;
  failureKind?: "definitive" | "indeterminate" | "released";
}> {
  const stripe = getStripe();
  let invoice: Stripe.Invoice | undefined;

  try {
    // Every POST in the invoice sequence uses the same persisted operation as
    // its idempotency root. Retrying after a timeout therefore resumes the
    // original invoice instead of charging the card again.
    invoice = existingInvoiceId
      ? await stripe.invoices.retrieve(existingInvoiceId)
      : await stripe.invoices.create(
          {
            customer: customerId,
            collection_method: "send_invoice",
            days_until_due: 0,
            auto_advance: false,
            pending_invoice_items_behavior: "exclude",
            metadata: {
              type: "extra_usage_auto_reload",
              userId,
              amountDollars: String(amountCents / 100),
              operationId,
            },
          },
          { idempotencyKey: `${operationId}:invoice` },
        );

    if (!existingInvoiceId) {
      await recordInvoice(invoice.id);
    }

    if (invoice.status === "draft") {
      await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: invoice.id,
          amount: amountCents,
          currency: "usd",
          description: `HackerAI Extra Usage Auto-Reload ($${amountCents / 100})`,
        },
        { idempotencyKey: `${operationId}:item` },
      );

      invoice = await stripe.invoices.finalizeInvoice(
        invoice.id,
        {},
        { idempotencyKey: `${operationId}:finalize` },
      );
    }

    // Check if already paid (shouldn't happen, but handle it)
    if (invoice.status === "paid") {
      const paymentIntent = (
        invoice as unknown as {
          payment_intent?: string | { id: string };
        }
      ).payment_intent;
      return {
        success: true,
        invoiceId: invoice.id,
        paymentIntentId:
          typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id,
      };
    }

    // Pay the invoice with the specified payment method
    if (invoice.status !== "open") {
      return {
        success: false,
        invoiceId: invoice.id,
        error: `Invoice status: ${invoice.status}`,
        failureKind: "definitive",
      };
    }

    const paidInvoice = await stripe.invoices.pay(
      invoice.id,
      { payment_method: paymentMethodId },
      { idempotencyKey: `${operationId}:pay` },
    );

    if (paidInvoice.status === "paid") {
      const paymentIntent = (
        paidInvoice as unknown as { payment_intent?: string | { id: string } }
      ).payment_intent;
      return {
        success: true,
        invoiceId: paidInvoice.id,
        paymentIntentId:
          typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id,
      };
    }

    return {
      success: false,
      invoiceId: paidInvoice.id,
      error: `Invoice status: ${paidInvoice.status}`,
      failureKind: "definitive",
    };
  } catch (error) {
    const message =
      error instanceof Stripe.errors.StripeError
        ? error.message
        : "Payment failed";
    const stripeErrorType =
      error instanceof Stripe.errors.StripeError
        ? (error as Stripe.errors.StripeError).type
        : undefined;
    const definitive = stripeErrorType === "StripeCardError";
    const released =
      stripeErrorType === "StripeAuthenticationError" ||
      stripeErrorType === "StripePermissionError" ||
      stripeErrorType === "StripeInvalidRequestError";
    if (definitive && invoice && invoice.status === "open") {
      try {
        await stripe.invoices.voidInvoice(
          invoice.id,
          {},
          { idempotencyKey: `${operationId}:void` },
        );
      } catch {
        // Do not forget an invoice that might still be payable. Retain the
        // operation for reconciliation if voiding did not complete cleanly.
        return {
          success: false,
          invoiceId: invoice.id,
          error: message,
          failureKind: "indeterminate",
        };
      }
    }
    return {
      success: false,
      invoiceId: invoice?.id,
      error: message,
      failureKind: definitive
        ? "definitive"
        : released && !invoice?.id
          ? "released"
          : "indeterminate",
    };
  }
}

const isMissingStripeResource = (error: unknown): boolean => {
  const stripeError = error as {
    type?: string;
    code?: string;
    statusCode?: number;
  };
  return (
    stripeError?.type === "StripeInvalidRequestError" &&
    (stripeError.code === "resource_missing" || stripeError.statusCode === 404)
  );
};

type RetireAutoReloadInvoiceResult =
  | { status: "released" }
  | { status: "paid"; invoice: Stripe.Invoice }
  | { status: "indeterminate" };

/**
 * Retire a known unpaid invoice before clearing a stale wallet operation.
 * Draft invoices cannot have charged the customer and can be deleted; open
 * invoices are voided with a stable idempotency key. Any ambiguous Stripe
 * result keeps the operation quarantined for the next reconciliation pass.
 */
async function retireAutoReloadInvoice(
  invoice: Stripe.Invoice,
  operationId: string,
): Promise<RetireAutoReloadInvoiceResult> {
  const stripe = getStripe();
  if (invoice.status === "paid") return { status: "paid", invoice };
  if (invoice.status === "void" || invoice.status === "uncollectible") {
    return { status: "released" };
  }

  try {
    if (invoice.status === "draft") {
      await stripe.invoices.del(invoice.id);
      return { status: "released" };
    }
    if (invoice.status === "open") {
      const voidedInvoice = await stripe.invoices.voidInvoice(
        invoice.id,
        {},
        { idempotencyKey: `${operationId}:void-stale` },
      );
      if (voidedInvoice.status === "void") return { status: "released" };
      if (voidedInvoice.status === "paid") {
        return { status: "paid", invoice: voidedInvoice };
      }
    }
  } catch (error) {
    if (isMissingStripeResource(error)) return { status: "released" };
    try {
      const latestInvoice = await stripe.invoices.retrieve(invoice.id);
      if (latestInvoice.status === "paid") {
        return { status: "paid", invoice: latestInvoice };
      }
      if (
        latestInvoice.status === "void" ||
        latestInvoice.status === "uncollectible"
      ) {
        return { status: "released" };
      }
    } catch (reconcileError) {
      if (isMissingStripeResource(reconcileError)) {
        return { status: "released" };
      }
    }
  }

  return { status: "indeterminate" };
}

// =============================================================================
// Discounted bundle checkout (monthly cap)
// =============================================================================

type BundleCapSnapshot = {
  policyVersion: string;
  periodMonth: string;
  resetsAt: number;
  capDollars: number;
  usedDollars: number;
  pendingDollars: number;
  remainingDollars: number;
  historyComplete: boolean;
};

type PendingBundleHold =
  | {
      kind: "reservation";
      reservationId: Id<"extra_usage_bundle_reservations">;
      bundleId: string;
      stripeCheckoutSessionId?: string;
      stripeCustomerId: string;
      createdAt: number;
    }
  | { kind: "legacy"; bundleId: string; stripeCheckoutSessionId: string };

type BundleCheckoutErrorCode =
  | "bundle_cap_exceeded"
  | "bundle_cap_unavailable"
  | "bundle_checkout_pending"
  | "bundle_checkout_unresolved"
  | "bundle_checkout_failed"
  | "bundle_checkout_complete"
  | "bundle_attempt_conflict";

type PurchaseSessionResult = {
  url: string | null;
  error?: string;
  checkoutSessionId?: string;
  errorCode?: BundleCheckoutErrorCode;
  retryable?: boolean;
  reservationReused?: boolean;
  bundleCap?: BundleCapSnapshot;
};

type BundleReleaseReason = "stripe_session_expired" | "stripe_payment_canceled";

/**
 * Unlinked holds younger than this probably have a create call in flight, so
 * reconciliation does not search for their session yet. Searching never
 * releases a hold by itself; only a verified unpaid final session does.
 */
const UNLINKED_BUNDLE_HOLD_SEARCH_AFTER_MS = 5 * 60_000;
const MAX_BUNDLE_HOLDS_RECONCILED = 10;
const UNRESOLVED_BUNDLE_CHECKOUT_MESSAGE =
  "We couldn't confirm your earlier checkout for this bundle, so it stays reserved. Custom amounts at standard price are still available, or contact support to resolve it.";
const MAX_CHECKOUT_ATTEMPT_ID_LENGTH = 100;

const bundleCapSnapshotValidator = v.object({
  policyVersion: v.string(),
  periodMonth: v.string(),
  resetsAt: v.number(),
  capDollars: v.number(),
  usedDollars: v.number(),
  pendingDollars: v.number(),
  remainingDollars: v.number(),
  historyComplete: v.boolean(),
});

const formatUtcResetDate = (resetsAt: number) =>
  new Date(resetsAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** Stripe-confirmed unpaid outcomes only; open or pending sessions keep holds. */
function unpaidBundleSessionReason(
  session: Stripe.Checkout.Session,
): BundleReleaseReason | null {
  if (
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required"
  )
    return null;
  if (session.status === "expired") return "stripe_session_expired";
  const paymentIntent = session.payment_intent;
  if (
    session.status === "complete" &&
    paymentIntent &&
    typeof paymentIntent === "object" &&
    paymentIntent.status === "canceled"
  )
    return "stripe_payment_canceled";
  return null;
}

/** Stripe rejected the request itself, so no session exists for its key. */
const isDefinitiveStripeCreateFailure = (error: unknown): boolean => {
  const type = (error as { type?: string } | null)?.type;
  return (
    type === "StripeInvalidRequestError" ||
    type === "StripeAuthenticationError" ||
    type === "StripePermissionError"
  );
};

/**
 * Find the session created with an unlinked reservation's key and link it.
 * Absence is never proof that no session exists: a lost create response, a
 * listing page limit or eventual consistency all look the same.
 */
async function discoverReservationSession(
  ctx: ActionCtx,
  hold: {
    reservationId: Id<"extra_usage_bundle_reservations">;
    stripeCustomerId: string;
    createdAt: number;
  },
): Promise<string | null> {
  const page = await getStripe().checkout.sessions.list({
    customer: hold.stripeCustomerId,
    created: { gte: Math.floor(hold.createdAt / 1000) - 60 },
    limit: 100,
  });
  const session = page.data.find(
    (candidate) =>
      candidate.metadata?.bundleReservationId === hold.reservationId,
  );
  if (!session) return null;
  await ctx.runMutation(internal.extraUsageBundles.attachBundleSession, {
    reservationId: hold.reservationId,
    stripeCheckoutSessionId: session.id,
  });
  return session.id;
}

const logUnresolvedBundleHold = (
  userId: string,
  reservationId: string,
  reason: "session_not_found" | "stripe_lookup_failed",
  error?: unknown,
) =>
  convexLogger.error("extra_usage_bundle_hold_unresolved", {
    user_id: userId,
    reservation_id: reservationId,
    reason,
    remediation:
      "Search Stripe Checkout sessions for metadata.bundleReservationId; release the hold only if its session is expired or unpaid.",
    ...(error !== undefined && { error: serializeErrorForLog(error) }),
  });

/**
 * Release holds whose Checkout sessions Stripe confirms can no longer be paid.
 * Any lookup failure or unresolved hold keeps its allowance and is logged.
 */
async function reconcilePendingBundleHolds(
  ctx: ActionCtx,
  userId: string,
  holds: PendingBundleHold[],
): Promise<boolean> {
  const stripe = getStripe();
  let releasedAny = false;
  for (const hold of holds.slice(0, MAX_BUNDLE_HOLDS_RECONCILED)) {
    try {
      let sessionId = hold.stripeCheckoutSessionId;
      if (!sessionId && hold.kind === "reservation") {
        if (Date.now() - hold.createdAt < UNLINKED_BUNDLE_HOLD_SEARCH_AFTER_MS)
          continue;
        sessionId = (await discoverReservationSession(ctx, hold)) ?? undefined;
        if (!sessionId) {
          logUnresolvedBundleHold(
            userId,
            hold.reservationId,
            "session_not_found",
          );
          continue;
        }
      }
      const session = await stripe.checkout.sessions.retrieve(sessionId!, {
        expand: ["payment_intent"],
      });
      const reason = unpaidBundleSessionReason(session);
      if (reason) {
        releasedAny =
          (await ctx.runMutation(internal.extraUsageBundles.releaseBundleHold, {
            userId,
            reason,
            stripeCheckoutSessionId: session.id,
            ...(hold.kind === "reservation" && {
              bundleReservationId: hold.reservationId,
            }),
          })) || releasedAny;
      }
    } catch (error) {
      convexLogger.warn("extra_usage_bundle_hold_reconcile_failed", {
        user_id: userId,
        hold_kind: hold.kind,
        reservation_id:
          hold.kind === "reservation" ? hold.reservationId : undefined,
        stripe_checkout_session_id: hold.stripeCheckoutSessionId,
        error: serializeErrorForLog(error),
      });
    }
  }
  return releasedAny;
}

/**
 * Hold monthly bundle allowance, then create (or resume) the reservation's
 * Checkout session. Stripe calls reuse the reservation's idempotency key, so a
 * retry of the same attempt can never add a second hold or session.
 */
async function createBundleCheckoutSession(
  ctx: ActionCtx,
  input: {
    userId: string;
    bundle: ReturnType<typeof getExtraUsageBundle>;
    checkoutAttemptId: string;
    stripeCustomerId: string;
    applicationOrigin: string;
    returnPath?: string;
    resumeAfterPurchase?: boolean;
    enableExtraUsageAfterPurchase?: boolean;
  },
  allowExpiredRestart = true,
): Promise<PurchaseSessionResult> {
  const stripe = getStripe();
  const reserveArgs = {
    userId: input.userId,
    bundleId: input.bundle.id,
    checkoutAttemptId: input.checkoutAttemptId,
    stripeCustomerId: input.stripeCustomerId,
    applicationOrigin: input.applicationOrigin,
    returnPath: input.returnPath,
    resumeAfterPurchase: input.resumeAfterPurchase,
    enableExtraUsageAfterPurchase: input.enableExtraUsageAfterPurchase,
  };
  let reservation = await ctx.runMutation(
    internal.extraUsageBundles.reserveBundle,
    reserveArgs,
  );
  if (
    reservation.status === "blocked" &&
    reservation.pendingHolds.length > 0 &&
    (await reconcilePendingBundleHolds(
      ctx,
      input.userId,
      reservation.pendingHolds,
    ))
  ) {
    reservation = await ctx.runMutation(
      internal.extraUsageBundles.reserveBundle,
      reserveArgs,
    );
  }

  const logContext = {
    user_id: input.userId,
    bundle_id: input.bundle.id,
    credit_dollars: input.bundle.creditDollars,
    checkout_attempt_id: input.checkoutAttemptId,
  };

  if (reservation.status === "attempt_conflict") {
    return {
      url: null,
      error: "Checkout attempt does not match this bundle. Please try again.",
      errorCode: "bundle_attempt_conflict",
      retryable: false,
    };
  }
  if (reservation.status === "unavailable") {
    return {
      url: null,
      error:
        "Discounted bundles are temporarily unavailable. Standard top-ups still work.",
      errorCode: "bundle_cap_unavailable",
      retryable: false,
      bundleCap: reservation.cap,
    };
  }
  if (reservation.status === "blocked") {
    const { cap } = reservation;
    convexLogger.info("extra_usage_bundle_cap_blocked", {
      ...logContext,
      policy_version: cap.policyVersion,
      period_month: cap.periodMonth,
      remaining_dollars: cap.remainingDollars,
      pending_dollars: cap.pendingDollars,
      used_dollars: cap.usedDollars,
    });
    return {
      url: null,
      error: `This bundle exceeds your monthly bundle limit: $${cap.remainingDollars.toLocaleString("en-US")} of $${cap.capDollars.toLocaleString("en-US")} left until ${formatUtcResetDate(cap.resetsAt)} (UTC). Custom amounts are still available.`,
      errorCode: "bundle_cap_exceeded",
      retryable: false,
      bundleCap: cap,
    };
  }

  const resumed = reservation.status === "legacy_pending" || reservation.reused;
  const result = (fields: Omit<PurchaseSessionResult, "bundleCap">) => ({
    ...fields,
    bundleCap: reservation.cap,
    ...(resumed && { reservationReused: true }),
  });

  /**
   * Resume an existing pending session: return it while open, release and
   * restart once if Stripe says it can no longer be paid, otherwise report it.
   */
  const resumeSession = async (
    sessionId: string,
    reservationId?: Id<"extra_usage_bundle_reservations">,
  ): Promise<PurchaseSessionResult> => {
    let existing: Stripe.Checkout.Session;
    try {
      existing = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent"],
      });
    } catch (error) {
      convexLogger.warn("extra_usage_bundle_checkout_resume_failed", {
        ...logContext,
        reservation_id: reservationId,
        stripe_checkout_session_id: sessionId,
        error: serializeErrorForLog(error),
      });
      return result({
        url: null,
        error: "Could not resume your checkout. Please try again.",
        errorCode: "bundle_checkout_pending",
        retryable: true,
      });
    }
    if (existing.status === "open" && existing.url) {
      return result({ url: existing.url, checkoutSessionId: existing.id });
    }
    if (existing.payment_status === "paid") {
      // Recover a lost success redirect or delayed webhook through the same
      // idempotent fulfillment endpoint instead of leaving paid credit pending.
      return result({
        url: `${input.applicationOrigin}/api/extra-usage/confirm?session_id=${encodeURIComponent(existing.id)}`,
        checkoutSessionId: existing.id,
      });
    }
    const unpaidReason = unpaidBundleSessionReason(existing);
    if (
      unpaidReason &&
      allowExpiredRestart &&
      (await ctx.runMutation(internal.extraUsageBundles.releaseBundleHold, {
        userId: input.userId,
        reason: unpaidReason,
        stripeCheckoutSessionId: existing.id,
        ...(reservationId && { bundleReservationId: reservationId }),
      }))
    ) {
      return await createBundleCheckoutSession(ctx, input, false);
    }
    return result({
      url: null,
      error:
        existing.payment_status === "paid"
          ? "This checkout has already been completed."
          : "Your payment for this bundle is still processing.",
      errorCode: "bundle_checkout_complete",
      retryable: false,
    });
  };

  if (reservation.status === "legacy_pending") {
    return await resumeSession(reservation.stripeCheckoutSessionId);
  }

  const reservationId = reservation.reservationId;
  if (reservation.stripeCheckoutSessionId) {
    return await resumeSession(
      reservation.stripeCheckoutSessionId,
      reservationId,
    );
  }

  if (!reservation.mayCreate) {
    // Past the idempotency replay window a new POST could mint a second
    // payable session, so only search for the one this key may have created.
    let sessionId: string | null;
    try {
      sessionId = await discoverReservationSession(ctx, {
        reservationId,
        stripeCustomerId: reservation.stripeCustomerId,
        createdAt: reservation.createdAt,
      });
    } catch (error) {
      logUnresolvedBundleHold(
        input.userId,
        reservationId,
        "stripe_lookup_failed",
        error,
      );
      return result({
        url: null,
        error: "Could not check your earlier checkout. Please try again.",
        errorCode: "bundle_checkout_pending",
        retryable: true,
      });
    }
    if (sessionId) return await resumeSession(sessionId, reservationId);
    logUnresolvedBundleHold(input.userId, reservationId, "session_not_found");
    return result({
      url: null,
      error: UNRESOLVED_BUNDLE_CHECKOUT_MESSAGE,
      errorCode: "bundle_checkout_unresolved",
      retryable: false,
    });
  }

  // Every input comes from the reservation, so replaying the idempotency key
  // on retry sends identical parameters and returns the original session.
  const cancelUrl = reservation.returnPath
    ? new URL(reservation.returnPath, reservation.applicationOrigin).toString()
    : reservation.applicationOrigin;
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        customer: reservation.stripeCustomerId,
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "HackerAI Extra Usage Credits",
                description: `$${input.bundle.creditDollars} in extra usage credits`,
              },
              unit_amount: input.bundle.paidDollars * 100,
            },
            quantity: 1,
          },
        ],
        invoice_creation: { enabled: true },
        saved_payment_method_options: {
          allow_redisplay_filters: ["always", "limited"],
          payment_method_save: "enabled",
        },
        metadata: {
          type: "extra_usage_purchase",
          userId: input.userId,
          amountDollars: String(input.bundle.creditDollars),
          bundleId: input.bundle.id,
          paidAmountDollars: String(input.bundle.paidDollars),
          bundleReservationId: reservationId,
          bundleCapPeriod: reservation.periodMonth,
          bundleCapPolicyVersion: reservation.policyVersion,
          checkoutAttemptId: reservation.checkoutAttemptId,
          ...(reservation.returnPath && {
            returnPath: reservation.returnPath,
          }),
          ...(reservation.resumeAfterPurchase && {
            resumeAfterPurchase: "true",
          }),
          ...(reservation.enableExtraUsageAfterPurchase && {
            enableExtraUsageAfterPurchase: "true",
          }),
        },
        success_url: `${reservation.applicationOrigin}/api/extra-usage/confirm?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
      },
      { idempotencyKey: `extra_usage_bundle:${reservationId}` },
    );
  } catch (error) {
    const definitive = isDefinitiveStripeCreateFailure(error);
    let released = false;
    // Only the first call for this key proves no session exists; after a
    // retry, an earlier call may have created one. The mutation re-checks.
    if (definitive && reservation.createAttempts === 1) {
      released = await ctx.runMutation(
        internal.extraUsageBundles.releaseBundleHold,
        {
          userId: input.userId,
          reason: "stripe_create_rejected",
          bundleReservationId: reservationId,
        },
      );
    }
    convexLogger.warn("extra_usage_bundle_checkout_create_failed", {
      ...logContext,
      reservation_id: reservationId,
      create_attempts: reservation.createAttempts,
      failure_kind: definitive ? "definitive" : "indeterminate",
      hold_released: released,
      error: serializeErrorForLog(error),
    });
    return result(
      released
        ? {
            url: null,
            error:
              error instanceof Stripe.errors.StripeError
                ? error.message
                : "Could not start checkout. Please try again.",
            errorCode: "bundle_checkout_failed",
            retryable: true,
          }
        : {
            url: null,
            error:
              "Checkout is taking longer than expected. Try again to resume it.",
            errorCode: "bundle_checkout_pending",
            retryable: true,
          },
    );
  }

  let attached = true;
  try {
    attached = await ctx.runMutation(
      internal.extraUsageBundles.attachBundleSession,
      { reservationId, stripeCheckoutSessionId: session.id },
    );
  } catch (error) {
    // The hold still counts; fulfillment and reconciliation link it later
    // through the session's bundleReservationId metadata.
    convexLogger.warn("extra_usage_bundle_session_link_failed", {
      ...logContext,
      reservation_id: reservationId,
      stripe_checkout_session_id: session.id,
      error: serializeErrorForLog(error),
    });
  }
  if (!attached) {
    // The hold was released while this create ran; never sell without one.
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      convexLogger.error("extra_usage_bundle_orphan_session_expire_failed", {
        ...logContext,
        reservation_id: reservationId,
        stripe_checkout_session_id: session.id,
        error: serializeErrorForLog(error),
      });
    }
    return result({
      url: null,
      error: "Checkout could not be started. Please try again.",
      errorCode: "bundle_checkout_failed",
      retryable: true,
    });
  }

  try {
    await ctx.runMutation(internal.extraUsage.recordPurchaseCreated, {
      userId: input.userId,
      amountDollars: input.bundle.creditDollars,
      bundleId: input.bundle.id,
      paidAmountDollars: input.bundle.paidDollars,
      stripeCheckoutSessionId: session.id,
    });
  } catch (error) {
    convexLogger.warn("purchase_session_record_failed", {
      user_id: input.userId,
      amount_dollars: input.bundle.creditDollars,
      session_id: session.id,
      error: serializeErrorForLog(error),
    });
  }

  convexLogger.info("purchase_session_created", {
    ...logContext,
    amount_dollars: input.bundle.creditDollars,
    session_id: session.id,
    reservation_id: reservationId,
    reservation_reused: reservation.reused,
    policy_version: reservation.policyVersion,
    period_month: reservation.periodMonth,
  });

  return result({ url: session.url, checkoutSessionId: session.id });
}

// =============================================================================
// Convex Actions
// =============================================================================

/**
 * Get user's payment status (has valid payment method)
 */
export const getPaymentStatus = action({
  args: {},
  returns: v.object({
    hasPaymentMethod: v.boolean(),
    paymentMethodLast4: v.union(v.string(), v.null()),
    paymentMethodBrand: v.union(v.string(), v.null()),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        hasPaymentMethod: false,
        paymentMethodLast4: null,
        paymentMethodBrand: null,
      };
    }

    try {
      const stripeCustomerId = await getStripeCustomerId(identity.subject);
      if (!stripeCustomerId) {
        return {
          hasPaymentMethod: false,
          paymentMethodLast4: null,
          paymentMethodBrand: null,
        };
      }

      const paymentInfo = await getStripePaymentMethod(stripeCustomerId);

      return {
        hasPaymentMethod: paymentInfo.hasPaymentMethod,
        paymentMethodLast4: paymentInfo.last4 || null,
        paymentMethodBrand: paymentInfo.brand || null,
      };
    } catch (error) {
      console.error("Payment status check failed:", error);
      return {
        hasPaymentMethod: false,
        paymentMethodLast4: null,
        paymentMethodBrand: null,
      };
    }
  },
});

/**
 * Create a Stripe Checkout session for purchasing extra usage credits.
 * Accepts any positive dollar amount (minimum $15, maximum $999,999).
 *
 * Note: baseUrl is passed from the client for redirect URLs only.
 * This is safe because:
 * 1. These URLs are only used for redirects after payment
 * 2. The actual payment confirmation happens via secure webhooks
 * 3. A malicious user can only redirect themselves to a different site
 */
export const createPurchaseSession = action({
  args: {
    amountDollars: v.number(),
    bundleId: v.optional(v.string()),
    baseUrl: v.string(),
    checkoutAttemptId: v.optional(v.string()),
    returnPath: v.optional(v.string()),
    resumeAfterPurchase: v.optional(v.boolean()),
    enableExtraUsageAfterPurchase: v.optional(v.boolean()),
  },
  returns: v.object({
    url: v.union(v.string(), v.null()),
    error: v.optional(v.string()),
    checkoutSessionId: v.optional(v.string()),
    errorCode: v.optional(
      v.union(
        v.literal("bundle_cap_exceeded"),
        v.literal("bundle_cap_unavailable"),
        v.literal("bundle_checkout_pending"),
        v.literal("bundle_checkout_unresolved"),
        v.literal("bundle_checkout_failed"),
        v.literal("bundle_checkout_complete"),
        v.literal("bundle_attempt_conflict"),
      ),
    ),
    retryable: v.optional(v.boolean()),
    reservationReused: v.optional(v.boolean()),
    bundleCap: v.optional(bundleCapSnapshotValidator),
  }),
  handler: async (ctx, args): Promise<PurchaseSessionResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { url: null, error: "Not authenticated" };
    }

    const activeSuspension = await ctx.runQuery(
      api.userSuspensions.getActiveByUser,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId: identity.subject,
      },
    );
    if (activeSuspension?.status === "active") {
      return { url: null, error: BILLING_ERRORS.accountSuspended };
    }

    let bundle;
    if (args.bundleId !== undefined) {
      if (!extraUsageBundlesEnabled(identity.subject))
        return { url: null, error: "Bundles are not available" };
      try {
        bundle = getExtraUsageBundle(args.bundleId);
      } catch {
        return { url: null, error: "Unknown bundle" };
      }
      if (args.amountDollars !== bundle.creditDollars)
        return { url: null, error: "Bundle amount mismatch" };
      if (
        args.checkoutAttemptId !== undefined &&
        (!args.checkoutAttemptId ||
          args.checkoutAttemptId.length > MAX_CHECKOUT_ATTEMPT_ID_LENGTH)
      )
        return { url: null, error: "Invalid checkout attempt" };
    }
    // Validate amount
    if (!Number.isInteger(args.amountDollars)) {
      return { url: null, error: "Amount must be a whole dollar value" };
    }
    if (args.amountDollars < 15) {
      return { url: null, error: "Minimum amount is $15" };
    }
    if (args.amountDollars > 999_999) {
      return { url: null, error: "Maximum amount is $999,999" };
    }

    let applicationOrigin: string;
    try {
      const applicationUrl = new URL(args.baseUrl);
      if (!isAllowedApplicationOrigin(applicationUrl)) {
        return { url: null, error: "Invalid base URL" };
      }
      applicationOrigin = applicationUrl.origin;
    } catch {
      return { url: null, error: "Invalid base URL" };
    }

    let returnUrl: URL | undefined;
    if (
      args.returnPath !== undefined &&
      (!args.returnPath.startsWith("/") || args.returnPath.length > 400)
    ) {
      return { url: null, error: "Invalid return path" };
    }
    if (args.returnPath) {
      returnUrl = new URL(args.returnPath, applicationOrigin);
      if (returnUrl.origin !== applicationOrigin) {
        return { url: null, error: "Invalid return path" };
      }
    }

    try {
      // WorkOS access tokens bind the active organization in the signed org_id claim.
      const activeOrganizationId =
        typeof identity.org_id === "string" && identity.org_id
          ? identity.org_id
          : undefined;
      if (bundle && !activeOrganizationId) {
        return {
          url: null,
          error: "Select your personal organization before buying a bundle",
        };
      }
      const stripeCustomerId = await getStripeCustomerId(
        identity.subject,
        bundle ? activeOrganizationId : undefined,
      );
      if (!stripeCustomerId) {
        return {
          url: null,
          error: "No Stripe customer found. Please subscribe first.",
        };
      }

      const stripe = getStripe();
      if (bundle) {
        const subscriptions = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: "active",
          limit: 100,
        });
        if (
          !subscriptions.data.some((subscription) =>
            subscription.items.data.some((item) => {
              // Lookup keys move to new prices; existing Pro subscribers retain these IDs.
              if (
                item.price.id === GRANDFATHERED_PRO_MONTHLY_PRICE_ID ||
                item.price.id === GRANDFATHERED_PRO_YEARLY_PRICE_ID ||
                includedUsagePointsForStripePrice(item.price.id) !== undefined
              )
                return true;
              const tier = planLookupKeyToTier(
                item.price.lookup_key ?? undefined,
              );
              return tier === "pro" || tier === "pro-plus" || tier === "ultra";
            }),
          )
        )
          return {
            url: null,
            error: "An active paid subscription is required",
          };
        return await createBundleCheckoutSession(ctx, {
          userId: identity.subject,
          bundle,
          // Stale clients may omit an attempt; they then get no retry reuse.
          checkoutAttemptId: args.checkoutAttemptId ?? crypto.randomUUID(),
          stripeCustomerId,
          applicationOrigin,
          returnPath: args.returnPath,
          resumeAfterPurchase: args.resumeAfterPurchase,
          enableExtraUsageAfterPurchase: args.enableExtraUsageAfterPurchase,
        });
      }
      const amountCents = args.amountDollars * 100;

      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "HackerAI Extra Usage Credits",
                description: `$${args.amountDollars} in extra usage credits`,
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        invoice_creation: { enabled: true },
        // Show saved payment methods in Checkout UI
        saved_payment_method_options: {
          allow_redisplay_filters: ["always", "limited"],
          payment_method_save: "enabled",
        },
        metadata: {
          type: "extra_usage_purchase",
          userId: identity.subject,
          amountDollars: String(args.amountDollars),
          ...(args.checkoutAttemptId && {
            checkoutAttemptId: args.checkoutAttemptId,
          }),
          ...(args.returnPath && { returnPath: args.returnPath }),
          ...(args.resumeAfterPurchase && { resumeAfterPurchase: "true" }),
          ...(args.enableExtraUsageAfterPurchase && {
            enableExtraUsageAfterPurchase: "true",
          }),
        },
        success_url: `${applicationOrigin}/api/extra-usage/confirm?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: returnUrl?.toString() ?? applicationOrigin,
      });

      try {
        await ctx.runMutation(internal.extraUsage.recordPurchaseCreated, {
          userId: identity.subject,
          amountDollars: args.amountDollars,
          stripeCheckoutSessionId: session.id,
        });
      } catch (error) {
        convexLogger.warn("purchase_session_record_failed", {
          user_id: identity.subject,
          amount_dollars: args.amountDollars,
          session_id: session.id,
          error: serializeErrorForLog(error),
        });
      }

      convexLogger.info("purchase_session_created", {
        user_id: identity.subject,
        amount_dollars: args.amountDollars,
        session_id: session.id,
      });

      return { url: session.url, checkoutSessionId: session.id };
    } catch (error) {
      convexLogger.error("purchase_session_failed", {
        user_id: identity.subject,
        amount_dollars: args.amountDollars,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      const message =
        error instanceof Stripe.errors.StripeError
          ? error.message
          : error instanceof Error
            ? error.message
            : "An error occurred";
      return { url: null, error: message };
    }
  },
});

/**
 * Create a Stripe Billing Portal session URL.
 * Returns the URL for the frontend to redirect to.
 *
 * @param flow - Optional flow type: "payment_method" to go directly to payment method update
 * @param baseUrl - The base URL for the return URL (passed from client)
 */
export const createBillingPortalSession = action({
  args: {
    flow: v.optional(v.string()),
    baseUrl: v.string(),
  },
  returns: v.object({
    url: v.union(v.string(), v.null()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { url: null, error: "Not authenticated" };
    }

    const activeSuspension = await ctx.runQuery(
      api.userSuspensions.getActiveByUser,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId: identity.subject,
      },
    );
    if (activeSuspension?.status === "active") {
      return { url: null, error: BILLING_ERRORS.accountSuspended };
    }

    // Basic URL validation
    if (!args.baseUrl || !args.baseUrl.startsWith("http")) {
      return { url: null, error: "Invalid base URL" };
    }

    try {
      const stripeCustomerId = await getStripeCustomerId(identity.subject);
      if (!stripeCustomerId) {
        return { url: null, error: "No billing account found" };
      }

      const stripe = getStripe();

      const sessionParams: Parameters<
        typeof stripe.billingPortal.sessions.create
      >[0] = {
        customer: stripeCustomerId,
        return_url: args.baseUrl,
      };

      // If flow=payment_method, direct user to update payment method
      if (args.flow === "payment_method") {
        sessionParams!.flow_data = {
          type: "payment_method_update",
        };
      }

      const session = await stripe.billingPortal.sessions.create(sessionParams);

      return { url: session.url };
    } catch (error) {
      console.error("Billing portal session creation failed:", error);
      const message =
        error instanceof Stripe.errors.StripeError
          ? error.message
          : error instanceof Error
            ? error.message
            : "An error occurred";
      return { url: null, error: message };
    }
  },
});

/**
 * Deduct from user's balance with auto-reload support.
 * This is called from the backend rate limit logic.
 *
 * Accepts points directly to avoid precision loss from dollar conversion.
 * (1 point = $0.0001, so sub-cent amounts are preserved)
 *
 * Flow:
 * 1. Get user's settings and current balance (in points)
 * 2. Check if auto-reload is needed (balance below threshold)
 * 3. If needed, charge via Stripe and add credits
 * 4. Deduct the requested points
 */
export const deductWithAutoReload = action({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    amountPoints: v.number(),
    usageSettlementId: v.optional(v.string()),
    settlementOperationId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    newBalanceDollars: v.number(),
    insufficientFunds: v.boolean(),
    monthlyCapExceeded: v.boolean(),
    autoReloadTriggered: v.boolean(),
    autoReloadResult: v.optional(
      v.object({
        success: v.boolean(),
        chargedAmountDollars: v.optional(v.number()),
        reason: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) =>
    runWalletSettlement(ctx, args, async () => {
      let debitSequence = 0;
      // Validate service key
      if (args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
        throw new Error("Invalid service key");
      }

      const activeSuspension = await ctx.runQuery(
        api.userSuspensions.getActiveByUser,
        {
          serviceKey: args.serviceKey,
          userId: args.userId,
        },
      );
      if (activeSuspension?.status === "active") {
        return {
          success: false,
          newBalanceDollars: 0,
          insufficientFunds: true,
          monthlyCapExceeded: false,
          autoReloadTriggered: false,
          autoReloadResult: {
            success: false,
            reason: "account_suspended",
          },
        };
      }

      if (args.amountPoints <= 0) {
        return {
          success: true,
          newBalanceDollars: 0,
          insufficientFunds: false,
          monthlyCapExceeded: false,
          autoReloadTriggered: false,
        };
      }

      const actionStartedAt = Date.now();

      // Get current settings (balance in both dollars and points)
      let settings: {
        balanceDollars: number;
        balancePoints: number;
        enabled: boolean;
        autoReloadEnabled: boolean;
        autoReloadThresholdDollars?: number;
        autoReloadThresholdPoints?: number;
        autoReloadAmountDollars?: number;
        autoReloadOperationPending: boolean;
        monthlyRemainingDollars?: number;
      };
      const balanceLookupStartedAt = Date.now();
      try {
        settings = await ctx.runQuery(
          api.extraUsage.getExtraUsageBalanceForBackend,
          {
            serviceKey: args.serviceKey,
            userId: args.userId,
          },
        );
      } catch (error) {
        convexLogger.error("extra_usage_balance_backend_query_failed", {
          user_id: args.userId,
          amount_points: args.amountPoints,
          usage_settlement_id: args.usageSettlementId,
          operation: "get_extra_usage_balance",
          convex_function: "extraUsage.getExtraUsageBalanceForBackend",
          duration_ms: Date.now() - balanceLookupStartedAt,
          error: serializeErrorForLog(error),
        });
        throw error;
      }

      // Deduct first. The mutation is transactional, so parallel Agent steps
      // cannot spend the same wallet balance. Auto-reload is only coordinated if
      // this debit is underfunded or the successful debit crosses the threshold.
      let autoReloadTriggered = false;
      let autoReloadResult:
        | { success: boolean; chargedAmountDollars?: number; reason?: string }
        | undefined;
      let deductResult: {
        success: boolean;
        newBalancePoints: number;
        newBalanceDollars: number;
        insufficientFunds: boolean;
        monthlyCapExceeded: boolean;
      };
      const deductPointsStartedAt = Date.now();
      try {
        deductResult = await ctx.runMutation(api.extraUsage.deductPoints, {
          serviceKey: args.serviceKey,
          userId: args.userId,
          amountPoints: args.amountPoints,
          usageSettlementId: args.usageSettlementId,
          ...(args.settlementOperationId && {
            settlementOperationId: args.settlementOperationId,
            settlementDebitSequence: debitSequence++,
          }),
        });
      } catch (error) {
        convexLogger.error("extra_usage_deduct_points_failed", {
          user_id: args.userId,
          amount_points: args.amountPoints,
          usage_settlement_id: args.usageSettlementId,
          operation: "deduct_points",
          convex_function: "extraUsage.deductPoints",
          duration_ms: Date.now() - deductPointsStartedAt,
          error: serializeErrorForLog(error),
        });
        throw error;
      }

      const requestNeedsReload =
        !deductResult.success &&
        deductResult.insufficientFunds &&
        !deductResult.monthlyCapExceeded;
      const thresholdReached =
        deductResult.success &&
        deductResult.newBalancePoints <=
          (settings.autoReloadThresholdPoints ?? 0);

      if (
        settings.autoReloadOperationPending ||
        (settings.autoReloadEnabled && (requestNeedsReload || thresholdReached))
      ) {
        for (let reloadAttempt = 0; reloadAttempt < 2; reloadAttempt++) {
          let retryAutoReload = false;
          const candidateOperationId = crypto.randomUUID();
          const candidateExecutorId = crypto.randomUUID();
          let claim = await ctx.runMutation(
            internal.extraUsage.claimAutoReloadOperation,
            {
              userId: args.userId,
              candidateOperationId,
              candidateExecutorId,
              requestedAmountPoints: requestNeedsReload ? args.amountPoints : 0,
            },
          );

          // A threshold top-up is best-effort once this step's debit succeeded.
          // Underfunded followers briefly wait for the one active Stripe executor;
          // they never drive the same operation concurrently.
          if (
            claim.status === "operation" &&
            !claim.claimed &&
            requestNeedsReload
          ) {
            for (const delayMs of [250, 500, 1_000, 2_000]) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              claim = await ctx.runMutation(
                internal.extraUsage.claimAutoReloadOperation,
                {
                  userId: args.userId,
                  candidateOperationId,
                  candidateExecutorId,
                  requestedAmountPoints: args.amountPoints,
                },
              );
              if (claim.status !== "operation" || claim.claimed) break;
            }
          }

          if (claim.status === "not_needed" && requestNeedsReload) {
            // Another parallel operation may have funded the wallet between the
            // failed debit and the atomic claim. Re-read by retrying the mutation.
            deductResult = await ctx.runMutation(api.extraUsage.deductPoints, {
              serviceKey: args.serviceKey,
              userId: args.userId,
              amountPoints: args.amountPoints,
              usageSettlementId: args.usageSettlementId,
              ...(args.settlementOperationId && {
                settlementOperationId: args.settlementOperationId,
                settlementDebitSequence: debitSequence++,
              }),
            });
          } else if (claim.status === "cooldown") {
            autoReloadTriggered = true;
            autoReloadResult = {
              success: false,
              reason: claim.reason ?? "payment_failed",
            };
          } else if (claim.status === "blocked") {
            if (
              claim.reason === "monthly_cap_exceeded" &&
              !deductResult.success
            ) {
              deductResult = {
                ...deductResult,
                insufficientFunds: true,
                monthlyCapExceeded: true,
              };
            }
          } else if (claim.status === "operation" && !claim.claimed) {
            if (requestNeedsReload) {
              autoReloadTriggered = true;
            }
          } else if (
            claim.status === "operation" &&
            claim.claimed &&
            claim.operationId &&
            claim.executorId &&
            claim.amountDollars !== undefined
          ) {
            autoReloadTriggered = true;
            const operationId = claim.operationId;
            const executorId = claim.executorId;
            const amountDollars = claim.amountDollars;
            const releaseOperation = async () =>
              await ctx.runMutation(
                internal.extraUsage.completeAutoReloadOperation,
                {
                  userId: args.userId,
                  operationId,
                  executorId,
                  outcome: "released",
                },
              );
            const releaseExecutor = async () =>
              await ctx.runMutation(
                internal.extraUsage.completeAutoReloadOperation,
                {
                  userId: args.userId,
                  operationId,
                  executorId,
                  outcome: "executor_released",
                },
              );
            const releasePreCharge = async () =>
              operationId === candidateOperationId && !claim.stripeInvoiceId
                ? await releaseOperation()
                : await releaseExecutor();

            try {
              await linkWalletReload(ctx, args, operationId);
            } catch (error) {
              await releasePreCharge();
              throw error;
            }

            const creditOperation = async ({
              invoiceId,
              paymentIntentId,
              stripeCustomerId,
            }: {
              invoiceId: string;
              paymentIntentId?: string;
              stripeCustomerId?: string;
            }) => {
              const creditResult = await ctx.runMutation(
                api.extraUsage.addCredits,
                {
                  serviceKey: args.serviceKey,
                  userId: args.userId,
                  amountDollars,
                  idempotencyKey: `personal_auto_reload:${operationId}`,
                  revenueSource: "extra_usage_auto_reload",
                  stripeCustomerId,
                  stripePaymentIntentId: paymentIntentId,
                  stripeInvoiceId: invoiceId,
                },
              );
              const completed = await ctx.runMutation(
                internal.extraUsage.completeAutoReloadOperation,
                {
                  userId: args.userId,
                  operationId,
                  executorId,
                  outcome: "success",
                },
              );
              autoReloadResult = {
                success: true,
                chargedAmountDollars: amountDollars,
              };
              if (deductResult.success && !creditResult.alreadyProcessed) {
                deductResult = {
                  ...deductResult,
                  newBalancePoints: extraUsageDollarsToPoints(
                    creditResult.newBalance,
                  ),
                  newBalanceDollars: creditResult.newBalance,
                };
              }
              if (completed) {
                try {
                  await ctx.runMutation(
                    internal.extraUsage.recordAutoReloadOutcome,
                    { userId: args.userId, success: true },
                  );
                } catch (error) {
                  convexLogger.error(
                    "extra_usage_auto_reload_outcome_record_failed",
                    {
                      user_id: args.userId,
                      operation_id: operationId,
                      auto_reload_success: true,
                      error: serializeErrorForLog(error),
                    },
                  );
                }
              }
            };

            let shouldPreparePayment = true;
            if (claim.stripeInvoiceId) {
              try {
                const existingInvoice = await getStripe().invoices.retrieve(
                  claim.stripeInvoiceId,
                );
                if (existingInvoice.status === "paid") {
                  const paymentIntent = (
                    existingInvoice as unknown as {
                      payment_intent?: string | { id: string };
                    }
                  ).payment_intent;
                  await creditOperation({
                    invoiceId: existingInvoice.id,
                    paymentIntentId:
                      typeof paymentIntent === "string"
                        ? paymentIntent
                        : paymentIntent?.id,
                  });
                  shouldPreparePayment = false;
                } else if (
                  (!requestNeedsReload && !thresholdReached) ||
                  claim.paymentAllowed === false ||
                  existingInvoice.status === "void" ||
                  existingInvoice.status === "uncollectible"
                ) {
                  const reason =
                    claim.paymentBlockedReason ??
                    (existingInvoice.status === "void" ||
                    existingInvoice.status === "uncollectible"
                      ? "invoice_not_payable"
                      : "reload_not_needed");
                  autoReloadResult = {
                    success: false,
                    reason,
                  };
                  const retirement = await retireAutoReloadInvoice(
                    existingInvoice,
                    operationId,
                  );
                  if (retirement.status === "paid") {
                    const paymentIntent = (
                      retirement.invoice as unknown as {
                        payment_intent?: string | { id: string };
                      }
                    ).payment_intent;
                    await creditOperation({
                      invoiceId: retirement.invoice.id,
                      paymentIntentId:
                        typeof paymentIntent === "string"
                          ? paymentIntent
                          : paymentIntent?.id,
                    });
                  } else if (retirement.status === "released") {
                    const released = await releaseOperation();
                    retryAutoReload =
                      requestNeedsReload && released && reloadAttempt === 0;
                  } else {
                    await releaseExecutor();
                  }
                  shouldPreparePayment = false;
                }
              } catch (error) {
                convexLogger.error("extra_usage_auto_reload_reconcile_failed", {
                  user_id: args.userId,
                  operation_id: operationId,
                  error: serializeErrorForLog(error),
                });
                const invoiceMissing = isMissingStripeResource(error);
                autoReloadResult = {
                  success: false,
                  reason: invoiceMissing
                    ? "invoice_missing"
                    : "payment_state_unknown",
                };
                if (invoiceMissing) {
                  const released = await releaseOperation();
                  retryAutoReload =
                    requestNeedsReload && released && reloadAttempt === 0;
                } else {
                  await releaseExecutor();
                }
                shouldPreparePayment = false;
              }
            } else if (
              (!requestNeedsReload && !thresholdReached) ||
              claim.paymentAllowed === false
            ) {
              autoReloadResult = {
                success: false,
                reason: claim.paymentBlockedReason ?? "reload_not_needed",
              };
              // Payment cannot start before the Stripe invoice id is persisted.
              // Clearing an id-less stale operation can at worst leave an inert
              // draft invoice (auto_advance=false), never a second card charge.
              const released = await releaseOperation();
              retryAutoReload =
                requestNeedsReload && released && reloadAttempt === 0;
              shouldPreparePayment = false;
            }

            // Get Stripe customer ID
            if (shouldPreparePayment) {
              const stripeLookupStartedAt = Date.now();
              let stripeCustomerId: string | null = null;
              try {
                stripeCustomerId = await getStripeCustomerId(args.userId);
              } catch (error) {
                convexLogger.error(
                  "extra_usage_stripe_customer_lookup_failed",
                  {
                    user_id: args.userId,
                    amount_points: args.amountPoints,
                    operation: "get_stripe_customer",
                    duration_ms: Date.now() - stripeLookupStartedAt,
                    error: serializeErrorForLog(error),
                  },
                );
                autoReloadResult = {
                  success: false,
                  reason: "stripe_lookup_failed",
                };
              }
              if (!stripeCustomerId) {
                autoReloadResult ??= {
                  success: false,
                  reason: "no_stripe_customer",
                };
                await releasePreCharge();
              } else {
                let paymentStarted = false;
                try {
                  // Check if customer is blocked (fraud flagged) before attempting charge
                  const customerObj =
                    await getStripe().customers.retrieve(stripeCustomerId);
                  const isBlocked =
                    !customerObj.deleted &&
                    (customerObj as Stripe.Customer).metadata?.blocked ===
                      "true";

                  if (isBlocked) {
                    autoReloadResult = {
                      success: false,
                      reason: "customer_blocked",
                    };
                    await releasePreCharge();
                  } else {
                    // Get default payment method
                    const paymentMethodId =
                      await getDefaultPaymentMethodId(stripeCustomerId);
                    if (!paymentMethodId) {
                      autoReloadResult = {
                        success: false,
                        reason: "no_default_payment_method",
                      };
                      await releasePreCharge();
                    } else {
                      paymentStarted = true;
                      const paymentResult = await createAutoReloadPayment(
                        stripeCustomerId,
                        paymentMethodId,
                        Math.round(amountDollars * 100),
                        args.userId,
                        operationId,
                        claim.stripeInvoiceId,
                        async (stripeInvoiceId) => {
                          const recorded = await ctx.runMutation(
                            internal.extraUsage.recordAutoReloadInvoice,
                            {
                              userId: args.userId,
                              operationId,
                              executorId,
                              stripeInvoiceId,
                            },
                          );
                          if (!recorded) {
                            throw new Error(
                              "Auto-reload operation executor changed",
                            );
                          }
                        },
                      );

                      if (paymentResult.success && paymentResult.invoiceId) {
                        await creditOperation({
                          invoiceId: paymentResult.invoiceId,
                          paymentIntentId: paymentResult.paymentIntentId,
                          stripeCustomerId,
                        });
                      } else {
                        const reason =
                          paymentResult.error ||
                          (paymentResult.success
                            ? "missing_payment_intent"
                            : "payment_failed");
                        autoReloadResult = { success: false, reason };
                        if (paymentResult.failureKind === "definitive") {
                          const completed = await ctx.runMutation(
                            internal.extraUsage.completeAutoReloadOperation,
                            {
                              userId: args.userId,
                              operationId,
                              executorId,
                              outcome: "definitive_failure",
                              failureReason: reason,
                            },
                          );
                          if (completed) {
                            try {
                              await ctx.runMutation(
                                internal.extraUsage.recordAutoReloadOutcome,
                                {
                                  userId: args.userId,
                                  success: false,
                                  failureReason: reason,
                                },
                              );
                            } catch (error) {
                              convexLogger.error(
                                "extra_usage_auto_reload_outcome_record_failed",
                                {
                                  user_id: args.userId,
                                  operation_id: operationId,
                                  auto_reload_success: false,
                                  error: serializeErrorForLog(error),
                                },
                              );
                            }
                          }
                        } else if (paymentResult.failureKind === "released") {
                          await releasePreCharge();
                        } else {
                          await releaseExecutor();
                        }
                      }
                    }
                  }
                } catch (error) {
                  convexLogger.error("extra_usage_auto_reload_lookup_failed", {
                    user_id: args.userId,
                    amount_points: args.amountPoints,
                    operation: "prepare_auto_reload_payment",
                    duration_ms: Date.now() - stripeLookupStartedAt,
                    error: serializeErrorForLog(error),
                  });
                  autoReloadResult = {
                    success: false,
                    reason: paymentStarted
                      ? "payment_state_unknown"
                      : "stripe_lookup_failed",
                  };
                  // Once a Stripe POST may have started, retain the operation and its
                  // idempotency keys. A later call can safely resume it. Releasing here
                  // could mint a new operation and double-charge an indeterminate one.
                  if (paymentStarted) {
                    await releaseExecutor();
                  } else {
                    await releasePreCharge();
                  }
                }
              }
            }

            if (requestNeedsReload && autoReloadResult?.success) {
              deductResult = await ctx.runMutation(
                api.extraUsage.deductPoints,
                {
                  serviceKey: args.serviceKey,
                  userId: args.userId,
                  amountPoints: args.amountPoints,
                  usageSettlementId: args.usageSettlementId,
                  ...(args.settlementOperationId && {
                    settlementOperationId: args.settlementOperationId,
                    settlementDebitSequence: debitSequence++,
                  }),
                },
              );
              retryAutoReload =
                reloadAttempt === 0 &&
                !deductResult.success &&
                deductResult.insufficientFunds &&
                !deductResult.monthlyCapExceeded;
            }
          }
          if (retryAutoReload) {
            autoReloadResult = undefined;
            continue;
          }
          break;
        }
      }

      convexLogger.info("deduct_with_auto_reload", {
        user_id: args.userId,
        settlement_operation_id: args.settlementOperationId,
        amount_points: args.amountPoints,
        usage_settlement_id: args.usageSettlementId,
        success: deductResult.success,
        new_balance_dollars: deductResult.newBalanceDollars,
        insufficient_funds: deductResult.insufficientFunds,
        monthly_cap_exceeded: deductResult.monthlyCapExceeded,
        auto_reload_triggered: autoReloadTriggered,
        auto_reload_success: autoReloadResult?.success,
        auto_reload_charged_dollars: autoReloadResult?.chargedAmountDollars,
        auto_reload_failure_reason: autoReloadResult?.reason,
        duration_ms: Date.now() - actionStartedAt,
      });

      return {
        success: deductResult.success,
        newBalanceDollars: deductResult.newBalanceDollars,
        insufficientFunds: deductResult.insufficientFunds,
        monthlyCapExceeded: deductResult.monthlyCapExceeded,
        autoReloadTriggered,
        autoReloadResult,
      };
    }),
});
