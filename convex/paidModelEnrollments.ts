import { ConvexError, v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import { isUserDeletionFenced } from "./lib/userDeletionFence";
import {
  paidModelEnrollmentFields,
  paidModelEnrollmentDocument,
} from "./paidModelEnrollmentValidators";

/** Service-only frozen enrollment for the paid first-step v1 experiment. */
export const get = query({
  args: { serviceKey: v.string(), user_id: v.string() },
  returns: v.union(paidModelEnrollmentDocument, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.user_id)) return null;
    return ctx.db
      .query("paid_model_enrollments")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .unique();
  },
});

/** First concurrent enrollment wins; neither variant nor renewal date is overwritten. */
export const enroll = mutation({
  args: { serviceKey: v.string(), ...paidModelEnrollmentFields },
  returns: v.union(paidModelEnrollmentDocument, v.null()),
  handler: async (ctx, { serviceKey, ...args }) => {
    validateServiceKey(serviceKey);
    if (await isUserDeletionFenced(ctx.db, args.user_id)) return null;
    const existing = await ctx.db
      .query("paid_model_enrollments")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .unique();
    if (existing) return existing;
    if (
      !Number.isFinite(args.enrolled_at) ||
      !Number.isFinite(args.baseline_renewal_at) ||
      args.baseline_renewal_at <= args.enrolled_at
    ) {
      throw new ConvexError("A future baseline renewal date is required");
    }
    const id = await ctx.db.insert("paid_model_enrollments", args);
    return ctx.db.get(id);
  },
});
