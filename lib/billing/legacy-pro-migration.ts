import type Stripe from "stripe";
import { z } from "zod";
import { HACKERAI_PRO_20_MONTHLY_PRICE_ID } from "./included-usage";

export const LEGACY_PRO_MIGRATION = "legacy-pro-20-to-29-v1";
const DAY = 86400;
const timestamp = z.number().int().positive().max(4102444800);
export const legacyProManifestSchema = z
  .object({
    accountId: z.string().regex(/^acct_[a-zA-Z0-9]+$/),
    livemode: z.boolean(),
    sourcePriceId: z.string().startsWith("price_"),
    targetPriceId: z.string().startsWith("price_"),
    entries: z
      .array(
        z
          .object({
            subscriptionId: z.string().regex(/^sub_[a-zA-Z0-9]+$/),
            notifiedAt: timestamp,
            effectiveAt: timestamp,
            noticeReceipt: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      new Set(manifest.entries.map((e) => e.subscriptionId)).size !==
      manifest.entries.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate subscription" });
    }
    if (
      manifest.livemode &&
      manifest.sourcePriceId !== HACKERAI_PRO_20_MONTHLY_PRICE_ID
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Live source must be the HackerAI legacy Pro price",
      });
    }
  });
export type LegacyProManifest = z.infer<typeof legacyProManifestSchema>;
type Entry = LegacyProManifest["entries"][number];

/** Only static, content-free validation messages may use this error type. */
export class LegacyProMigrationValidationError extends Error {}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new LegacyProMigrationValidationError(message);
}
function objectId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

/** Refuse a different product, interval, amount or environment before enrollment. */
export function validateMigrationPrices(
  manifest: LegacyProManifest,
  source: Stripe.Price,
  target: Stripe.Price,
) {
  for (const [price, amount, id] of [
    [source, 2000, manifest.sourcePriceId],
    [target, 2900, manifest.targetPriceId],
  ] as const) {
    requireCondition(
      price.id === id &&
        price.livemode === manifest.livemode &&
        price.currency === "usd" &&
        price.unit_amount === amount &&
        price.type === "recurring" &&
        price.recurring?.interval === "month" &&
        price.recurring.interval_count === 1 &&
        price.recurring.usage_type === "licensed" &&
        price.billing_scheme === "per_unit" &&
        !price.transform_quantity,
      "Unexpected price identity or billing configuration",
    );
  }
  requireCondition(
    target.active &&
      objectId(source.product) === objectId(target.product) &&
      source.tax_behavior === target.tax_behavior &&
      target.lookup_key === "pro-monthly-plan-29-experiment",
    "Target must be the active $29 Pro price with matching product and tax treatment",
  );
}

/** Stripe monthly anchors clamp to month end, then return to the original anchor day. */
export function isMonthlyRenewal(
  subscription: Stripe.Subscription,
  effectiveAt: number,
): boolean {
  const end = subscription.items.data[0]?.current_period_end;
  if (!end || effectiveAt < end) return false;
  if (effectiveAt === end) return true;
  const anchor = new Date(subscription.billing_cycle_anchor * 1000);
  const endDate = new Date(end * 1000);
  for (let offset = 1; offset <= 3; offset++) {
    const date = new Date(
      Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth() + offset,
        1,
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
      ),
    );
    const lastDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
    if (date.getTime() / 1000 === effectiveAt) return true;
  }
  return false;
}

/** Enforce notice timing and reject subscriptions whose existing commitments may be lost. */
export function validateMigrationSubscription(
  manifest: LegacyProManifest,
  entry: Entry,
  subscription: Stripe.Subscription,
  now: number,
) {
  const item = subscription.items.data[0];
  requireCondition(
    subscription.id === entry.subscriptionId &&
      subscription.livemode === manifest.livemode &&
      subscription.status === "active",
    "Subscription identity, mode or status changed",
  );
  requireCondition(
    !subscription.items.has_more &&
      subscription.items.data.length === 1 &&
      item.quantity === 1 &&
      item.price.id === manifest.sourcePriceId,
    "Requires one seat on the reviewed $20 price",
  );
  requireCondition(
    !subscription.schedule &&
      !subscription.cancel_at &&
      !subscription.cancel_at_period_end &&
      !subscription.pause_collection &&
      !subscription.pending_update &&
      !subscription.pending_invoice_item_interval &&
      !subscription.trial_end &&
      !subscription.billing_cycle_anchor_config,
    "Existing schedule, cancellation, pause, trial or pending change",
  );
  requireCondition(
    !subscription.discounts.length &&
      !item.discounts.length &&
      !subscription.default_tax_rates?.length &&
      !item.tax_rates?.length &&
      !subscription.automatic_tax.enabled &&
      !subscription.billing_thresholds &&
      !item.billing_thresholds &&
      !subscription.transfer_data &&
      !subscription.application_fee_percent &&
      !subscription.on_behalf_of &&
      subscription.collection_method === "charge_automatically",
    "Nonstandard discount, tax, collection or billing configuration requires manual review",
  );
  requireCondition(
    !Object.keys(subscription.metadata).some((key) =>
      /^hackeraiPause/.test(key),
    ),
    "Pause metadata requires manual review",
  );
  requireCondition(
    !subscription.metadata.legacyProMigration,
    "Already enrolled; reconcile rather than replay",
  );
  requireCondition(
    entry.notifiedAt <= now &&
      entry.effectiveAt >= now + 2 * DAY &&
      entry.effectiveAt - entry.notifiedAt >= 30 * DAY &&
      isMonthlyRenewal(subscription, entry.effectiveAt),
    "Requires delivered notice >=30 days before a future monthly renewal within three cycles",
  );
}

/** Customer-level credits and discounts need individual review, never implicit removal. */
export function validateMigrationCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
) {
  requireCondition(!customer.deleted, "Customer deleted");
  requireCondition(
    !customer.discount &&
      customer.balance === 0 &&
      !Object.values(customer.invoice_credit_balance ?? {}).some(
        (value) => value !== 0,
      ),
    "Customer discount or balance requires manual review",
  );
}

/** Operator must persist an exclusive attempt receipt BEFORE calling. Never retry uncertain writes. */
export async function applyLegacyProMigration(
  stripe: Stripe,
  manifest: LegacyProManifest,
  entry: Entry,
  now: number,
) {
  const subscription = await stripe.subscriptions.retrieve(
    entry.subscriptionId,
  );
  validateMigrationSubscription(manifest, entry, subscription, now);
  const customerId = objectId(subscription.customer);
  requireCondition(customerId, "Missing customer");
  validateMigrationCustomer(await stripe.customers.retrieve(customerId));
  const key = `${LEGACY_PRO_MIGRATION}:${entry.subscriptionId}`;
  const created = await stripe.subscriptionSchedules.create(
    { from_subscription: subscription.id },
    { idempotencyKey: `${key}:create` },
  );
  // Do not release on errors: an update timeout may already have committed.
  // The durable attempt receipt is the reconciliation boundary for either call.
  const phase = created.phases[0];
  requireCondition(
    created.status === "active" &&
      created.phases.length === 1 &&
      phase &&
      phase.start_date === subscription.items.data[0].current_period_start &&
      phase.end_date === subscription.items.data[0].current_period_end &&
      phase.items.length === 1 &&
      objectId(phase.items[0].price) === manifest.sourcePriceId &&
      phase.items[0].quantity === 1 &&
      !phase.discounts?.length &&
      !phase.default_tax_rates?.length &&
      !phase.add_invoice_items?.length,
    "Created schedule differs from reviewed subscription; reconcile attached schedule",
  );
  const metadata = {
    legacyProMigration: LEGACY_PRO_MIGRATION,
    legacyProNotifiedAt: String(entry.notifiedAt),
    legacyProEffectiveAt: String(entry.effectiveAt),
  };
  await stripe.subscriptionSchedules.update(
    created.id,
    {
      end_behavior: "release",
      proration_behavior: "none",
      metadata,
      phases: [
        {
          start_date: phase.start_date,
          end_date: entry.effectiveAt,
          items: [{ price: manifest.sourcePriceId, quantity: 1 }],
          proration_behavior: "none",
          metadata,
        },
        {
          items: [{ price: manifest.targetPriceId, quantity: 1 }],
          duration: { interval: "month", interval_count: 1 },
          proration_behavior: "none",
          metadata: { ...metadata, checkoutSource: LEGACY_PRO_MIGRATION },
        },
      ],
    },
    { idempotencyKey: `${key}:configure` },
  );
  const readback = await stripe.subscriptionSchedules.retrieve(created.id);
  requireCondition(
    readback.status === "active" &&
      readback.end_behavior === "release" &&
      readback.phases.length === 2 &&
      readback.phases[0].end_date === entry.effectiveAt &&
      objectId(readback.phases[0].items[0]?.price ?? null) ===
        manifest.sourcePriceId &&
      readback.phases[1].start_date === entry.effectiveAt &&
      objectId(readback.phases[1].items[0]?.price ?? null) ===
        manifest.targetPriceId &&
      readback.phases.every((p) => p.proration_behavior === "none"),
    "Schedule read-back mismatch; stop and reconcile",
  );
  const current = await stripe.subscriptions.retrieve(subscription.id);
  requireCondition(
    current.items.data[0]?.price.id === manifest.sourcePriceId &&
      current.items.data[0]?.current_period_end ===
        subscription.items.data[0].current_period_end &&
      !current.cancel_at &&
      !current.cancel_at_period_end,
    "Subscription changed during scheduling; reconcile before continuing",
  );
  return {
    subscriptionId: subscription.id,
    scheduleId: created.id,
    effectiveAt: entry.effectiveAt,
  };
}
