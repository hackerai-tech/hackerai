import { v } from "convex/values";
import { mutation } from "./lib/serviceFunctions";
import { validateServiceKey } from "./lib/utils";

const args = {
  serviceKey: v.string(),
  stripeCustomerId: v.string(),
  token: v.string(),
};

/**
 * Fence the whole read/modify/write journey, including its initial Stripe read.
 * Only preflight owners expire. Once a Stripe write may have started, elapsed
 * time cannot prove it stopped; that owner must finish or be reconciled by an
 * operator before another command can run.
 */
export const begin = mutation({
  args: { ...args, operation: v.union(v.literal("cancel"), v.literal("keep")) },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    validateServiceKey(input.serviceKey);
    const existing = await ctx.db
      .query("billing_operations")
      .withIndex("by_stripe_customer_id", (q) =>
        q.eq("stripe_customer_id", input.stripeCustomerId),
      )
      .unique();
    if (existing) {
      if (existing.writing || existing.expires_at > Date.now()) return false;
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("billing_operations", {
      stripe_customer_id: input.stripeCustomerId,
      token: input.token,
      operation: input.operation,
      writing: false,
      created_at: Date.now(),
      expires_at: Date.now() + 120_000,
    });
    return true;
  },
});

/** Atomically revoke preflight expiry before any external mutation starts. */
export const startWrite = mutation({
  args,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    validateServiceKey(input.serviceKey);
    const owner = await ctx.db
      .query("billing_operations")
      .withIndex("by_stripe_customer_id", (q) =>
        q.eq("stripe_customer_id", input.stripeCustomerId),
      )
      .unique();
    if (
      !owner ||
      owner.token !== input.token ||
      (!owner.writing && owner.expires_at <= Date.now())
    )
      return false;
    await ctx.db.patch(owner._id, { writing: true });
    return true;
  },
});

/** Release only this owner; a stale preflight request cannot release its successor. */
export const finish = mutation({
  args,
  returns: v.null(),
  handler: async (ctx, input) => {
    validateServiceKey(input.serviceKey);
    const owner = await ctx.db
      .query("billing_operations")
      .withIndex("by_stripe_customer_id", (q) =>
        q.eq("stripe_customer_id", input.stripeCustomerId),
      )
      .unique();
    if (owner?.token === input.token) await ctx.db.delete(owner._id);
    return null;
  },
});
