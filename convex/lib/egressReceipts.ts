import type { Infer } from "convex/values";
import type { MutationCtx } from "./serviceFunctions";
import { egressReviewReceiptFields } from "./abuseValidators";
import { v } from "convex/values";

const receiptValidator = v.object(egressReviewReceiptFields);
export type ReceiptFields = Omit<
  Infer<typeof receiptValidator>,
  "createdAt" | "expiresAt"
>;

export function isCorroboratedLegitimateReceipt(receipt: ReceiptFields) {
  return (
    receipt.decision === "keep_active" &&
    receipt.evidenceMode === "exact_run" &&
    receipt.coverage === "complete" &&
    receipt.reason === "legitimate_corroborated" &&
    receipt.reviewReason === "legitimate_corroborated"
  );
}

/** Aggregate monitoring only; long enough for weekly owner summaries. */
export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;
const PURGE_BATCH = 20;

/**
 * One receipt per window. A committed case supersedes a prior no-case
 * decision. Once a case exists, later attempts preserve its receipt.
 */
export async function insertReceipt(
  ctx: MutationCtx,
  fields: ReceiptFields,
  now = Date.now(),
): Promise<{ outcome: "created" | "existing"; confirmedLegitimate?: true }> {
  const expired = await ctx.db
    .query("egress_review_receipts")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
    .take(PURGE_BATCH);
  for (const row of expired) await ctx.db.delete(row._id);
  const existing = await ctx.db
    .query("egress_review_receipts")
    .withIndex("by_digest", (q) => q.eq("digest", fields.digest))
    .first();
  if (
    fields.caseOutcome === "existing" ||
    (existing &&
      (existing.caseOutcome !== "none" || fields.caseOutcome !== "created"))
  )
    return {
      outcome: "existing",
      ...(existing &&
        existing.expiresAt > now &&
        existing.caseOutcome === "none" &&
        isCorroboratedLegitimateReceipt(existing) && {
          confirmedLegitimate: true,
        }),
    };
  const next = {
    ...fields,
    createdAt: now,
    expiresAt: now + RECEIPT_TTL_MS,
  };
  if (existing) {
    await ctx.db.replace(existing._id, next);
  } else {
    await ctx.db.insert("egress_review_receipts", next);
  }
  return {
    outcome: "created",
    ...(fields.caseOutcome === "none" &&
      isCorroboratedLegitimateReceipt(fields) && { confirmedLegitimate: true }),
  };
}
