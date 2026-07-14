import { stripe } from "../stripe";
import { workos } from "../workos";
import { getUserID } from "@/lib/auth/get-user-id";
import { after, NextRequest, NextResponse } from "next/server";
import { SubscriptionTier } from "@/types/chat";
import { getSuspensionMessage } from "@/lib/suspensionMessage";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  createCheckoutAttemptId,
  normalizeCheckoutAttemptId,
  normalizePaidFunnelLabel,
  paidFunnelProperties,
  planLookupKeyToTier,
} from "@/lib/analytics/paid-funnel";

const MAX_TEAM_SEATS = 999;

function canManageOrganizationBilling(
  membership: Awaited<
    ReturnType<typeof workos.userManagement.listOrganizationMemberships>
  >["data"][number],
) {
  return membership.role?.slug === "admin" || membership.role?.slug === "owner";
}

function resolveQuantity(
  targetPlan: string,
  requestedQuantity: unknown,
): { valid: true; value: number } | { valid: false; error: string } {
  if (!targetPlan.includes("team")) {
    return { valid: true, value: 1 };
  }

  if (requestedQuantity === undefined) {
    return { valid: true, value: 2 };
  }

  if (
    typeof requestedQuantity !== "number" ||
    !Number.isFinite(requestedQuantity) ||
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity < 2
  ) {
    return {
      valid: false,
      error: "Quantity must be a finite integer of at least 2",
    };
  }

  if (requestedQuantity > MAX_TEAM_SEATS) {
    return {
      valid: false,
      error: `Maximum ${MAX_TEAM_SEATS} seats allowed`,
    };
  }

  return { valid: true, value: requestedQuantity };
}

export const POST = async (req: NextRequest) => {
  try {
    const body = await req.json().catch(() => ({}));
    const requestedPlan = body?.plan;
    const confirm: boolean = body?.confirm === true;
    const requestedQuantity: unknown = body?.quantity;
    const checkoutAttemptId =
      normalizeCheckoutAttemptId(body?.checkoutAttemptId) ??
      createCheckoutAttemptId();
    const checkoutSource = normalizePaidFunnelLabel(body?.source);
    const checkoutSurface = normalizePaidFunnelLabel(body?.surface);
    const checkoutReason = normalizePaidFunnelLabel(body?.reason);
    const checkoutLimitType = normalizePaidFunnelLabel(
      body?.limitType ?? body?.limit_type,
    );
    const posthogSessionId = req.headers?.get("x-posthog-session-id");

    const allowedPlans = new Set([
      "pro-monthly-plan",
      "pro-plus-monthly-plan",
      "ultra-monthly-plan",
      "pro-yearly-plan",
      "pro-plus-yearly-plan",
      "ultra-yearly-plan",
      "team-monthly-plan",
      "team-yearly-plan",
    ]);
    const targetPlan =
      typeof requestedPlan === "string" && allowedPlans.has(requestedPlan)
        ? requestedPlan
        : "pro-monthly-plan";

    const userId = await getUserID(req);
    const user = await workos.userManagement.getUser(userId);

    // Get user's organization
    const existingMemberships =
      await workos.userManagement.listOrganizationMemberships({
        userId,
      });

    if (!existingMemberships.data || existingMemberships.data.length === 0) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      );
    }

    const membership = existingMemberships.data[0];
    if (!canManageOrganizationBilling(membership)) {
      return NextResponse.json(
        { error: "Only organization admins or owners can manage billing" },
        { status: 403 },
      );
    }

    const organization = await workos.organizations.getOrganization(
      membership.organizationId,
    );

    // Find Stripe customer
    const customers = await stripe.customers.list({
      email: user.email,
      limit: 10,
    });

    const matchingCustomer = customers.data.find(
      (c) => c.metadata.workOSOrganizationId === organization.id,
    );

    if (!matchingCustomer) {
      return NextResponse.json(
        { error: "No Stripe customer found" },
        { status: 404 },
      );
    }

    // Reject blocked customers (flagged by fraud webhook)
    if (matchingCustomer.metadata.blocked === "true") {
      return NextResponse.json(
        {
          error: getSuspensionMessage(matchingCustomer.metadata.blocked_reason),
        },
        { status: 403 },
      );
    }

    // Get target price
    const targetPrices = await stripe.prices.list({
      lookup_keys: [targetPlan],
    });

    if (!targetPrices.data || targetPrices.data.length === 0) {
      return NextResponse.json(
        { error: "Target plan price not found" },
        { status: 404 },
      );
    }

    const targetPrice = targetPrices.data[0];
    const targetAmount = targetPrice.unit_amount
      ? targetPrice.unit_amount / 100
      : 0;

    const quantityResult = resolveQuantity(targetPlan, requestedQuantity);
    if (!quantityResult.valid) {
      return NextResponse.json(
        { error: quantityResult.error },
        { status: 400 },
      );
    }
    const quantity = quantityResult.value;

    // Get active subscription for prorated calculation
    const subscriptions = await stripe.subscriptions.list({
      customer: matchingCustomer.id,
      status: "active",
      limit: 1,
    });

    let proratedCredit = 0;
    let currentAmount = 0;
    let totalDue = targetAmount * quantity;
    let additionalCredit = 0; // credit left over to be added to customer balance
    let paymentMethodInfo = "";
    let planType: SubscriptionTier = "free";
    let currentPeriodStart: number | null = null; // unix seconds
    let currentPeriodEnd: number | null = null; // unix seconds
    let nextInvoiceAmountEstimate = targetAmount * quantity; // will be adjusted below
    let proratedAmount = targetAmount * quantity; // actual prorated charge for remaining time

    if (subscriptions.data.length > 0) {
      const subscription = subscriptions.data[0];
      const currentPrice = subscription.items.data[0]?.price;

      // cycle dates (unchanged when switching plan)
      currentPeriodStart = (subscription as any).current_period_start ?? null;
      currentPeriodEnd = (subscription as any).current_period_end ?? null;

      currentAmount = currentPrice?.unit_amount
        ? currentPrice.unit_amount / 100
        : 0;

      // Determine plan type and interval (same logic as GET)
      const productId = currentPrice?.product;
      if (productId && typeof productId === "string") {
        try {
          const product = await stripe.products.retrieve(productId);
          const productName = product.name?.toLowerCase() || "";
          const productMetadata = product.metadata || {};
          if (productName.includes("ultra") || productMetadata.plan === "ultra")
            planType = "ultra";
          else if (
            productName.includes("team") ||
            productMetadata.plan === "team"
          )
            planType = "team";
          else if (
            productName.includes("pro-plus") ||
            productMetadata.plan === "pro-plus"
          )
            planType = "pro-plus";
          else if (
            productName.includes("pro") ||
            productMetadata.plan === "pro"
          )
            planType = "pro";
        } catch {}
      }

      // Load payment method like in GET
      const defaultPaymentMethod = subscription.default_payment_method as any;
      try {
        if (defaultPaymentMethod) {
          let pm: any = defaultPaymentMethod;
          if (typeof defaultPaymentMethod === "string") {
            pm = await stripe.paymentMethods.retrieve(defaultPaymentMethod);
          }
          if (pm?.type === "card" && pm.card) {
            const brand = (pm.card.brand || "").toUpperCase();
            const last4 = pm.card.last4 || "";
            paymentMethodInfo = `${brand} *${last4}`;
          }
        }
      } catch {}

      try {
        // Use Stripe's Create Preview Invoice API via the SDK to get EXACT prorated amounts
        const previewInvoice = await stripe.invoices.createPreview({
          customer: matchingCustomer.id,
          subscription: subscription.id,
          subscription_details: {
            items: [
              {
                id: subscription.items.data[0].id,
                price: targetPrice.id,
                quantity: quantity,
              },
            ],
            proration_behavior: "always_invoice",
            proration_date: Math.floor(Date.now() / 1000),
          },
        });

        // Use Stripe's exact amount_due for precision
        totalDue = Math.max(0, (previewInvoice.amount_due || 0) / 100);

        // Extract actual proration amounts from Stripe's line items
        let proratedCharge = 0;
        let creditFromOldPlan = 0;

        for (const line of previewInvoice.lines.data) {
          if (line.amount < 0) {
            // Negative = credit from old subscription
            creditFromOldPlan += Math.abs(line.amount) / 100;
          } else if (line.amount > 0) {
            // Positive = prorated charge for new subscription
            proratedCharge += line.amount / 100;
          }
        }

        // Use the actual credit amount from Stripe (not calculated)
        proratedCredit = creditFromOldPlan;
        proratedAmount = proratedCharge; // actual charge for remaining time

        additionalCredit = 0; // Will add to balance if credit > charge
        if (creditFromOldPlan > proratedCharge) {
          additionalCredit = creditFromOldPlan - proratedCharge;
        }

        // Next invoice will be the full target amount times quantity (no proration on renewal)
        nextInvoiceAmountEstimate = targetAmount * quantity;
      } catch (invoiceError) {
        console.error(
          "Error fetching invoice preview, using fallback calculation:",
          invoiceError,
        );

        // Fallback: Manual calculation based on remaining time
        const fallbackPeriodEnd = (subscription as any)
          .current_period_end as number;
        const fallbackPeriodStart = (subscription as any)
          .current_period_start as number;
        const nowInSeconds = Math.floor(Date.now() / 1000);
        const totalPeriodDuration = fallbackPeriodEnd - fallbackPeriodStart;
        const remainingTime = fallbackPeriodEnd - nowInSeconds;
        const proratedRatio = remainingTime / totalPeriodDuration;

        // Credit is the unused portion of the current subscription
        const estimatedCredit = Math.max(0, currentAmount * proratedRatio);
        const targetTotal = targetAmount * quantity;
        totalDue = Math.max(0, targetTotal - estimatedCredit);

        // Calculate actual proration credit from what they pay (keeps display consistent)
        proratedCredit = Math.max(0, targetTotal - totalDue);

        additionalCredit = 0; // Fallback doesn't calculate excess credit
        nextInvoiceAmountEstimate = targetAmount * quantity;
      }

      // If confirm flag is true, actually update the subscription
      if (confirm) {
        try {
          phLogger.event(
            PAID_FUNNEL_EVENTS.checkoutStarted,
            paidFunnelProperties({
              userId,
              org_id: organization.id,
              checkout_attempt_id: checkoutAttemptId,
              checkout_type: "subscription_change",
              from_tier: planType,
              to_tier: planLookupKeyToTier(targetPlan),
              plan: targetPlan,
              billing_interval: targetPrice.recurring?.interval,
              billing_interval_count: targetPrice.recurring?.interval_count,
              quantity,
              surface: checkoutSurface,
              source: checkoutSource,
              reason: checkoutReason,
              limit_type: checkoutLimitType,
              checkout_amount_dollars: totalDue,
              currency: targetPrice.currency,
              stripe_customer_id: matchingCustomer.id,
              stripe_subscription_id: subscription.id,
              stripe_price_id: targetPrice.id,
              $session_id: posthogSessionId ?? undefined,
              $insert_id: `${PAID_FUNNEL_EVENTS.checkoutStarted}:${checkoutAttemptId}`,
              $set: {
                last_checkout_started_at: new Date().toISOString(),
              },
            }),
          );
          after(() => phLogger.flush());

          const updatedSubscription = await stripe.subscriptions.update(
            subscription.id,
            {
              items: [
                {
                  id: subscription.items.data[0].id,
                  price: targetPrice.id,
                  quantity: quantity,
                },
              ],
              proration_behavior: "always_invoice",
              proration_date: Math.floor(Date.now() / 1000),
              payment_behavior: "pending_if_incomplete",
              metadata: {
                ...subscription.metadata,
                checkoutAttemptId,
                ...(checkoutSource && { checkoutSource }),
                ...(checkoutSurface && { checkoutSurface }),
                ...(checkoutReason && { checkoutReason }),
                ...(checkoutLimitType && { checkoutLimitType }),
                checkoutType: "subscription_change",
              },
            },
          );

          // Get the latest invoice to check payment status
          const latestInvoiceId =
            typeof updatedSubscription.latest_invoice === "string"
              ? updatedSubscription.latest_invoice
              : updatedSubscription.latest_invoice?.id;

          if (latestInvoiceId) {
            let invoice = await stripe.invoices.retrieve(latestInvoiceId, {
              expand: ["payment_intent"],
            });

            // If invoice is still being processed, finalize it
            if (invoice.status === "draft") {
              invoice = await stripe.invoices.finalizeInvoice(latestInvoiceId, {
                expand: ["payment_intent"],
              });
            }

            // Check if invoice needs payment or user action
            if (invoice.status !== "paid") {
              // Check if payment requires additional action (e.g., 3D Secure)
              const paymentIntent =
                typeof (invoice as any).payment_intent === "object"
                  ? (invoice as any).payment_intent
                  : null;
              if (paymentIntent && paymentIntent.status === "requires_action") {
                return NextResponse.json({
                  success: false,
                  requiresPayment: true,
                  invoiceUrl: invoice.hosted_invoice_url,
                  message:
                    "Payment requires additional authentication. Please complete the verification to activate your new plan.",
                });
              }

              // For any other non-paid status
              return NextResponse.json({
                success: false,
                requiresPayment: true,
                invoiceUrl: invoice.hosted_invoice_url,
                message:
                  "Payment requires attention. Please complete payment to activate your new plan.",
              });
            }
          }

          phLogger.event(
            PAID_FUNNEL_EVENTS.checkoutSucceeded,
            paidFunnelProperties({
              userId,
              org_id: organization.id,
              checkout_attempt_id: checkoutAttemptId,
              checkout_type: "subscription_change",
              from_tier: planType,
              to_tier: planLookupKeyToTier(targetPlan),
              plan: targetPlan,
              billing_interval: targetPrice.recurring?.interval,
              billing_interval_count: targetPrice.recurring?.interval_count,
              quantity,
              surface: checkoutSurface,
              source: checkoutSource,
              reason: checkoutReason,
              limit_type: checkoutLimitType,
              checkout_amount_dollars: totalDue,
              currency: targetPrice.currency,
              stripe_customer_id: matchingCustomer.id,
              stripe_subscription_id: updatedSubscription.id,
              stripe_price_id: targetPrice.id,
              $insert_id: `${PAID_FUNNEL_EVENTS.checkoutSucceeded}:${checkoutAttemptId}`,
              $set: {
                subscription_tier: planLookupKeyToTier(targetPlan),
                last_checkout_succeeded_at: new Date().toISOString(),
              },
            }),
          );

          return NextResponse.json({
            success: true,
            message: "Subscription updated successfully",
            subscriptionId: updatedSubscription.id,
          });
        } catch (updateError) {
          console.error("Error updating subscription:", {
            error: updateError,
            userId,
            subscriptionId: subscription.id,
            targetPlan,
            customerId: matchingCustomer.id,
            timestamp: new Date().toISOString(),
          });

          // Handle specific Stripe errors with user-friendly messages
          if (updateError instanceof Error) {
            const errorMessage = updateError.message;

            // No payment method attached
            if (
              errorMessage.includes("no attached payment source") ||
              errorMessage.includes("default payment method")
            ) {
              console.error(
                "Subscription upgrade failed - no payment method:",
                {
                  userId,
                  customerId: matchingCustomer.id,
                  targetPlan,
                  errorMessage,
                },
              );
              return NextResponse.json(
                {
                  error:
                    "No payment method found. Please add a payment method to your account before upgrading.",
                  requiresPaymentMethod: true,
                },
                { status: 400 },
              );
            }

            // Card declined
            if (
              errorMessage.includes("card was declined") ||
              errorMessage.includes("insufficient funds")
            ) {
              console.error("Subscription upgrade failed - payment declined:", {
                userId,
                customerId: matchingCustomer.id,
                targetPlan,
                errorMessage,
              });
              return NextResponse.json(
                {
                  error:
                    "Your payment method was declined. Please update your payment method and try again.",
                },
                { status: 400 },
              );
            }

            // Generic Stripe error
            console.error("Subscription upgrade failed - Stripe error:", {
              userId,
              customerId: matchingCustomer.id,
              targetPlan,
              errorMessage,
            });
            return NextResponse.json(
              {
                error: errorMessage,
              },
              { status: 500 },
            );
          }

          console.error("Subscription upgrade failed - unknown error:", {
            userId,
            customerId: matchingCustomer.id,
            targetPlan,
            error: updateError,
          });
          return NextResponse.json(
            {
              error: "Failed to update subscription. Please try again.",
            },
            { status: 500 },
          );
        }
      }
    }

    // Return preview details if not confirming
    // Keep full precision (Stripe provides amounts in cents, converted to dollars)
    return NextResponse.json({
      proratedAmount: Number(proratedAmount.toFixed(2)),
      proratedCredit: Number(proratedCredit.toFixed(2)),
      totalDue: Number(totalDue.toFixed(2)),
      additionalCredit: Number(additionalCredit.toFixed(2)),
      paymentMethod: paymentMethodInfo,
      currentPlan: planType,
      quantity: quantity,
      // Cycle information (dates are unix seconds)
      currentPeriodStart,
      currentPeriodEnd,
      nextInvoiceDate: currentPeriodEnd,
      nextInvoiceAmount: Number(nextInvoiceAmountEstimate.toFixed(2)),
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Error calculating upgrade preview:", errorMessage, error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
