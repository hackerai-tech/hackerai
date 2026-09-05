import type Stripe from "stripe";

import { stripe } from "@/app/api/stripe";
import { addUtcMonths } from "@/lib/billing/retention-offers";
import { isTerminalStripeResourceError } from "@/lib/billing/stripe-terminal-errors";
import { stripeObjectId } from "@/lib/billing/subscription-payment-failure";
import { phLogger } from "@/lib/posthog/server";

/**
 * Stripe Subscription Schedules are used for one thing here: applying a
 * retention downgrade at the end of the paid period. While a schedule is
 * attached, Stripe rejects direct item changes on the subscription, so every
 * other plan mutation (cancel, pause, keep, upgrade) releases it first.
 */

export function subscriptionScheduleId(
  subscription: Pick<Stripe.Subscription, "schedule">,
): string | undefined {
  return stripeObjectId(subscription.schedule ?? undefined) ?? undefined;
}

/**
 * Release a pending schedule so the subscription can be changed directly.
 * Returns true when a schedule was released. A schedule that no longer exists
 * or is already released counts as nothing to do.
 */
export async function releaseSubscriptionSchedule(
  scheduleId: string | undefined,
  context: Record<string, unknown> = {},
): Promise<boolean> {
  if (!scheduleId) return false;

  try {
    await stripe.subscriptionSchedules.release(scheduleId);
    phLogger.info("subscription_schedule_released", {
      event: "subscription_schedule_released",
      stripe_subscription_schedule_id: scheduleId,
      ...context,
    });
    return true;
  } catch (error) {
    if (isTerminalStripeResourceError(error)) return false;
    const message = error instanceof Error ? error.message : String(error);
    // Stripe reports a schedule that already ended or was released as an
    // invalid request rather than a missing resource.
    if (/status of `?(released|canceled|completed)`?/i.test(message)) {
      return false;
    }
    throw error;
  }
}

function phaseItemsParams(
  phase: Stripe.SubscriptionSchedule.Phase,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] {
  return phase.items.flatMap((item) => {
    const price = stripeObjectId(item.price);
    if (!price) return [];
    return [
      {
        price,
        ...(typeof item.quantity === "number" && { quantity: item.quantity }),
      },
    ];
  });
}

function phaseDiscountParams(
  phase: Stripe.SubscriptionSchedule.Phase,
): Stripe.SubscriptionScheduleUpdateParams.Phase.Discount[] | undefined {
  const discounts = phase.discounts?.flatMap((discount) => {
    const coupon = stripeObjectId(discount.coupon);
    return coupon ? [{ coupon }] : [];
  });
  return discounts && discounts.length > 0 ? discounts : undefined;
}

export type ScheduledPlanChange = {
  scheduleId: string;
  /** When the new price takes effect (ms). */
  effectiveAtMs: number;
};

/**
 * Keep the current items until the paid-through date, then switch to the
 * target price for one billing period and release the schedule so the
 * subscription keeps renewing on the new price with no schedule attached.
 */
export async function scheduleDowngradeAtPeriodEnd(args: {
  subscription: Stripe.Subscription;
  targetPriceId: string;
  /** Applied to the subscription when the new phase starts. */
  phaseMetadata: Stripe.MetadataParam;
  scheduleMetadata: Stripe.MetadataParam;
  /** Stable per acceptance attempt so a network retry cannot attach a second schedule. */
  idempotencyKey: string;
}): Promise<ScheduledPlanChange> {
  await releaseSubscriptionSchedule(subscriptionScheduleId(args.subscription), {
    stripe_subscription_id: args.subscription.id,
    reason: "replaced_by_retention_downgrade",
  });

  const created = await stripe.subscriptionSchedules.create(
    { from_subscription: args.subscription.id },
    { idempotencyKey: args.idempotencyKey },
  );

  // Creating from a subscription attaches the schedule immediately; only the
  // update below turns it into a downgrade. If that fails, release the bare
  // schedule so the subscription is left exactly as it was and the offer can
  // be accepted again.
  let updated: Stripe.SubscriptionSchedule;
  try {
    updated = await configureDowngradePhases(created, args);
  } catch (error) {
    await releaseSubscriptionSchedule(created.id, {
      stripe_subscription_id: args.subscription.id,
      reason: "retention_downgrade_rollback",
    }).catch((releaseError) => {
      phLogger.error("subscription_schedule_rollback_failed", {
        stripe_subscription_id: args.subscription.id,
        stripe_subscription_schedule_id: created.id,
        error: releaseError,
      });
    });
    throw error;
  }

  const nextPhase = updated.phases[1];
  return {
    scheduleId: updated.id,
    effectiveAtMs:
      (nextPhase?.start_date ?? created.phases[0]?.end_date ?? 0) * 1000,
  };
}

async function configureDowngradePhases(
  created: Stripe.SubscriptionSchedule,
  args: {
    targetPriceId: string;
    phaseMetadata: Stripe.MetadataParam;
    scheduleMetadata: Stripe.MetadataParam;
  },
): Promise<Stripe.SubscriptionSchedule> {
  const currentPhase = created.phases[0];
  if (!currentPhase) {
    throw new Error("Stripe schedule was created without a current phase");
  }

  return stripe.subscriptionSchedules.update(created.id, {
    end_behavior: "release",
    metadata: args.scheduleMetadata,
    phases: [
      {
        items: phaseItemsParams(currentPhase),
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date,
        proration_behavior: "none",
        ...(phaseDiscountParams(currentPhase) && {
          discounts: phaseDiscountParams(currentPhase),
        }),
      },
      {
        items: [{ price: args.targetPriceId, quantity: 1 }],
        // One period on the new price, then release: the subscription keeps
        // renewing on it with no schedule attached.
        end_date: Math.floor(
          addUtcMonths(currentPhase.end_date * 1000, 1) / 1000,
        ),
        proration_behavior: "none",
        metadata: args.phaseMetadata,
      },
    ],
  });
}

export type PendingPlanChange = {
  targetPriceId: string;
  effectiveAtMs: number;
  /** Missing when the price lookup failed; the change is still pending. */
  price?: Stripe.Price;
};

/**
 * The price a pending schedule switches to after the current phase, if any.
 * Stripe caps expansion at four levels, so the schedule is expanded on the
 * subscription and the phase price is fetched on its own.
 */
export async function resolvePendingPlanChange(
  schedule: Stripe.SubscriptionSchedule | string | null | undefined,
  currentPriceId: string | undefined,
): Promise<PendingPlanChange | undefined> {
  if (!schedule || typeof schedule === "string") return undefined;
  if (schedule.status !== "active") return undefined;

  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const phase of schedule.phases) {
    if (phase.start_date <= nowSeconds) continue;
    const targetPriceId = stripeObjectId(phase.items[0]?.price);
    if (!targetPriceId || targetPriceId === currentPriceId) continue;
    const effectiveAtMs = phase.start_date * 1000;
    try {
      const price = await stripe.prices.retrieve(targetPriceId);
      return { targetPriceId, effectiveAtMs, price };
    } catch (error) {
      phLogger.warn("subscription_schedule_price_lookup_failed", {
        stripe_subscription_schedule_id: schedule.id,
        stripe_price_id: targetPriceId,
        error,
      });
      return { targetPriceId, effectiveAtMs };
    }
  }
  return undefined;
}
