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
              type: "team_extra_usage_auto_reload",
              organizationId,
              amountDollars: String(amountCents / 100),
              operationId,
            },
          },
          { idempotencyKey: `${operationId}:invoice` },
        );

    if (!existingInvoiceId) await recordInvoice(invoice.id);

    if (invoice.status === "draft") {
      await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: invoice.id,
          amount: amountCents,
          currency: "usd",
          description: `HackerAI Team Extra Usage Auto-Reload ($${amountCents / 100})`,
        },
        { idempotencyKey: `${operationId}:item` },
      );
      invoice = await stripe.invoices.finalizeInvoice(
        invoice.id,
        {},
        { idempotencyKey: `${operationId}:finalize` },
      );
    }

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
    usageSettlementId: v.optional(v.string()),
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
      autoReloadOperationPending: boolean;
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
      usageSettlementId: args.usageSettlementId,
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

    if (blockedForNonBalanceReason && !state.autoReloadOperationPending) {
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

    const requestNeedsReload =
      !deductResult.success &&
      deductResult.insufficientFunds &&
      !deductResult.monthlyCapExceeded &&
      !deductResult.memberCapExceeded &&
      !deductResult.memberDisabled &&
      !deductResult.poolDisabled;
    const thresholdReached =
      deductResult.success &&
      deductResult.newBalancePoints <= (state.autoReloadThresholdPoints ?? 0);
    let autoReloadTriggered = false;
    let autoReloadResult:
      | { success: boolean; chargedAmountDollars?: number; reason?: string }
      | undefined;

    if (
      state.autoReloadOperationPending ||
      (state.enabled &&
        !state.memberDisabled &&
        state.autoReloadEnabled &&
        (requestNeedsReload || thresholdReached))
    ) {
      for (let reloadAttempt = 0; reloadAttempt < 2; reloadAttempt++) {
        let retryAutoReload = false;
        const candidateOperationId = crypto.randomUUID();
        const candidateExecutorId = crypto.randomUUID();
        let claim = await ctx.runMutation(
          internal.teamExtraUsage.claimTeamAutoReloadOperation,
          {
            organizationId: args.organizationId,
            candidateOperationId,
            candidateExecutorId,
            requestedAmountPoints: requestNeedsReload ? args.amountPoints : 0,
          },
        );

        if (
          claim.status === "operation" &&
          !claim.claimed &&
          requestNeedsReload
        ) {
          for (const delayMs of [250, 500, 1_000, 2_000]) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            claim = await ctx.runMutation(
              internal.teamExtraUsage.claimTeamAutoReloadOperation,
              {
                organizationId: args.organizationId,
                candidateOperationId,
                candidateExecutorId,
                requestedAmountPoints: args.amountPoints,
              },
            );
            if (claim.status !== "operation" || claim.claimed) break;
          }
        }

        if (claim.status === "not_needed" && requestNeedsReload) {
          deductResult = await ctx.runMutation(
            api.teamExtraUsage.deductTeamPoints,
            {
              serviceKey: args.serviceKey,
              organizationId: args.organizationId,
              userId: args.userId,
              amountPoints: args.amountPoints,
              usageSettlementId: args.usageSettlementId,
            },
          );
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
          const completeOperation = (
            outcome:
              | "success"
              | "released"
              | "executor_released"
              | "definitive_failure",
            failureReason?: string,
          ) =>
            ctx.runMutation(
              internal.teamExtraUsage.completeTeamAutoReloadOperation,
              {
                organizationId: args.organizationId,
                operationId,
                executorId,
                outcome,
                failureReason,
              },
            );
          const releasePreCharge = () =>
            completeOperation(
              operationId === candidateOperationId && !claim.stripeInvoiceId
                ? "released"
                : "executor_released",
            );
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
              api.teamExtraUsage.addTeamCredits,
              {
                serviceKey: args.serviceKey,
                organizationId: args.organizationId,
                amountDollars,
                idempotencyKey: `team_auto_reload:${operationId}`,
                revenueSource: "team_extra_usage_auto_reload",
                stripeCustomerId,
                stripePaymentIntentId: paymentIntentId,
                stripeInvoiceId: invoiceId,
              },
            );
            const completed = await completeOperation("success");
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
                  internal.teamExtraUsage.recordTeamAutoReloadOutcome,
                  { organizationId: args.organizationId, success: true },
                );
              } catch {
                // The charge, credit, and operation completion already succeeded.
                // Health telemetry is best-effort and must not change that result.
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
                  const released = await completeOperation("released");
                  retryAutoReload =
                    requestNeedsReload && released && reloadAttempt === 0;
                } else {
                  await completeOperation("executor_released");
                }
                shouldPreparePayment = false;
              }
            } catch (error) {
              const invoiceMissing = isMissingStripeResource(error);
              autoReloadResult = {
                success: false,
                reason: invoiceMissing
                  ? "invoice_missing"
                  : "payment_state_unknown",
              };
              if (invoiceMissing) {
                const released = await completeOperation("released");
                retryAutoReload =
                  requestNeedsReload && released && reloadAttempt === 0;
              } else {
                await completeOperation("executor_released");
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
            const released = await completeOperation("released");
            retryAutoReload =
              requestNeedsReload && released && reloadAttempt === 0;
            shouldPreparePayment = false;
          }

          if (shouldPreparePayment) {
            let paymentStarted = false;
            try {
              const stripeCustomerId = await getOrgStripeCustomerId(
                args.organizationId,
              );
              if (!stripeCustomerId) {
                autoReloadResult = {
                  success: false,
                  reason: "no_stripe_customer",
                };
                await releasePreCharge();
              } else {
                const customerObj =
                  await getStripe().customers.retrieve(stripeCustomerId);
                const isBlocked =
                  !customerObj.deleted &&
                  (customerObj as Stripe.Customer).metadata?.blocked === "true";
                const paymentMethodId = isBlocked
                  ? null
                  : await getDefaultPaymentMethodId(stripeCustomerId);
                if (isBlocked || !paymentMethodId) {
                  autoReloadResult = {
                    success: false,
                    reason: isBlocked
                      ? "customer_blocked"
                      : "no_default_payment_method",
                  };
                  await releasePreCharge();
                } else {
                  paymentStarted = true;
                  const paymentResult = await createAutoReloadInvoice(
                    stripeCustomerId,
                    paymentMethodId,
                    Math.round(amountDollars * 100),
                    args.organizationId,
                    operationId,
                    claim.stripeInvoiceId,
                    async (stripeInvoiceId) => {
                      const recorded = await ctx.runMutation(
                        internal.teamExtraUsage.recordTeamAutoReloadInvoice,
                        {
                          organizationId: args.organizationId,
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
                        ? "missing_invoice"
                        : "payment_failed");
                    autoReloadResult = { success: false, reason };
                    if (paymentResult.failureKind === "definitive") {
                      const completed = await completeOperation(
                        "definitive_failure",
                        reason,
                      );
                      if (completed) {
                        try {
                          await ctx.runMutation(
                            internal.teamExtraUsage.recordTeamAutoReloadOutcome,
                            {
                              organizationId: args.organizationId,
                              success: false,
                              failureReason: reason,
                            },
                          );
                        } catch {
                          // Best-effort health telemetry after a completed op.
                        }
                      }
                    } else if (paymentResult.failureKind === "released") {
                      await releasePreCharge();
                    } else {
                      await completeOperation("executor_released");
                    }
                  }
                }
              }
            } catch {
              autoReloadResult = {
                success: false,
                reason: paymentStarted
                  ? "payment_state_unknown"
                  : "stripe_lookup_failed",
              };
              if (paymentStarted) {
                await completeOperation("executor_released");
              } else {
                await releasePreCharge();
              }
            }
          }

          if (requestNeedsReload && autoReloadResult?.success) {
            deductResult = await ctx.runMutation(
              api.teamExtraUsage.deductTeamPoints,
              {
                serviceKey: args.serviceKey,
                organizationId: args.organizationId,
                userId: args.userId,
                amountPoints: args.amountPoints,
                usageSettlementId: args.usageSettlementId,
              },
            );
            retryAutoReload =
              reloadAttempt === 0 &&
              !deductResult.success &&
              deductResult.insufficientFunds &&
              !deductResult.monthlyCapExceeded &&
              !deductResult.memberCapExceeded &&
              !deductResult.memberDisabled &&
              !deductResult.poolDisabled;
          }
        }
        if (retryAutoReload) {
          autoReloadResult = undefined;
          continue;
        }
        break;
      }
    }

    convexLogger.info("team_deduct_with_auto_reload", {
      organization_id: args.organizationId,
      user_id: args.userId,
      amount_points: args.amountPoints,
      usage_settlement_id: args.usageSettlementId,
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
