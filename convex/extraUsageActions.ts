"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";

// =============================================================================
// SDK Initialization (lazy, cached)
// =============================================================================

let stripeInstance: Stripe | null = null;
let workosInstance: WorkOS | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    stripeInstance = new Stripe(key, { apiVersion: "2025-12-15.clover" });
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

async function getStripeCustomerId(userId: string): Promise<string | null> {
  const workos = getWorkOS();

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
  });

  if (!memberships.data || memberships.data.length === 0) {
    return null;
  }

  const organization = await workos.organizations.getOrganization(
    memberships.data[0].organizationId,
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

async function createAutoReloadPayment(
  customerId: string,
  paymentMethodId: string,
  amountCents: number,
  userId: string,
): Promise<{ success: boolean; paymentIntentId?: string; error?: string }> {
  const stripe = getStripe();

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        type: "extra_usage_auto_reload",
        userId,
        amountDollars: String(amountCents / 100),
      },
    });

    if (
      paymentIntent.status === "succeeded" ||
      paymentIntent.status === "processing"
    ) {
      return { success: true, paymentIntentId: paymentIntent.id };
    }

    return {
      success: false,
      error: `Payment status: ${paymentIntent.status}`,
    };
  } catch (error) {
    const message =
      error instanceof Stripe.errors.StripeError
        ? error.message
        : "Payment failed";
    return { success: false, error: message };
  }
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
      console.error("Error getting payment status:", error);
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
 * Accepts any positive dollar amount (minimum $5, maximum $1,000,000).
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

    // Validate amount
    if (args.amountDollars < 5) {
      return { url: null, error: "Minimum amount is $5" };
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
        },
        success_url: `${args.baseUrl}?extra-usage-purchased=true&amount=${args.amountDollars}`,
        cancel_url: args.baseUrl,
      });

      return { url: session.url };
    } catch (error) {
      console.error("Error creating purchase session:", error);
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

      const sessionParams: Stripe.BillingPortal.SessionCreateParams = {
        customer: stripeCustomerId,
        return_url: args.baseUrl,
      };

      // If flow=payment_method, direct user to update payment method
      if (args.flow === "payment_method") {
        sessionParams.flow_data = {
          type: "payment_method_update",
        };
      }

      const session = await stripe.billingPortal.sessions.create(sessionParams);

      return { url: session.url };
    } catch (error) {
      console.error("Error creating billing portal session:", error);
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
  },
  returns: v.object({
    success: v.boolean(),
    newBalanceDollars: v.number(),
    insufficientFunds: v.boolean(),
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
        autoReloadTriggered: false,
      };
    }

    // Get current settings (balance in both dollars and points)
    const settings: {
      balanceDollars: number;
      balancePoints: number;
      enabled: boolean;
      autoReloadEnabled: boolean;
      autoReloadThresholdDollars?: number;
      autoReloadThresholdPoints?: number;
      autoReloadAmountDollars?: number;
    } = await ctx.runQuery(api.extraUsage.getExtraUsageBalanceForBackend, {
      serviceKey: args.serviceKey,
      userId: args.userId,
    });

    // Use points for threshold comparison (more precise)
    const thresholdPoints: number = settings.autoReloadThresholdPoints ?? 0;
    const reloadAmount: number = settings.autoReloadAmountDollars ?? 0;
    let autoReloadTriggered = false;
    let autoReloadResult:
      | { success: boolean; chargedAmountDollars?: number; reason?: string }
      | undefined;

    // Check if auto-reload is needed (compare in points for precision)
    if (
      settings.autoReloadEnabled &&
      settings.balancePoints < args.amountPoints &&
      settings.balancePoints <= thresholdPoints &&
      reloadAmount > 0
    ) {
      autoReloadTriggered = true;

      // Get Stripe customer ID
      const stripeCustomerId = await getStripeCustomerId(args.userId);
      if (!stripeCustomerId) {
        autoReloadResult = { success: false, reason: "no_stripe_customer" };
      } else {
        // Get default payment method
        const paymentMethodId =
          await getDefaultPaymentMethodId(stripeCustomerId);
        if (!paymentMethodId) {
          autoReloadResult = {
            success: false,
            reason: "no_default_payment_method",
          };
        } else {
          // Create payment (Stripe uses cents)
          const reloadAmountCents = Math.round(reloadAmount * 100);
          const paymentResult = await createAutoReloadPayment(
            stripeCustomerId,
            paymentMethodId,
            reloadAmountCents,
            args.userId,
          );

          if (paymentResult.success) {
            // Add credits (dollars -> points conversion happens in mutation)
            await ctx.runMutation(api.extraUsage.addCredits, {
              serviceKey: args.serviceKey,
              userId: args.userId,
              amountDollars: reloadAmount,
            });
            autoReloadResult = {
              success: true,
              chargedAmountDollars: reloadAmount,
            };
          } else {
            autoReloadResult = {
              success: false,
              reason: paymentResult.error || "payment_failed",
            };
          }
        }
      }
    }

    // Now deduct from balance using points directly (no precision loss)
    const deductResult: {
      success: boolean;
      newBalancePoints: number;
      newBalanceDollars: number;
      insufficientFunds: boolean;
    } = await ctx.runMutation(api.extraUsage.deductPoints, {
      serviceKey: args.serviceKey,
      userId: args.userId,
      amountPoints: args.amountPoints,
    });

    return {
      success: deductResult.success,
      newBalanceDollars: deductResult.newBalanceDollars,
      insufficientFunds: deductResult.insufficientFunds,
      autoReloadTriggered,
      autoReloadResult,
    };
  },
});
