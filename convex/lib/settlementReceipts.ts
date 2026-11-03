import type { Infer } from "convex/values";
import type { MutationCtx } from "./serviceFunctions";
import {
  walletDebitResult,
  settlementIdentityFields,
} from "./settlementReceiptValidators";
import { v } from "convex/values";

const identityValidator = v.object(settlementIdentityFields);
export type SettlementIdentity = Infer<typeof identityValidator>;
export type WalletDebitResult = Infer<typeof walletDebitResult>;

export function validateSettlementIdentity(identity: SettlementIdentity) {
  if (
    !identity.operation_id ||
    identity.operation_id.length > 200 ||
    !Number.isSafeInteger(identity.amount_points) ||
    identity.amount_points <= 0
  ) {
    throw new Error("Invalid settlement operation");
  }
}

// The explicit fields are the immutable input fingerprint; never hash credentials.
export function assertSettlementIdentity(
  stored: SettlementIdentity,
  requested: SettlementIdentity,
) {
  if (
    stored.operation_id !== requested.operation_id ||
    stored.user_id !== requested.user_id ||
    stored.organization_id !== requested.organization_id ||
    stored.usage_settlement_id !== requested.usage_settlement_id ||
    stored.amount_points !== requested.amount_points
  ) {
    throw new Error("Settlement operation input mismatch");
  }
}

/** Insert a receipt in the SAME Convex transaction as the debit and cap counters. */
export async function recordWalletDebit<T extends WalletDebitResult>(
  ctx: MutationCtx,
  identity: SettlementIdentity | undefined,
  sequence: number | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  // Older callers have no operation identity. Never manufacture receipts for them.
  if (!identity) {
    if (sequence !== undefined)
      throw new Error("Missing settlement operation identity");
    return execute();
  }
  validateSettlementIdentity(identity);
  if (!Number.isSafeInteger(sequence) || sequence! < 0 || sequence! > 4)
    throw new Error("Invalid settlement debit sequence");
  const operation = await ctx.db
    .query("usage_settlement_operations")
    .withIndex("by_operation_id", (q) =>
      q.eq("operation_id", identity.operation_id),
    )
    .unique();
  if (!operation) throw new Error("Settlement operation is missing");
  assertSettlementIdentity(operation, identity);
  const debits = await ctx.db
    .query("usage_settlement_debits")
    .withIndex("by_operation_id_and_sequence", (q) =>
      q.eq("operation_id", identity.operation_id),
    )
    .take(6);
  // Once any attempt applied, no other attempt for this operation may debit.
  const prior =
    debits.find((d) => d.sequence === sequence) ??
    debits.find((d) => d.outcome === "applied");
  if (prior) return prior.result as T;
  if (operation.status !== "pending")
    throw new Error("Settlement operation already completed");
  const getBalance = async () =>
    identity.organization_id !== undefined
      ? ((
          await ctx.db
            .query("team_extra_usage")
            .withIndex("by_org", (q) =>
              q.eq("organization_id", identity.organization_id!),
            )
            .first()
        )?.balance_points ?? null)
      : ((
          await ctx.db
            .query("extra_usage")
            .withIndex("by_user_id", (q) => q.eq("user_id", identity.user_id))
            .first()
        )?.balance_points ?? null);
  const previousBalance = await getBalance();
  const result = await execute();
  const newBalance = await getBalance();
  // Throwing aborts BOTH the debit and receipt if the contract ever drifts.
  if (
    result.success
      ? previousBalance === null ||
        newBalance === null ||
        previousBalance - newBalance !== identity.amount_points
      : previousBalance !== newBalance
  )
    throw new Error("Settlement balance delta mismatch");
  await ctx.db.insert("usage_settlement_debits", {
    ...identity,
    sequence: sequence!,
    outcome: result.success ? "applied" : "not_applied",
    previous_balance_points: previousBalance,
    new_balance_points: newBalance,
    result,
    created_at: Date.now(),
  });
  return result;
}
