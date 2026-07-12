"use node";

import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";
import { convexLogger } from "./lib/logger";
import { extraUsageDollarsToPoints } from "./lib/extraUsagePricing";

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

async function getStripeCustomerId(userId: string): Promise<string | null> {
  const workos = getWorkOS();

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    statuses: ["active"],
  });

  if (!memberships.data || memberships.data.length === 0) {
    return null;
  }

  const billingMembership = memberships.data.find(canManageOrganizationBilling);
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

const REDACTED_VALUE = "[Redacted]";
const SENSITIVE_FIELD_PATTERN =
  /(["']?\b(?:serviceKey|service_key|apiKey|api_key|authorization|bearer|cookie|password|secret|token)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;
const ENV_SECRET_PATTERN =
  /(["']?\b(?:CONVEX_SERVICE_ROLE_KEY|POSTHOG_API_KEY|STRIPE_SECRET_KEY)\b["']?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

const redactSensitiveErrorMessage = (message: string): string =>
  message
    .replace(SENSITIVE_FIELD_PATTERN, (_match, key, separator) => {
      return `${key}${separator}"${REDACTED_VALUE}"`;
    })
    .replace(ENV_SECRET_PATTERN, (_match, key, separator) => {
      return `${key}${separator}"${REDACTED_VALUE}"`;
    });

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
    baseUrl: v.string(),
    checkoutAttemptId: v.optional(v.string()),
  },
  returns: v.object({
    url: v.union(v.string(), v.null()),
    error: v.optional(v.string()),
    checkoutSessionId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { url: null, error: "Not authenticated" };
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

    // Basic URL validation
    if (!args.baseUrl || !args.baseUrl.startsWith("http")) {
      return { url: null, error: "Invalid base URL" };
    }

    try {
      const stripeCustomerId = await getStripeCustomerId(identity.subject);
      if (!stripeCustomerId) {
        return {
          url: null,
          error: "No Stripe customer found. Please subscribe first.",
        };
      }

      const stripe = getStripe();
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
        },
        success_url: `${args.baseUrl}/api/extra-usage/confirm?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: args.baseUrl,
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
  handler: async (ctx, args) => {
    // Validate service key
    if (args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
      throw new Error("Invalid service key");
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
              convexLogger.error("extra_usage_stripe_customer_lookup_failed", {
                user_id: args.userId,
                amount_points: args.amountPoints,
                operation: "get_stripe_customer",
                duration_ms: Date.now() - stripeLookupStartedAt,
                error: serializeErrorForLog(error),
              });
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
                  (customerObj as Stripe.Customer).metadata?.blocked === "true";

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
            deductResult = await ctx.runMutation(api.extraUsage.deductPoints, {
              serviceKey: args.serviceKey,
              userId: args.userId,
              amountPoints: args.amountPoints,
              usageSettlementId: args.usageSettlementId,
            });
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
  },
});
