import { isUserDeletionFenced } from "./lib/userDeletionFence";
import { internalMutation, query } from "./lib/serviceFunctions";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import {
  assertSettlementIdentity,
  validateSettlementIdentity,
} from "./lib/settlementReceipts";
import {
  settlementIdentityFields,
  walletActionResult,
  walletDebitResult,
} from "./lib/settlementReceiptValidators";

// No lease or automatic takeover: an interrupted financial action remains fenced.
export const begin = internalMutation({
  args: settlementIdentityFields,
  returns: v.object({
    claimed: v.boolean(),
    result: v.union(walletActionResult, v.null()),
  }),
  handler: async (ctx, args) => {
    validateSettlementIdentity(args);
    const existing = await ctx.db
      .query("usage_settlement_operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operation_id", args.operation_id),
      )
      .unique();
    if (existing) {
      assertSettlementIdentity(existing, args);
      return { claimed: false, result: existing.result ?? null };
    }
    if (await isUserDeletionFenced(ctx.db, args.user_id))
      throw new Error("User deletion is in progress");
    await ctx.db.insert("usage_settlement_operations", {
      ...args,
      status: "pending",
      created_at: Date.now(),
    });
    return { claimed: true, result: null };
  },
});

export const finish = internalMutation({
  args: { ...settlementIdentityFields, result: walletActionResult },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("usage_settlement_operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operation_id", args.operation_id),
      )
      .unique();
    if (!existing) throw new Error("Settlement operation is missing");
    assertSettlementIdentity(existing, args);
    // Only the first executor can finish. Never overwrite a historical outcome.
    if (existing.status === "completed")
      throw new Error("Settlement operation already completed");
    const teamResult = args.result.memberDisabled !== undefined;
    if (teamResult !== (args.organization_id !== undefined))
      throw new Error("Settlement result scope mismatch");
    await ctx.db.patch(existing._id, {
      status: "completed",
      result: args.result,
      completed_at: Date.now(),
    });
    return null;
  },
});

/** Link the existing reload fence before any external Stripe execution. */
export const linkAutoReload = internalMutation({
  args: { ...settlementIdentityFields, auto_reload_operation_id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db
      .query("usage_settlement_operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operation_id", args.operation_id),
      )
      .unique();
    if (!operation) throw new Error("Settlement operation is missing");
    assertSettlementIdentity(operation, args);
    if (operation.status !== "pending")
      throw new Error("Settlement operation already completed");
    if (await isUserDeletionFenced(ctx.db, args.user_id))
      throw new Error("User deletion is in progress");
    const ids = operation.auto_reload_operation_ids ?? [];
    if (!ids.includes(args.auto_reload_operation_id)) {
      if (ids.length >= 2) throw new Error("Settlement reload limit exceeded");
      await ctx.db.patch(operation._id, {
        auto_reload_operation_ids: [...ids, args.auto_reload_operation_id],
      });
    }
    return null;
  },
});

/** Service-only, bounded read. A missing receipt never means safe to replay. */
export const getForBackend = query({
  args: {
    serviceKey: v.string(),
    operation_id: v.string(),
    user_id: v.string(),
    organization_id: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      ...settlementIdentityFields,
      status: v.union(v.literal("pending"), v.literal("completed")),
      created_at: v.number(),
      completed_at: v.optional(v.number()),
      result: v.optional(walletActionResult),
      auto_reload_operation_ids: v.optional(v.array(v.string())),
      debits: v.array(
        v.object({
          sequence: v.number(),
          outcome: v.union(v.literal("applied"), v.literal("not_applied")),
          previous_balance_points: v.union(v.number(), v.null()),
          new_balance_points: v.union(v.number(), v.null()),
          created_at: v.number(),
          result: walletDebitResult,
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const operation = await ctx.db
      .query("usage_settlement_operations")
      .withIndex("by_operation_id", (q) =>
        q.eq("operation_id", args.operation_id),
      )
      .unique();
    if (!operation) return null;
    if (
      operation.user_id !== args.user_id ||
      operation.organization_id !== args.organization_id
    ) {
      throw new Error("Settlement operation scope mismatch");
    }
    const debits = await ctx.db
      .query("usage_settlement_debits")
      .withIndex("by_operation_id_and_sequence", (q) =>
        q.eq("operation_id", args.operation_id),
      )
      .take(8);
    return {
      operation_id: operation.operation_id,
      user_id: operation.user_id,
      ...(operation.organization_id && {
        organization_id: operation.organization_id,
      }),
      ...(operation.usage_settlement_id && {
        usage_settlement_id: operation.usage_settlement_id,
      }),
      amount_points: operation.amount_points,
      status: operation.status,
      created_at: operation.created_at,
      ...(operation.completed_at !== undefined && {
        completed_at: operation.completed_at,
      }),
      ...(operation.result && { result: operation.result }),
      ...(operation.auto_reload_operation_ids && {
        auto_reload_operation_ids: operation.auto_reload_operation_ids,
      }),
      debits: debits.map(
        ({
          sequence,
          outcome,
          previous_balance_points,
          new_balance_points,
          created_at,
          result,
        }) => ({
          sequence,
          outcome,
          previous_balance_points,
          new_balance_points,
          created_at,
          result,
        }),
      ),
    };
  },
});
