import { v } from "convex/values";

export const walletResultFields = {
  success: v.boolean(),
  newBalanceDollars: v.number(),
  insufficientFunds: v.boolean(),
  monthlyCapExceeded: v.boolean(),
  memberCapExceeded: v.optional(v.boolean()),
  memberDisabled: v.optional(v.boolean()),
  poolDisabled: v.optional(v.boolean()),
};
export const walletDebitResult = v.object({
  ...walletResultFields,
  newBalancePoints: v.number(),
});
export const walletActionResult = v.object({
  ...walletResultFields,
  autoReloadTriggered: v.boolean(),
  autoReloadResult: v.optional(
    v.object({
      success: v.boolean(),
      chargedAmountDollars: v.optional(v.number()),
      reason: v.optional(v.string()),
    }),
  ),
});
export const settlementIdentityFields = {
  operation_id: v.string(),
  user_id: v.string(),
  organization_id: v.optional(v.string()),
  usage_settlement_id: v.optional(v.string()),
  amount_points: v.number(),
};
