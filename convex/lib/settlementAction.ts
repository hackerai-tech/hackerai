import type { Infer } from "convex/values";
import type { ActionCtx } from "./serviceFunctions";
import { internal } from "../_generated/api";
import { validateServiceKey } from "./utils";
import { walletActionResult } from "./settlementReceiptValidators";
import type { SettlementIdentity } from "./settlementReceipts";

type Args = {
  serviceKey: string;
  userId: string;
  organizationId?: string;
  amountPoints: number;
  usageSettlementId?: string;
  settlementOperationId?: string;
};

export async function runWalletSettlement<
  T extends Infer<typeof walletActionResult>,
>(ctx: ActionCtx, args: Args, execute: () => Promise<T>): Promise<T> {
  validateServiceKey(args.serviceKey);
  if (!args.settlementOperationId) return execute();
  const identity: SettlementIdentity = {
    operation_id: args.settlementOperationId,
    user_id: args.userId,
    ...(args.organizationId && { organization_id: args.organizationId }),
    ...(args.usageSettlementId && {
      usage_settlement_id: args.usageSettlementId,
    }),
    amount_points: args.amountPoints,
  };
  const claim = await ctx.runMutation(
    internal.settlementReceipts.begin,
    identity,
  );
  if (!claim.claimed) {
    if (claim.result) return claim.result as T;
    throw new Error("Settlement outcome unknown; reconciliation required");
  }
  const result = await execute();
  await ctx.runMutation(internal.settlementReceipts.finish, {
    ...identity,
    result,
  });
  return result;
}

/** A failed link stops before Stripe; its existing reload fence stays intact. */
export async function linkWalletReload(
  ctx: ActionCtx,
  args: Args,
  reloadId: string,
) {
  if (!args.settlementOperationId) return;
  await ctx.runMutation(internal.settlementReceipts.linkAutoReload, {
    operation_id: args.settlementOperationId,
    user_id: args.userId,
    ...(args.organizationId && { organization_id: args.organizationId }),
    ...(args.usageSettlementId && {
      usage_settlement_id: args.usageSettlementId,
    }),
    amount_points: args.amountPoints,
    auto_reload_operation_id: reloadId,
  });
}
