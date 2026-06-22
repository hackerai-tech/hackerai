import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const DELETION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export const upsertSeen = mutation({
  args: {
    serviceKey: v.string(),
    identityHash: v.string(),
    userId: v.string(),
    nowMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = args.nowMs ?? Date.now();
    const existing = await ctx.db
      .query("account_identities")
      .withIndex("by_identity_hash", (q) =>
        q.eq("identity_hash", args.identityHash),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        last_seen_at: now,
        latest_user_id: args.userId,
      });
      return null;
    }

    await ctx.db.insert("account_identities", {
      identity_hash: args.identityHash,
      first_seen_at: now,
      last_seen_at: now,
      latest_user_id: args.userId,
    });

    return null;
  },
});

export const markDeleted = mutation({
  args: {
    serviceKey: v.string(),
    identityHash: v.string(),
    userId: v.string(),
    nowMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = args.nowMs ?? Date.now();
    const existing = await ctx.db
      .query("account_identities")
      .withIndex("by_identity_hash", (q) =>
        q.eq("identity_hash", args.identityHash),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        last_seen_at: now,
        latest_user_id: args.userId,
        deleted_at: now,
      });
      return null;
    }

    await ctx.db.insert("account_identities", {
      identity_hash: args.identityHash,
      first_seen_at: now,
      last_seen_at: now,
      latest_user_id: args.userId,
      deleted_at: now,
    });

    return null;
  },
});

export const getReferralCooldown = query({
  args: {
    serviceKey: v.string(),
    identityHash: v.string(),
    nowMs: v.optional(v.number()),
  },
  returns: v.object({
    inCooldown: v.boolean(),
    deletedAt: v.optional(v.number()),
    cooldownEndsAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const identity = await ctx.db
      .query("account_identities")
      .withIndex("by_identity_hash", (q) =>
        q.eq("identity_hash", args.identityHash),
      )
      .unique();

    const deletedAt = identity?.deleted_at;
    if (deletedAt == null) return { inCooldown: false };

    const cooldownEndsAt = deletedAt + DELETION_COOLDOWN_MS;
    return {
      inCooldown: (args.nowMs ?? Date.now()) < cooldownEndsAt,
      deletedAt,
      cooldownEndsAt,
    };
  },
});
