import { v } from "convex/values";

export const partnerFields = {
  code: v.string(),
  name: v.string(),
  contact_email: v.string(),
  owner_identity: v.string(),
  active: v.boolean(),
  monthly_bps: v.number(),
  annual_bps: v.number(),
  created_at: v.number(),
  link_opens: v.optional(v.number()),
  sponsorship_cost_cents: v.optional(v.number()),
  sponsorship_cost_revision: v.optional(v.number()),
};
export const attributionFields = {
  partner_id: v.id("influencer_partners"),
  identity: v.string(),
  analytics_visitor_id: v.optional(v.string()),
  analytics_checkout_at: v.optional(v.number()),
  clicked_at: v.number(),
  created_at: v.number(),
  monthly_bps: v.number(),
  annual_bps: v.number(),
  customer_id: v.optional(v.string()),
  subscription_id: v.optional(v.string()),
};
export const invoiceFields = {
  partner_id: v.id("influencer_partners"),
  attribution_id: v.id("influencer_attributions"),
  invoice_id: v.string(),
  customer_id: v.string(),
  subscription_id: v.string(),
  currency: v.string(),
  interval: v.string(),
  paid_at: v.number(),
  eligible_at: v.number(),
  gross_cents: v.number(),
  net_cents: v.number(),
  rate_bps: v.number(),
  earned_cents: v.number(),
  paid_cents: v.number(),
  review_reason: v.optional(v.string()),
  synced_at: v.number(),
  analytics_revision: v.optional(v.number()),
  payout_id: v.optional(v.id("influencer_payouts")),
};
export const payoutFields = {
  partner_id: v.id("influencer_partners"),
  key: v.string(),
  currency: v.string(),
  amount_cents: v.number(),
  created_at: v.number(),
  status: v.union(
    v.literal("reserved"),
    v.literal("paid"),
    v.literal("canceled"),
  ),
  items: v.array(
    v.object({ invoice_id: v.id("influencer_invoices"), cents: v.number() }),
  ),
  paid_at: v.optional(v.number()),
  reference: v.optional(v.string()),
};

export const partnerDoc = v.object({
  ...partnerFields,
  _id: v.id("influencer_partners"),
  _creationTime: v.number(),
});
export const attributionDoc = v.object({
  ...attributionFields,
  _id: v.id("influencer_attributions"),
  _creationTime: v.number(),
});
export const invoiceDoc = v.object({
  ...invoiceFields,
  _id: v.id("influencer_invoices"),
  _creationTime: v.number(),
});
export const payoutDoc = v.object({
  ...payoutFields,
  _id: v.id("influencer_payouts"),
  _creationTime: v.number(),
});
