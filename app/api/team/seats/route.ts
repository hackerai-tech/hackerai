import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { workos } from "../../workos";
import { stripe } from "../../stripe";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";

const MAX_SEATS = 999;

type WorkOSOrganization = Awaited<
  ReturnType<typeof workos.organizations.getOrganization>
>;

interface SeatOperationError {
  error: { message: string; status: number };
}

interface SeatOperationSuccess {
  userId: string;
  organizationId: string;
  organization: WorkOSOrganization;
  activeSubscription: Stripe.Subscription;
  subscriptionItem: Stripe.SubscriptionItem;
  currentMembers: number;
  pendingInvites: number;
  totalUsed: number;
  paymentMethodInfo: string;
}

type SeatOperationContext = SeatOperationError | SeatOperationSuccess;

// Helper to get common data (user, org, subscription) for seat operations
async function getSeatOperationContext(
  req: NextRequest,
): Promise<SeatOperationContext> {
  const { userId, subscription } = await getUserIDAndPro(req);

  if (subscription !== "team") {
    return { error: { message: "Team subscription required", status: 403 } };
  }

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    statuses: ["active"],
  });

  if (!memberships.data || memberships.data.length === 0) {
    return { error: { message: "No organization found", status: 404 } };
  }

  const organizationId = memberships.data[0].organizationId;
  const userMembership = memberships.data.find((m) => m.userId === userId);

  if (userMembership?.role?.slug !== "admin") {
    return { error: { message: "Only admins can update seats", status: 403 } };
  }

  const organization =
    await workos.organizations.getOrganization(organizationId);

  if (!organization.stripeCustomerId) {
    return { error: { message: "No Stripe customer found", status: 404 } };
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: organization.stripeCustomerId,
    status: "active",
    limit: 1,
  });

  if (subscriptions.data.length === 0) {
    return { error: { message: "No active subscription found", status: 404 } };
  }

  const activeSubscription = subscriptions.data[0];
  const subscriptionItem = activeSubscription.items.data[0];

  if (!subscriptionItem) {
    return { error: { message: "No subscription item found", status: 404 } };
  }

  // Get current members and pending invitations
  const [allMembers, pendingInvitations] = await Promise.all([
    workos.userManagement.listOrganizationMemberships({
      organizationId,
      statuses: ["active"],
    }),
    workos.userManagement.listInvitations({
      organizationId,
    }),
  ]);

  const currentMembers = allMembers.data.length;
  const pendingInvites = pendingInvitations.data.filter(
    (inv) => inv.state === "pending",
  ).length;
  const totalUsed = currentMembers + pendingInvites;

  // Get payment method info
  let paymentMethodInfo = "";
  const defaultPaymentMethod = activeSubscription.default_payment_method;
  try {
    if (defaultPaymentMethod) {
      let pm: Stripe.PaymentMethod | null = null;
      if (typeof defaultPaymentMethod === "string") {
        pm = await stripe.paymentMethods.retrieve(defaultPaymentMethod);
      } else {
        pm = defaultPaymentMethod;
      }
      if (pm?.type === "card" && pm.card) {
        const brand = (pm.card.brand || "").toUpperCase();
        const last4 = pm.card.last4 || "";
        paymentMethodInfo = `${brand} *${last4}`;
      }
    }
  } catch {}

  return {
    userId,
    organizationId,
    organization,
    activeSubscription,
    subscriptionItem,
    currentMembers,
    pendingInvites,
    totalUsed,
    paymentMethodInfo,
  };
}

// POST: Preview seat change (increase or decrease)
export const POST = async (req: NextRequest) => {
  try {
    const context = await getSeatOperationContext(req);

    if ("error" in context) {
      return NextResponse.json(
        { error: context.error.message },
        { status: context.error.status },
      );
    }

    const {
      activeSubscription,
      subscriptionItem,
      totalUsed,
      paymentMethodInfo,
      organization,
    } = context;

    const body = await req.json();
    const { quantity } = body;

    // Validate quantity
    if (
      !quantity ||
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      !Number.isInteger(quantity) ||
      quantity < 2
    ) {
      return NextResponse.json(
        { error: "Quantity must be a finite integer of at least 2" },
        { status: 400 },
      );
    }

    if (quantity > MAX_SEATS) {
      return NextResponse.json(
        { error: `Maximum ${MAX_SEATS} seats allowed` },
        { status: 400 },
      );
    }

    const currentQuantity = subscriptionItem.quantity || 1;
    const isIncrease = quantity > currentQuantity;
    const isDecrease = quantity < currentQuantity;

    // Validate decrease constraints
    if (isDecrease && quantity < totalUsed) {
      return NextResponse.json(
        {
          error: "Cannot reduce seats below current usage",
          details: `You have ${totalUsed} seats in use. Remove members or revoke invites before reducing seats.`,
        },
        { status: 400 },
      );
    }

    // Get price info - this is the per-seat price for the billing period
    const priceId = subscriptionItem.price.id;
    const price = await stripe.prices.retrieve(priceId);
    const pricePerSeatFullPeriod = price.unit_amount
      ? price.unit_amount / 100
      : 0;

    // Calculate monthly equivalent for display
    const isYearly = price.recurring?.interval === "year";
    const pricePerSeatMonthly = isYearly
      ? pricePerSeatFullPeriod / 12
      : pricePerSeatFullPeriod;

    // Use Stripe's invoice preview for accurate proration
    // Always use "always_invoice" for preview to get accurate line items
    const previewInvoice = await stripe.invoices.createPreview({
      customer: organization.stripeCustomerId!,
      subscription: activeSubscription.id,
      subscription_details: {
        items: [
          {
            id: subscriptionItem.id,
            quantity: quantity,
          },
        ],
        proration_behavior: "always_invoice",
        proration_date: Math.floor(Date.now() / 1000),
      },
    });

    // Stripe invoice total: positive = charge, negative = credit
    // amount_due: what customer pays (0 when credit, positive when charge)
    let proratedCharge = 0;
    let proratedCredit = 0;

    if (isIncrease) {
      // For increases: customer pays amount_due
      proratedCharge = Math.max(0, (previewInvoice.amount_due || 0) / 100);
    } else {
      // For decreases: total is negative, representing credit to customer
      // Use Math.abs of total to get the credit amount
      const invoiceTotal = previewInvoice.total || 0;
      proratedCredit = invoiceTotal < 0 ? Math.abs(invoiceTotal) / 100 : 0;
    }

    const totalDue = isIncrease ? proratedCharge : 0;
    const seatsDelta = Math.abs(quantity - currentQuantity);

    // Calculate per-seat prorated amount for display
    const proratedPerSeat = isIncrease
      ? seatsDelta > 0
        ? proratedCharge / seatsDelta
        : 0
      : seatsDelta > 0
        ? proratedCredit / seatsDelta
        : 0;

    // Stripe's flexible billing mode doesn't expose current_period_end directly
    // Calculate next billing date from billing_cycle_anchor and plan interval
    type SubscriptionWithBillingAnchor = Stripe.Subscription & {
      billing_cycle_anchor?: number;
      current_period_end?: number;
    };
    const sub = activeSubscription as SubscriptionWithBillingAnchor;

    let currentPeriodEnd: number | undefined = sub.current_period_end;
    if (!currentPeriodEnd && sub.billing_cycle_anchor) {
      // Calculate next billing date based on interval
      const anchor = new Date(sub.billing_cycle_anchor * 1000);
      const now = new Date();

      // Find the next billing date after now
      while (anchor <= now) {
        if (isYearly) {
          anchor.setFullYear(anchor.getFullYear() + 1);
        } else {
          anchor.setMonth(anchor.getMonth() + 1);
        }
      }
      currentPeriodEnd = Math.floor(anchor.getTime() / 1000);
    }
    const nextInvoiceAmount = pricePerSeatFullPeriod * quantity;

    return NextResponse.json({
      currentQuantity,
      newQuantity: quantity,
      seatsDelta: quantity - currentQuantity,
      proratedCharge: Number(proratedCharge.toFixed(2)),
      proratedCredit: Number(proratedCredit.toFixed(2)),
      totalDue: Number(totalDue.toFixed(2)),
      pricePerSeat: Number(pricePerSeatMonthly.toFixed(2)),
      proratedPerSeat: Number(proratedPerSeat.toFixed(2)),
      paymentMethod: paymentMethodInfo,
      currentPeriodEnd,
      nextInvoiceAmount: Number(nextInvoiceAmount.toFixed(2)),
      isIncrease,
      isYearly,
      totalUsed,
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to preview seat change:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};

// PATCH: Execute seat change (increase or decrease)
export const PATCH = async (req: NextRequest) => {
  try {
    const context = await getSeatOperationContext(req);

    if ("error" in context) {
      return NextResponse.json(
        { error: context.error.message },
        { status: context.error.status },
      );
    }

    const {
      activeSubscription,
      subscriptionItem,
      totalUsed,
      currentMembers,
      pendingInvites,
    } = context;

    const body = await req.json();
    const { quantity } = body;

    // Validate quantity
    if (
      !quantity ||
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      !Number.isInteger(quantity) ||
      quantity < 2
    ) {
      return NextResponse.json(
        { error: "Quantity must be a finite integer of at least 2" },
        { status: 400 },
      );
    }

    if (quantity > MAX_SEATS) {
      return NextResponse.json(
        { error: `Maximum ${MAX_SEATS} seats allowed` },
        { status: 400 },
      );
    }

    const currentQuantity = subscriptionItem.quantity || 1;
    const isIncrease = quantity > currentQuantity;
    const isDecrease = quantity < currentQuantity;

    // No change requested
    if (quantity === currentQuantity) {
      return NextResponse.json(
        { error: "Quantity is the same as current seats" },
        { status: 400 },
      );
    }

    // Validate decrease constraints
    if (isDecrease) {
      if (totalUsed === currentQuantity) {
        return NextResponse.json(
          {
            error: "Cannot remove seats while all seats are in use",
            details: "Please remove a member or revoke an invitation first.",
          },
          { status: 400 },
        );
      }

      if (quantity < totalUsed) {
        return NextResponse.json(
          {
            error: "Cannot reduce seats below current usage",
            details: `You have ${currentMembers} members and ${pendingInvites} pending invites (${totalUsed} total). Remove members or revoke invites before reducing seats.`,
          },
          { status: 400 },
        );
      }
    }

    if (isIncrease) {
      // Seat INCREASE: Charge immediately with proration
      try {
        const updatedSubscription = await stripe.subscriptions.update(
          activeSubscription.id,
          {
            items: [
              {
                id: subscriptionItem.id,
                quantity: quantity,
              },
            ],
            proration_behavior: "always_invoice",
            proration_date: Math.floor(Date.now() / 1000),
            payment_behavior: "pending_if_incomplete",
          },
        );

        // Check payment status on the latest invoice
        const latestInvoiceId =
          typeof updatedSubscription.latest_invoice === "string"
            ? updatedSubscription.latest_invoice
            : updatedSubscription.latest_invoice?.id;

        if (latestInvoiceId) {
          let invoice = await stripe.invoices.retrieve(latestInvoiceId, {
            expand: ["payment_intent"],
          });

          // Finalize draft invoice if needed
          if (invoice.status === "draft") {
            invoice = await stripe.invoices.finalizeInvoice(latestInvoiceId, {
              expand: ["payment_intent"],
            });
          }

          // Check if payment needs action (3D Secure, etc.)
          // Note: payment_intent is expanded above but Stripe types don't reflect expansion
          type InvoiceWithPaymentIntent = Stripe.Invoice & {
            payment_intent?: Stripe.PaymentIntent | string | null;
          };
          if (invoice.status !== "paid") {
            const expandedInvoice = invoice as InvoiceWithPaymentIntent;
            const paymentIntent =
              typeof expandedInvoice.payment_intent === "object"
                ? expandedInvoice.payment_intent
                : null;

            if (paymentIntent && paymentIntent.status === "requires_action") {
              return NextResponse.json({
                success: false,
                requiresPayment: true,
                invoiceUrl: invoice.hosted_invoice_url,
                message:
                  "Payment requires additional authentication. Please complete the verification.",
              });
            }

            // Payment failed or pending
            return NextResponse.json({
              success: false,
              requiresPayment: true,
              invoiceUrl: invoice.hosted_invoice_url,
              message: "Payment requires attention. Please complete payment.",
            });
          }
        }

        return NextResponse.json({
          success: true,
          message: `Successfully added ${quantity - currentQuantity} seat${quantity - currentQuantity > 1 ? "s" : ""}. Your new total is ${quantity} seats.`,
          newQuantity: quantity,
        });
      } catch (updateError) {
        console.error("Error updating subscription for seat increase:", {
          error: updateError,
          subscriptionId: activeSubscription.id,
          requestedQuantity: quantity,
        });

        if (updateError instanceof Error) {
          const errorMessage = updateError.message;

          if (
            errorMessage.includes("no attached payment source") ||
            errorMessage.includes("default payment method")
          ) {
            return NextResponse.json(
              {
                error:
                  "No payment method found. Please add a payment method before adding seats.",
                requiresPaymentMethod: true,
              },
              { status: 400 },
            );
          }

          if (
            errorMessage.includes("card was declined") ||
            errorMessage.includes("insufficient funds")
          ) {
            return NextResponse.json(
              {
                error:
                  "Your payment method was declined. Please update your payment method and try again.",
              },
              { status: 400 },
            );
          }

          return NextResponse.json({ error: errorMessage }, { status: 500 });
        }

        return NextResponse.json(
          { error: "Failed to add seats. Please try again." },
          { status: 500 },
        );
      }
    } else {
      // Seat DECREASE: Issue prorated credit
      await stripe.subscriptions.update(activeSubscription.id, {
        items: [
          {
            id: subscriptionItem.id,
            quantity: quantity,
          },
        ],
        proration_behavior: "create_prorations",
        proration_date: Math.floor(Date.now() / 1000),
      });

      return NextResponse.json({
        success: true,
        message: `Seats reduced to ${quantity}. A prorated credit has been applied to your account.`,
        newQuantity: quantity,
      });
    }
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An error occurred";
    console.error("Failed to update seats:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
};
