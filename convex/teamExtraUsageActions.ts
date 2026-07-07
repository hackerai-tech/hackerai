"use node";

import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";
import { convexLogger } from "./lib/logger";
import {
  extraUsageDollarsToPoints,
  extraUsagePointsToDollars,
} from "./lib/extraUsagePricing";

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
// Helpers (org-scoped variants of the per-user helpers in extraUsageActions.ts)
// =============================================================================

async function getOrgStripeCustomerId(
  organizationId: string,
): Promise<string | null> {
  const workos = getWorkOS();
  const organization =
    await workos.organizations.getOrganization(organizationId);
  return organization.stripeCustomerId || null;
}

async function getDefaultPaymentMethodId(
  customerId: string,
): Promise<string | null> {
  const stripe = getStripe();

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 1,
  });

  if (subscriptions.data?.[0]?.default_payment_method) {
    const pm = subscriptions.data[0].default_payment_method;
    return typeof pm === "string" ? pm : pm?.id || null;
  }

  const customerResponse = await stripe.customers.retrieve(customerId);
  if (customerResponse.deleted) return null;
  const customer = customerResponse as Stripe.Customer;

  const pm = customer.invoice_settings?.default_payment_method;
  return typeof pm === "string" ? pm : pm?.id || null;
}

async function createAutoReloadInvoice(
  customerId: string,
  paymentMethodId: string,
  amountCents: number,
  organizationId: string,
): Promise<{ success: boolean; paymentIntentId?: string; error?: string }> {
  const stripe = getStripe();

  try {
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: 0,
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      metadata: {
        type: "team_extra_usage_auto_reload",
        organizationId,
        amountDollars: String(amountCents / 100),
      },
    });

    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: amountCents,
      currency: "usd",
      description: `HackerAI Team Extra Usage Auto-Reload ($${amountCents / 100})`,
    });

    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    if (finalizedInvoice.status === "paid") {
      const paymentIntent = (
        finalizedInvoice as unknown as {
          payment_intent?: string | { id: string };
        }
      ).payment_intent;
      return {
        success: true,
        paymentIntentId:
          typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id,
      };
    }

    const paidInvoice = await stripe.invoices.pay(finalizedInvoice.id, {
      payment_method: paymentMethodId,
    });

    if (paidInvoice.status === "paid") {
      const paymentIntent = (
        paidInvoice as unknown as { payment_intent?: string | { id: string } }
      ).payment_intent;
      return {
        success: true,
        paymentIntentId:
          typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id,
      };
    }

    return { success: false, error: `Invoice status: ${paidInvoice.status}` };
  } catch (error) {
    const message =
      error instanceof Stripe.errors.StripeError
        ? error.message
        : "Payment failed";
    return { success: false, error: message };
  }
}

// =============================================================================
// Actions
// =============================================================================

/**
 * Create a Stripe Checkout session for buying team extra usage credits.
 * Charges the org's existing Stripe customer (the one used for the team
 * subscription). Admin-only check happens in the API route caller.
 */
export const createTeamPurchaseSession = action({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    amountDollars: v.number(),
    baseUrl: v.string(),
    checkoutAttemptId: v.optional(v.string()),
  },
  returns: v.object({
    url: v.union(v.string(), v.null()),
    error: v.optional(v.string()),
    checkoutSessionId: v.optional(v.string()),
  }),
  handler: async (_ctx, args) => {
    if (args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
      return { url: null, error: "Invalid service key" };
    }

    if (!Number.isInteger(args.amountDollars)) {
      return { url: null, error: "Amount must be a whole dollar value" };
    }
    if (args.amountDollars < 15) {
      return { url: null, error: "Minimum amount is $15" };
    }
    if (args.amountDollars > 999_999) {
      return { url: null, error: "Maximum amount is $999,999" };
    }
    if (!args.baseUrl || !args.baseUrl.startsWith("http")) {
      return { url: null, error: "Invalid base URL" };
    }

    try {
      const stripeCustomerId = await getOrgStripeCustomerId(
        args.organizationId,
      );
      if (!stripeCustomerId) {
        return {
          url: null,
          error: "No Stripe customer found for organization.",
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
                name: "HackerAI Team Extra Usage Credits",
                description: `$${args.amountDollars} in team extra usage credits`,
              },
              unit_amount: amountCents,
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
          type: "team_extra_usage_purchase",
          organizationId: args.organizationId,
          amountDollars: String(args.amountDollars),
          ...(args.checkoutAttemptId && {
            checkoutAttemptId: args.checkoutAttemptId,
          }),
        },
        success_url: `${args.baseUrl}/api/team/extra-usage/confirm?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: args.baseUrl,
      });

      convexLogger.info("team_purchase_session_created", {
        organization_id: args.organizationId,
        amount_dollars: args.amountDollars,
        session_id: session.id,
      });

      return { url: session.url, checkoutSessionId: session.id };
    } catch (error) {
      convexLogger.error("team_purchase_session_failed", {
        organization_id: args.organizationId,
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
 * Deduct from team balance with auto-reload support.
 * Called from the backend rate limit logic.
 *
 * Flow:
 * 1. Look up team-pool config + per-member state (via Convex query).
 * 2. If auto-reload threshold hit, charge org's Stripe customer.
 * 3. Run deductTeamPoints mutation (enforces caps and updates per-member tally).
 */
export const deductWithAutoReloadForTeam = action({
  args: {
    serviceKey: v.string(),
    organizationId: v.string(),
    userId: v.string(),
    amountPoints: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
    newBalanceDollars: v.number(),
    insufficientFunds: v.boolean(),
    monthlyCapExceeded: v.boolean(),
    memberCapExceeded: v.boolean(),
    memberDisabled: v.boolean(),
    poolDisabled: v.boolean(),
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
    if (args.serviceKey !== process.env.CONVEX_SERVICE_ROLE_KEY) {
      throw new Error("Invalid service key");
    }

    if (args.amountPoints <= 0) {
      return {
        success: true,
        newBalanceDollars: 0,
        insufficientFunds: false,
        monthlyCapExceeded: false,
        memberCapExceeded: false,
        memberDisabled: false,
        poolDisabled: false,
        autoReloadTriggered: false,
      };
    }

    const state: {
      enabled: boolean;
      balanceDollars: number;
      balancePoints: number;
      autoReloadEnabled: boolean;
      autoReloadThresholdDollars?: number;
      autoReloadThresholdPoints?: number;
      autoReloadAmountDollars?: number;
      memberDisabled: boolean;
    } = await ctx.runQuery(
      api.teamExtraUsage.getTeamExtraUsageStateForBackend,
      {
        serviceKey: args.serviceKey,
        organizationId: args.organizationId,
        userId: args.userId,
      },
    );

    const deductWithoutReload: {
      success: boolean;
      newBalancePoints: number;
      newBalanceDollars: number;
      insufficientFunds: boolean;
      monthlyCapExceeded: boolean;
      memberCapExceeded: boolean;
      memberDisabled: boolean;
      poolDisabled: boolean;
    } = await ctx.runMutation(api.teamExtraUsage.deductTeamPoints, {
      serviceKey: args.serviceKey,
      organizationId: args.organizationId,
      userId: args.userId,
      amountPoints: args.amountPoints,
    });

    let deductResult = deductWithoutReload;

    // If deduction was blocked for reasons unrelated to available balance,
    // do not attempt to auto-reload.
    const blockedForNonBalanceReason =
      !deductResult.success &&
      (!deductResult.insufficientFunds ||
        deductResult.monthlyCapExceeded ||
        deductResult.memberCapExceeded ||
        deductResult.memberDisabled ||
        deductResult.poolDisabled);

    if (blockedForNonBalanceReason) {
      return {
        success: deductResult.success,
        newBalanceDollars: deductResult.newBalanceDollars,
        insufficientFunds: deductResult.insufficientFunds,
        monthlyCapExceeded: deductResult.monthlyCapExceeded,
        memberCapExceeded: deductResult.memberCapExceeded,
        memberDisabled: deductResult.memberDisabled,
        poolDisabled: deductResult.poolDisabled,
        autoReloadTriggered: false,
      };
    }

    const thresholdPoints = state.autoReloadThresholdPoints ?? 0;
    const reloadAmount = state.autoReloadAmountDollars ?? 0;
    const requestedDeductionDollars = extraUsagePointsToDollars(
      args.amountPoints,
    );
    const requestNeedsReload = state.balancePoints < args.amountPoints;
    const balanceForReloadPoints = deductResult.success
      ? deductResult.newBalancePoints
      : state.balancePoints;
    const balanceForReloadDollars = deductResult.success
      ? deductResult.newBalanceDollars
      : state.balanceDollars;
    let autoReloadTriggered = false;
    let autoReloadResult:
      | { success: boolean; chargedAmountDollars?: number; reason?: string }
      | undefined;

    const allConditionsMet =
      state.enabled &&
      !state.memberDisabled &&
      state.autoReloadEnabled &&
      (balanceForReloadPoints <= thresholdPoints || requestNeedsReload) &&
      reloadAmount > 0;

    if (allConditionsMet) {
      autoReloadTriggered = true;
      const stripeCustomerId = await getOrgStripeCustomerId(
        args.organizationId,
      );
      if (!stripeCustomerId) {
        autoReloadResult = { success: false, reason: "no_stripe_customer" };
      } else {
        try {
          const customerObj =
            await getStripe().customers.retrieve(stripeCustomerId);
          const isBlocked =
            !customerObj.deleted &&
            (customerObj as Stripe.Customer).metadata?.blocked === "true";

          if (isBlocked) {
            autoReloadResult = { success: false, reason: "customer_blocked" };
          } else {
            const paymentMethodId =
              await getDefaultPaymentMethodId(stripeCustomerId);
            if (!paymentMethodId) {
              autoReloadResult = {
                success: false,
                reason: "no_default_payment_method",
              };
            } else {
              const currentBalanceDollars = balanceForReloadDollars;
              const targetBalanceDollars = Math.max(
                reloadAmount,
                requestNeedsReload ? requestedDeductionDollars : 0,
              );
              const rawAmountToCharge = Math.max(
                0,
                targetBalanceDollars - currentBalanceDollars,
              );

              const MIN_CHARGE_DOLLARS = 1;
              const amountToCharge =
                requestNeedsReload &&
                rawAmountToCharge > 0 &&
                rawAmountToCharge < MIN_CHARGE_DOLLARS
                  ? MIN_CHARGE_DOLLARS
                  : rawAmountToCharge;
              if (amountToCharge < MIN_CHARGE_DOLLARS) {
                autoReloadResult = {
                  success: false,
                  reason: "amount_to_charge_below_minimum",
                };
              } else {
                const amountToChargeCents = Math.round(amountToCharge * 100);
                const paymentResult = await createAutoReloadInvoice(
                  stripeCustomerId,
                  paymentMethodId,
                  amountToChargeCents,
                  args.organizationId,
                );

                if (paymentResult.success) {
                  const creditResult: {
                    newBalance: number;
                  } = await ctx.runMutation(api.teamExtraUsage.addTeamCredits, {
                    serviceKey: args.serviceKey,
                    organizationId: args.organizationId,
                    amountDollars: amountToCharge,
                    idempotencyKey: paymentResult.paymentIntentId,
                    revenueSource: "team_extra_usage_auto_reload",
                    stripeCustomerId,
                    stripePaymentIntentId: paymentResult.paymentIntentId,
                  });
                  if (deductResult.success) {
                    deductResult = {
                      ...deductResult,
                      newBalancePoints: extraUsageDollarsToPoints(
                        creditResult.newBalance,
                      ),
                      newBalanceDollars: creditResult.newBalance,
                    };
                  }
                  autoReloadResult = {
                    success: true,
                    chargedAmountDollars: amountToCharge,
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
        } catch {
          autoReloadResult = { success: false, reason: "stripe_lookup_failed" };
        }
      }
    }

    // Record auto-reload outcome (only real charge outcomes count toward
    // failure tracking — pre-charge config problems must not auto-disable).
    const PRE_CHARGE_REASONS = new Set([
      "no_stripe_customer",
      "customer_blocked",
      "no_default_payment_method",
      "stripe_lookup_failed",
      "amount_to_charge_below_minimum",
    ]);
    if (
      autoReloadTriggered &&
      autoReloadResult &&
      (autoReloadResult.success ||
        !PRE_CHARGE_REASONS.has(autoReloadResult.reason ?? ""))
    ) {
      await ctx.runMutation(
        internal.teamExtraUsage.recordTeamAutoReloadOutcome,
        {
          organizationId: args.organizationId,
          success: autoReloadResult.success,
          failureReason: autoReloadResult.reason,
        },
      );
    }

    if (autoReloadResult?.success && deductWithoutReload.insufficientFunds) {
      deductResult = await ctx.runMutation(
        api.teamExtraUsage.deductTeamPoints,
        {
          serviceKey: args.serviceKey,
          organizationId: args.organizationId,
          userId: args.userId,
          amountPoints: args.amountPoints,
        },
      );
    }

    convexLogger.info("team_deduct_with_auto_reload", {
      organization_id: args.organizationId,
      user_id: args.userId,
      amount_points: args.amountPoints,
      success: deductResult.success,
      new_balance_dollars: deductResult.newBalanceDollars,
      insufficient_funds: deductResult.insufficientFunds,
      monthly_cap_exceeded: deductResult.monthlyCapExceeded,
      member_cap_exceeded: deductResult.memberCapExceeded,
      member_disabled: deductResult.memberDisabled,
      pool_disabled: deductResult.poolDisabled,
      auto_reload_triggered: autoReloadTriggered,
      auto_reload_success: autoReloadResult?.success,
      auto_reload_charged_dollars: autoReloadResult?.chargedAmountDollars,
      auto_reload_failure_reason: autoReloadResult?.reason,
    });

    return {
      success: deductResult.success,
      newBalanceDollars: deductResult.newBalanceDollars,
      insufficientFunds: deductResult.insufficientFunds,
      monthlyCapExceeded: deductResult.monthlyCapExceeded,
      memberCapExceeded: deductResult.memberCapExceeded,
      memberDisabled: deductResult.memberDisabled,
      poolDisabled: deductResult.poolDisabled,
      autoReloadTriggered,
      autoReloadResult,
    };
  },
});
