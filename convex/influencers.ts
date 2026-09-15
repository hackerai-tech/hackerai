import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import {
  attributionDoc,
  invoiceDoc,
  partnerDoc,
  payoutDoc,
} from "./influencerValidators";
import {
  commissionCents,
  DEFAULT_ANNUAL_BPS,
  DEFAULT_MONTHLY_BPS,
  PAYOUT_HOLD_MS,
  validPartnerCode,
} from "../lib/influencers/policy";

const auth = { serviceKey: v.string() };

export const recordLinkOpen = mutation({
  args: { ...auth, code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const partner = await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (partner?.active)
      await ctx.db.patch(partner._id, {
        link_opens: (partner.link_opens ?? 0) + 1,
      });
    return null;
  },
});

export const createPartner = mutation({
  args: {
    ...auth,
    code: v.string(),
    name: v.string(),
    contactEmail: v.string(),
    ownerIdentity: v.string(),
    monthlyBps: v.optional(v.number()),
    annualBps: v.optional(v.number()),
  },
  returns: v.id("influencer_partners"),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const monthly = args.monthlyBps ?? DEFAULT_MONTHLY_BPS;
    const annual = args.annualBps ?? DEFAULT_ANNUAL_BPS;
    commissionCents(0, monthly);
    commissionCents(0, annual);
    if (
      !validPartnerCode(args.code) ||
      !args.name.trim() ||
      args.name.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.contactEmail) ||
      args.contactEmail.length > 254 ||
      !args.ownerIdentity.startsWith("free_quota:v1:")
    )
      throw new Error("Invalid partner details");
    const existing = await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (existing) throw new Error("Partner code already exists");
    return await ctx.db.insert("influencer_partners", {
      code: args.code,
      name: args.name.trim(),
      contact_email: args.contactEmail,
      owner_identity: args.ownerIdentity,
      active: true,
      monthly_bps: monthly,
      annual_bps: annual,
      created_at: Date.now(),
    });
  },
});

export const setActive = mutation({
  args: { ...auth, code: v.string(), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const partner = await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!partner) throw new Error("Partner not found");
    await ctx.db.patch(partner._id, { active: args.active });
    return null;
  },
});

export const getPartner = query({
  args: { ...auth, code: v.string() },
  returns: v.union(partnerDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
  },
});

export const attribute = mutation({
  args: {
    ...auth,
    code: v.string(),
    identity: v.string(),
    userId: v.string(),
    userCreatedAt: v.number(),
    clickedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const existing = await ctx.db
      .query("influencer_attributions")
      .withIndex("by_identity", (q) => q.eq("identity", args.identity))
      .unique();
    if (existing) return true;
    const now = Date.now();
    // Only accounts created after the click, attributed within seven days of signup.
    if (
      !args.identity.startsWith("free_quota:v1:") ||
      !Number.isFinite(args.userCreatedAt) ||
      !Number.isFinite(args.clickedAt) ||
      args.clickedAt > args.userCreatedAt ||
      args.userCreatedAt > now ||
      now - args.userCreatedAt > 7 * 86400_000 ||
      now - args.clickedAt >= PAYOUT_HOLD_MS
    )
      return false;
    const knownIdentity = await ctx.db
      .query("account_identities")
      .withIndex("by_identity_hash", (q) =>
        q.eq("identity_hash", args.identity),
      )
      .unique();
    if (
      knownIdentity &&
      (knownIdentity.deleted_at !== undefined ||
        knownIdentity.latest_user_id !== args.userId)
    )
      return false;
    const partner = await ctx.db
      .query("influencer_partners")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!partner?.active || partner.owner_identity === args.identity)
      return false;
    // Attribution is exclusive across the cash and usage-credit programs.
    const creditReferral = await ctx.db
      .query("referral_attributions")
      .withIndex("by_referred_user_id", (q) =>
        q.eq("referred_user_id", args.userId),
      )
      .first();
    const creditIdentity = await ctx.db
      .query("referral_attributions")
      .withIndex("by_referred_identity_hash", (q) =>
        q.eq("referred_identity_hash", args.identity),
      )
      .first();
    if (creditReferral || creditIdentity) return false;
    await ctx.db.insert("influencer_attributions", {
      partner_id: partner._id,
      identity: args.identity,
      clicked_at: args.clickedAt,
      created_at: now,
      monthly_bps: partner.monthly_bps,
      annual_bps: partner.annual_bps,
    });
    return true;
  },
});

export const getAttribution = query({
  args: { ...auth, identity: v.string() },
  returns: v.union(attributionDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await ctx.db
      .query("influencer_attributions")
      .withIndex("by_identity", (q) => q.eq("identity", args.identity))
      .unique();
  },
});

export const bindCustomer = mutation({
  args: { ...auth, identity: v.string(), customerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const attribution = await ctx.db
      .query("influencer_attributions")
      .withIndex("by_identity", (q) => q.eq("identity", args.identity))
      .unique();
    if (!attribution) return null;
    const existing = await ctx.db
      .query("influencer_attributions")
      .withIndex("by_customer_id", (q) => q.eq("customer_id", args.customerId))
      .unique();
    if (
      (existing && existing._id !== attribution._id) ||
      (attribution.customer_id && attribution.customer_id !== args.customerId)
    )
      throw new Error("Referral customer is already bound");
    await ctx.db.patch(attribution._id, { customer_id: args.customerId });
    return null;
  },
});

export const getCustomerAttribution = query({
  args: { ...auth, customerId: v.string() },
  returns: v.union(attributionDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await ctx.db
      .query("influencer_attributions")
      .withIndex("by_customer_id", (q) => q.eq("customer_id", args.customerId))
      .unique();
  },
});

export const syncInvoice = mutation({
  args: {
    ...auth,
    invoiceId: v.string(),
    customerId: v.string(),
    subscriptionId: v.string(),
    currency: v.string(),
    interval: v.string(),
    paidAt: v.number(),
    grossCents: v.number(),
    netCents: v.number(),
    eligible: v.boolean(),
    reviewReason: v.optional(v.string()),
    observedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const attribution = await ctx.db
      .query("influencer_attributions")
      .withIndex("by_customer_id", (q) => q.eq("customer_id", args.customerId))
      .unique();
    if (!attribution) return null;
    if (
      attribution.subscription_id &&
      attribution.subscription_id !== args.subscriptionId
    )
      return null;
    if (args.paidAt < Math.floor(attribution.created_at / 1000) * 1000)
      return null;
    commissionCents(args.grossCents, 0);
    commissionCents(args.netCents, 0);
    if (
      args.netCents > args.grossCents ||
      !Number.isSafeInteger(args.paidAt) ||
      args.paidAt > Date.now()
    )
      throw new Error("Invalid invoice amounts or date");
    const existing = await ctx.db
      .query("influencer_invoices")
      .withIndex("by_invoice_id", (q) => q.eq("invoice_id", args.invoiceId))
      .unique();
    if (existing && existing.synced_at > args.observedAt) return null;
    if (!attribution.subscription_id)
      await ctx.db.patch(attribution._id, {
        subscription_id: args.subscriptionId,
      });
    const rate =
      args.interval === "month"
        ? attribution.monthly_bps
        : attribution.annual_bps;
    const values = {
      partner_id: attribution.partner_id,
      attribution_id: attribution._id,
      invoice_id: args.invoiceId,
      customer_id: args.customerId,
      subscription_id: args.subscriptionId,
      currency: args.currency,
      interval: args.interval,
      paid_at: args.paidAt,
      eligible_at: args.paidAt + PAYOUT_HOLD_MS,
      gross_cents: args.grossCents,
      net_cents: args.netCents,
      rate_bps: rate,
      earned_cents:
        args.eligible && !args.reviewReason
          ? commissionCents(args.netCents, rate)
          : 0,
      review_reason: args.reviewReason,
      synced_at: args.observedAt,
    };
    if (existing) await ctx.db.patch(existing._id, values);
    else
      await ctx.db.insert("influencer_invoices", { ...values, paid_cents: 0 });
    return null;
  },
});

export const listAttributions = query({
  args: {
    ...auth,
    partnerId: v.id("influencer_partners"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(attributionDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const { page, isDone, continueCursor } = await ctx.db
      .query("influencer_attributions")
      .withIndex("by_partner_id", (q) => q.eq("partner_id", args.partnerId))
      .paginate(args.paginationOpts);
    return { page, isDone, continueCursor };
  },
});

export const listInvoices = query({
  args: {
    ...auth,
    partnerId: v.id("influencer_partners"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(invoiceDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const { page, isDone, continueCursor } = await ctx.db
      .query("influencer_invoices")
      .withIndex("by_partner_id", (q) => q.eq("partner_id", args.partnerId))
      .paginate(args.paginationOpts);
    return { page, isDone, continueCursor };
  },
});

export const reservePayout = mutation({
  args: { ...auth, partnerId: v.id("influencer_partners"), key: v.string() },
  returns: payoutDoc,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(args.key))
      throw new Error("Use a unique payout key of 8–80 characters");
    const previous = await ctx.db
      .query("influencer_payouts")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (previous) {
      if (previous.partner_id !== args.partnerId)
        throw new Error("Payout key belongs to another partner");
      return previous;
    }
    const reserved = await ctx.db
      .query("influencer_payouts")
      .withIndex("by_partner_id_and_status", (q) =>
        q.eq("partner_id", args.partnerId).eq("status", "reserved"),
      )
      .first();
    if (reserved)
      throw new Error("Finish or cancel the existing reserved payout first");
    // Fail closed rather than omit old clawbacks from a partial financial scan.
    const rows = await ctx.db
      .query("influencer_invoices")
      .withIndex("by_partner_id", (q) => q.eq("partner_id", args.partnerId))
      .take(1001);
    if (rows.length > 1000)
      throw new Error(
        "Partner exceeds pilot payout capacity; reconciliation required",
      );
    const now = Date.now();
    if (rows.some((row) => now - row.synced_at > 5 * 60_000))
      throw new Error(
        "Reconcile all partner invoices with Stripe before payout",
      );
    if (rows.some((row) => row.review_reason))
      throw new Error("Resolve invoices requiring review before payout");
    const items = rows
      .filter(
        (row) =>
          !row.payout_id &&
          row.currency === "usd" &&
          (row.eligible_at <= now || row.earned_cents < row.paid_cents) &&
          row.earned_cents !== row.paid_cents,
      )
      .map((row) => ({
        invoice_id: row._id,
        cents: row.earned_cents - row.paid_cents,
      }));
    const total = items.reduce((sum, row) => sum + row.cents, 0);
    if (total <= 0) throw new Error("No positive balance eligible for payout");
    const id = await ctx.db.insert("influencer_payouts", {
      partner_id: args.partnerId,
      key: args.key,
      currency: "usd",
      amount_cents: total,
      status: "reserved",
      created_at: now,
      items,
    });
    for (const row of items)
      await ctx.db.patch(row.invoice_id, { payout_id: id });
    return (await ctx.db.get(id))!;
  },
});

export const finishPayout = mutation({
  args: {
    ...auth,
    key: v.string(),
    action: v.union(v.literal("paid"), v.literal("cancel")),
    reference: v.optional(v.string()),
  },
  returns: payoutDoc,
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const payout = await ctx.db
      .query("influencer_payouts")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!payout) throw new Error("Payout not found");
    const status = args.action === "paid" ? "paid" : "canceled";
    if (payout.status !== "reserved") {
      if (
        payout.status !== status ||
        (status === "paid" && payout.reference !== args.reference)
      )
        throw new Error("Payout already finalized differently");
      return payout;
    }
    if (
      status === "paid" &&
      (!args.reference?.trim() || args.reference.length > 200)
    )
      throw new Error("External payment reference is required");
    for (const item of payout.items) {
      const invoice = await ctx.db.get(item.invoice_id);
      if (!invoice || invoice.payout_id !== payout._id)
        throw new Error("Payout reservation mismatch");
      await ctx.db.patch(invoice._id, {
        payout_id: undefined,
        paid_cents: invoice.paid_cents + (status === "paid" ? item.cents : 0),
      });
    }
    // Record the actual transfer even if a later refund changed earned_cents.
    // The difference remains a negative balance deducted from the next payout.
    await ctx.db.patch(payout._id, {
      status,
      ...(status === "paid"
        ? { reference: args.reference!.trim(), paid_at: Date.now() }
        : {}),
    });
    return (await ctx.db.get(payout._id))!;
  },
});

export const getPayout = query({
  args: { ...auth, key: v.string() },
  returns: v.union(payoutDoc, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return await ctx.db
      .query("influencer_payouts")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
  },
});
